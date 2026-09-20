// Shared per-IP rate limiting over the same Upstash instance. Fail-open
// (redis unreachable → allow): these limits blunt online word-scanning
// and junk registration; they are an abuse cost, not a security boundary.
import type { VercelRequest, VercelResponse } from "@vercel/node";

declare const process: { env: Record<string, string | undefined> };

export async function rateLimitOk(
  req: VercelRequest,
  res: VercelResponse,
  bucket: string,
  limit: number,
  windowSec: number,
): Promise<boolean> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return true;
  const ip = String(req.headers["x-forwarded-for"] ?? "local").split(",")[0]!.trim();
  const key = `rl:${bucket}:${ip}:${Math.floor(Date.now() / 1000 / windowSec)}`;
  try {
    const r = await fetch(`${url.replace(/\/$/, "")}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([["incr", key], ["expire", key, String(windowSec)]]),
    });
    if (!r.ok) return true;
    const j: any = await r.json();
    const n = Number(Array.isArray(j) ? j[0]?.result : NaN);
    if (Number.isFinite(n) && n > limit) {
      res.status(429).json({ error: "rate limited" });
      return false;
    }
  } catch {
    /* fail open */
  }
  return true;
}
