// /api/presence — anonymous "someone is online" beacon for the site's
// live counter. Deliberately identity-free: the app sends a random token
// minted per app start (no peer id, no name, no room); the hub stores
// only {token -> expiry} and can answer "how many" but never "who".
//   POST {token}            -> heartbeat, returns {ok, online}
//   POST {token, leave:true} -> remove ourselves (graceful exit)
//   GET                     -> {online}
// Node-style handler + plain fetch to Upstash REST (no SDK), same as reg.
import type { VercelRequest, VercelResponse } from "@vercel/node";

declare const process: { env: Record<string, string | undefined> };

function redisEnv(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

// One round-trip for several commands (Upstash REST pipeline lives at a
// separate /pipeline path — POSTing the array to the base URL 400s).
async function redisPipe(commands: unknown[][]): Promise<any[]> {
  const { url, token } = redisEnv()!;
  const r = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error(`upstash pipe ${r.status}: ${await r.text()}`);
  const j: any = await r.json();
  if (!Array.isArray(j)) throw new Error("upstash pipe: unexpected body");
  return j;
}

const ZSET = "presence";
// Same freshness discipline as every other hub record: entries live 300s,
// apps heartbeat every 120s, so one missed beat doesn't drop a live peer
// and a hard-killed app fades out within 5 minutes.
const TTL = 300;

function pruneAndCount(): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  return redisPipe([
    ["zremrangebyscore", ZSET, "-inf", now],
    ["zcard", ZSET],
  ]).then((res) => Number(res[1]?.result ?? 0));
}

// Live rooms: the room:<id> host pointers room.ts keeps (TTL 300s, the
// hosting app refreshes them). Like the presence counter this answers
// "how many", never "which" — the scan reads the ids but only the count
// leaves the hub. SCAN may revisit a key across pages, so dedupe before
// counting.
async function countLiveRooms(): Promise<number> {
  let cursor = "0";
  const seen = new Set<string>();
  for (;;) {
    const page = await redisPipe([["scan", cursor, "match", "room:*", "count", 1000]])
      .then((res) => res[0]?.result);
    if (!Array.isArray(page) || !Array.isArray(page[1])) {
      throw new Error("upstash scan: unexpected body");
    }
    cursor = String(page[0]);
    for (const k of page[1]) seen.add(String(k));
    if (cursor === "0") return seen.size;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const env = redisEnv();
  if (!env) {
    res.status(503).json({ error: "hub storage not configured" });
    return;
  }
  // The public counter: just numbers, nothing else. The room count is
  // strictly additive — if its scan fails we still answer {online}.
  if (req.method === "GET") {
    try {
      const online = await pruneAndCount();
      let rooms: number | undefined;
      try {
        rooms = await countLiveRooms();
      } catch {
        // fall through without rooms rather than break the human counter
      }
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json(rooms === undefined ? { online } : { online, rooms });
    } catch (e: any) {
      res.status(500).json({ error: "redis failed", detail: String(e?.message ?? e) });
    }
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const { token, leave } = req.body ?? {};
  if (typeof token !== "string" || !/^[0-9a-f]{16,64}$/.test(token)) {
    res.status(400).json({ error: "bad token" });
    return;
  }
  try {
    if (leave === true) {
      await redisPipe([["zrem", ZSET, token]]);
      res.status(200).json({ ok: true });
      return;
    }
    // Mirror reg's one-write-per-30s shape (the app beats every 120s, so
    // this only stops accidental hammering, not the real cadence).
    const rl = await redisPipe([
      ["set", `rl:presence:${token}`, "1", "EX", 30, "NX"],
    ]).then((r) => r[0]?.result);
    if (!rl) {
      res.status(429).json({ error: "rate limited" });
      return;
    }
    const expiresAt = Math.floor(Date.now() / 1000) + TTL;
    await redisPipe([
      ["zadd", ZSET, String(expiresAt), token],
      // The whole set self-destructs if every app disappears.
      ["expire", ZSET, String(TTL * 3)],
    ]);
    const online = await pruneAndCount();
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: true, online });
  } catch (e: any) {
    res.status(500).json({ error: "redis failed", detail: String(e?.message ?? e) });
  }
}
