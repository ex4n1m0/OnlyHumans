// GET /api/lookup/:peerId — fetch a peer's latest signed registration.
// Clients re-verify the signature locally; the hub is untrusted storage.
// Node-style handler (Vercel default runtime) — deliberately no SDK and
// no web-standard Request/Response.
import type { VercelRequest, VercelResponse } from "@vercel/node";

declare const process: { env: Record<string, string | undefined> };

function redisEnv(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const peerId = req.query?.peerId;
  if (typeof peerId !== "string" || !peerId || peerId.length > 128) {
    res.status(400).json({ error: "bad peer id" });
    return;
  }
  const env = redisEnv();
  if (!env) {
    res.status(503).json({ error: "hub storage not configured" });
    return;
  }
  let raw: string | null = null;
  try {
    const r = await fetch(`${env.url}/get/${encodeURIComponent(`peer:${peerId}`)}`, {
      headers: { Authorization: `Bearer ${env.token}` },
    });
    if (!r.ok) throw new Error(`upstash ${r.status}`);
    const j: any = await r.json();
    raw = j.result;
  } catch (e: any) {
    res.status(500).json({ error: "redis failed", detail: String(e?.message ?? e) });
    return;
  }
  if (!raw) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.setHeader("cache-control", "no-store");
  res.status(200).json(JSON.parse(raw));
}
