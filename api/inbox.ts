// PUT/POST /api/inbox — store sealed envelopes for a peer that is
// currently unreachable directly. The hub is untrusted storage: every
// item is an opaque, end-to-end sealed Envelope JSON plus the sender's
// signature, which this endpoint verifies before storing (recipients
// verify again — and check the key derives the claimed peer id — so the
// hub can never forge or tamper). Items expire with the whole inbox
// after 24h; each inbox keeps its last 32 items.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ed25519Verify, libp2pEd25519Key, b64decode, mailCanonical } from "./_mail-crypto";

declare const process: { env: Record<string, string | undefined> };

function redisEnv(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

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

async function redisSetNx(key: string, ex: number): Promise<boolean> {
  const { url, token } = redisEnv()!;
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}/1?EX=${ex}&NX`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`upstash set ${r.status}`);
  const j: any = await r.json();
  return j.result === "OK";
}

interface Item {
  to: string;
  from: string;
  public_key_b64: string;
  env_json: string;
  ts_ms: number;
  sig_b64: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "PUT" && req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const env = redisEnv();
  if (!env) {
    res.status(503).json({ error: "hub storage not configured" });
    return;
  }
  const items: Item[] = req.body?.items ?? [];
  if (!Array.isArray(items) || items.length === 0 || items.length > 16) {
    res.status(400).json({ error: "items must be 1..16" });
    return;
  }
  for (const it of items) {
    if (
      typeof it?.to !== "string" || it.to.length < 8 || it.to.length > 128 ||
      typeof it?.from !== "string" || it.from.length < 8 || it.from.length > 128 ||
      typeof it?.public_key_b64 !== "string" || it.public_key_b64.length > 256 ||
      typeof it?.env_json !== "string" || it.env_json.length > 65536 ||
      typeof it?.ts_ms !== "number" ||
      typeof it?.sig_b64 !== "string" || it.sig_b64.length > 128
    ) {
      res.status(400).json({ error: "bad item shape" });
      return;
    }
  }
  const now = Date.now();
  if (items.some((it) => Math.abs(now - it.ts_ms) > 25 * 3600_000)) {
    res.status(400).json({ error: "stale item" });
    return;
  }
  // Verify every signature against the sender's included libp2p key.
  for (const it of items) {
    let ok = false;
    try {
      const pubRaw = libp2pEd25519Key(b64decode(it.public_key_b64));
      const sig = b64decode(it.sig_b64);
      if (pubRaw && sig.length === 64) {
        ok = ed25519Verify(sig, mailCanonical(it.from, it.to, it.ts_ms, it.env_json), pubRaw);
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      res.status(403).json({ error: "signature verification failed" });
      return;
    }
  }
  try {
    // Throttle per sender; the app retries on the next tick when refused.
    const allowed = await redisSetNx(`rl:mail:${items[0].from}`, 4);
    if (!allowed) {
      res.status(429).json({ error: "rate limited" });
      return;
    }
    const pipe: unknown[][] = [];
    for (const it of items) {
      pipe.push(["rpush", `inbox:${it.to}`, JSON.stringify(it)]);
    }
    const boxes = [...new Set(items.map((it) => it.to))];
    for (const to of boxes) {
      pipe.push(["expire", `inbox:${to}`, "86400"]);
      pipe.push(["ltrim", `inbox:${to}`, "-32", "-1"]);
    }
    await redisPipe(pipe);
    res.status(200).json({ ok: true, stored: items.length });
  } catch (e: any) {
    res.status(500).json({ error: "redis failed", detail: String(e?.message ?? e) });
  }
}
