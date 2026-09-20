// GET /api/room/:roomId — fetch the current host record of a room.
// Returns 404 when no live record exists (nobody hosts / TTL expired).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { rateLimitOk } from "../_rl";

declare const process: { env: Record<string, string | undefined> };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const { roomId } = req.query;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token || typeof roomId !== "string" || !/^[0-9a-f]{32}$/.test(roomId)) {
    res.status(400).json({ error: "bad request" });
    return;
  }
  if (!(await rateLimitOk(req, res, "roomget", 240, 60))) return;
  try {
    const r = await fetch(
      `${url.replace(/\/$/, "")}/get/${encodeURIComponent(`room:${roomId}`)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!r.ok) throw new Error(`upstash get ${r.status}`);
    const j: any = await r.json();
    if (typeof j.result !== "string") {
      res.status(404).json({ error: "no host record" });
      return;
    }
    res.status(200).json(JSON.parse(j.result));
  } catch (e: any) {
    res.status(500).json({ error: "redis failed", detail: String(e?.message ?? e) });
  }
}
