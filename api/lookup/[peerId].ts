// GET /api/lookup/:peerId — fetch a peer's latest signed registration.
// Clients re-verify the signature locally; the hub is untrusted storage.
declare const process: { env: Record<string, string | undefined> };

function redisEnv(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

export default async function handler(
  req: Request,
  ctx: { params: Promise<{ peerId: string }> | { peerId: string } },
): Promise<Response> {
  if (!redisEnv()) {
    return Response.json(
      { error: "hub storage not configured (set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN)" },
      { status: 503 },
    );
  }
  const { peerId } = await ctx.params;
  if (!peerId || peerId.length > 128) {
    return Response.json({ error: "bad peer id" }, { status: 400 });
  }
  const { url, token } = redisEnv()!;
  let raw: string | null = null;
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(`peer:${peerId}`)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`upstash ${r.status}: ${await r.text()}`);
    const j: any = await r.json();
    raw = j.result;
  } catch (e: any) {
    return Response.json(
      { error: "redis failed", detail: String(e && e.message ? e.message : e) },
      { status: 500 },
    );
  }
  if (!raw) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const record = JSON.parse(raw);
  return Response.json(record, {
    headers: { "cache-control": "no-store" },
  });
}
