// GET /api/lookup/:peerId — fetch a peer's latest signed registration.
// Clients re-verify the signature locally; the hub is untrusted storage.
import { Redis } from "@upstash/redis";


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
  const raw = await redis.get<string>(`peer:${peerId}`);
  if (!raw) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const record = typeof raw === "string" ? JSON.parse(raw) : raw;
  return Response.json(record, {
    headers: { "cache-control": "no-store" },
  });
}

export const config = { runtime: "edge" };
