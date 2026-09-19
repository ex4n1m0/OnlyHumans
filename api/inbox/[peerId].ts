// GET /api/inbox/<peerId>?ts_ms=&sig_b64= — drain that peer's mailbox.
// Destructive by design (one delivery): returns every queued item and
// clears the inbox. Drain requires proof of ownership: a signature over
// OH1-drain-v1|<peerId>|<ts_ms> verified against the peer's REGISTERED
// public key (the peer:<id> record), so nobody can read or delete
// someone else's mail by guessing an id.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ed25519Verify, libp2pEd25519Key, b64decode, drainCanonical } from "../_mail-crypto";

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const env = redisEnv();
  if (!env) {
    res.status(503).json({ error: "hub storage not configured" });
    return;
  }
  const peerId = Array.isArray(req.query.peerId) ? req.query.peerId[0] : req.query.peerId;
  const ts = Number(req.query.ts_ms);
  const sigB64 = req.query.sig_b64;
  if (
    typeof peerId !== "string" || peerId.length < 8 || peerId.length > 128 ||
    !Number.isFinite(ts) || typeof sigB64 !== "string"
  ) {
    res.status(400).json({ error: "bad request" });
    return;
  }
  if (Math.abs(Date.now() - ts) > 60_000) {
    res.status(400).json({ error: "stale timestamp" });
    return;
  }
  try {
    // Ownership proof against the registered key.
    const { url, token } = env;
    const reg = await fetch(`${url}/get/${encodeURIComponent(`peer:${peerId}`)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const regJ: any = await reg.json();
    const pubB64: string | undefined = regJ?.result ? JSON.parse(regJ.result).public_key_b64 : undefined;
    let ok = false;
    try {
      const pubRaw = pubB64 ? libp2pEd25519Key(b64decode(pubB64)) : null;
      const sig = b64decode(String(sigB64));
      if (pubRaw && sig.length === 64) {
        ok = ed25519Verify(sig, drainCanonical(peerId, ts), pubRaw);
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      res.status(403).json({ error: "drain not authorized" });
      return;
    }
    const out = await redisPipe([
      ["lrange", `inbox:${peerId}`, "0", "-1"],
      ["del", `inbox:${peerId}`],
    ]);
    const raw: string[] = out[0]?.result ?? [];
    const items = raw.map((s) => {
      try { return JSON.parse(s); } catch { return null; }
    }).filter(Boolean);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ items });
  } catch (e: any) {
    res.status(500).json({ error: "redis failed", detail: String(e?.message ?? e) });
  }
}
