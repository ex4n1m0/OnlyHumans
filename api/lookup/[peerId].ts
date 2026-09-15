// GET /api/lookup/:peerId — fetch a peer's latest signed registration.
// Clients re-verify the signature locally; the hub is untrusted storage.
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

export default async function handler(
  req: Request,
  ctx: { params: Promise<{ peerId: string }> },
): Promise<Response> {
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
