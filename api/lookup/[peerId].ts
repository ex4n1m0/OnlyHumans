// GET /api/lookup/:peerId — fetch a peer's latest signed registration.
// Clients re-verify the signature locally; the hub is untrusted storage.
import { Redis } from "@upstash/redis";

declare const process: { env: Record<string, string | undefined> };


function hubReady(): boolean {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}
const redis = hubReady() ? Redis.fromEnv() : null;

export default async function handler(
  req: Request,
  ctx: { params: Promise<{ peerId: string }> },
): Promise<Response> {
  if (!redis) {
    return Response.json(
      { error: "hub storage not configured (set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN)" },
      { status: 503 },
    );
  }
  const { peerId } = await ctx.params;
  if (!peerId || peerId.length > 128) {
    return Response.json({ error: "bad peer id" }, { status: 400 });
  }
  let raw: any;
  try {
    raw = await redis.get<string>(`peer:${peerId}`);
  } catch (e: any) {
    return Response.json(
      { error: "redis get failed", detail: String(e && e.message ? e.message : e), stack: String(e && e.stack) },
      { status: 500 },
    );
  }
  if (!raw) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const record = typeof raw === "string" ? JSON.parse(raw) : raw;
  return Response.json(record, {
    headers: { "cache-control": "no-store" },
  });
}

export const config = { runtime: "edge" };
