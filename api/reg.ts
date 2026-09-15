// PUT /api/reg — peers publish their current addresses.
// The hub is untrusted storage: it verifies the Ed25519 signature over the
// canonical payload before storing, and records expire (TTL 300s).
import { Redis } from "@upstash/redis";
import * as ed from "@noble/ed25519";


function hubReady(): boolean {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}
const redis = hubReady() ? Redis.fromEnv() : null;

// Minimal protobuf decode of a libp2p PublicKey:
// message PublicKey { required Type type = 1; required bytes data = 2; }
// Ed25519 keys are type 1 with a 32-byte payload.
function libp2pEd25519Key(buf: Uint8Array): Uint8Array | null {
  let i = 0;
  let type = -1;
  let data: Uint8Array | null = null;
  while (i < buf.length) {
    const key = buf[i++] & 0x1f;
    let len = 0;
    let shift = 0;
    while (true) {
      const b = buf[i++];
      len |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    const val = buf.subarray(i, i + len);
    i += len;
    if (key === 1) type = new DataView(val.buffer, val.byteOffset).getInt32(0);
    else if (key === 2) data = val;
  }
  if (type !== 1 || !data || data.length !== 32) return null;
  return data;
}

function b64decode(s: string): Uint8Array {
  const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const vals: number[] = [];
  for (const c of s) {
    const idx = ALPHA.indexOf(c);
    if (idx < 0) throw new Error("bad b64 char");
    vals.push(idx);
  }
  const out: number[] = [];
  for (let j = 0; j < vals.length; j += 4) {
    const c = vals.slice(j, j + 4);
    let n = 0;
    for (let k = 0; k < c.length; k++) n |= c[k] << (18 - 6 * k);
    out.push((n >> 16) & 0xff);
    if (c.length > 2) out.push((n >> 8) & 0xff);
    if (c.length > 3) out.push(n & 0xff);
  }
  return new Uint8Array(out);
}

function canonical(peerId: string, pubB64: string, addrs: string[], ts: number): Uint8Array {
  const s = `OH1-reg|${peerId}|${pubB64}|${addrs.join(",")}|${ts}`;
  return new TextEncoder().encode(s);
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "PUT" && req.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  if (!redis) {
    return Response.json(
      { error: "hub storage not configured (set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN)" },
      { status: 503 },
    );
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const { peer_id: peerId, public_key_b64: pubB64, addrs, ts_ms: ts, sig_b64: sigB64 } = body ?? {};
  if (
    typeof peerId !== "string" || peerId.length > 128 ||
    typeof pubB64 !== "string" || pubB64.length > 256 ||
    !Array.isArray(addrs) || addrs.length > 16 || addrs.some((a: any) => typeof a !== "string" || a.length > 256) ||
    typeof ts !== "number"
  ) {
    return Response.json({ error: "bad payload" }, { status: 400 });
  }
  // Freshness: registrations older than 60s are rejected.
  const now = Date.now();
  if (Math.abs(now - ts) > 60_000) {
    return Response.json({ error: "stale timestamp" }, { status: 400 });
  }
  // Signature over the canonical payload with the embedded libp2p key.
  let ok = false;
  try {
    const pubRaw = libp2pEd25519Key(b64decode(pubB64));
    const sig = b64decode(sigB64);
    if (pubRaw && sig.length === 64) {
      ok = await ed.verify(sig, canonical(peerId, pubB64, addrs, ts), pubRaw);
    }
  } catch {
    ok = false;
  }
  if (!ok) return Response.json({ error: "signature verification failed" }, { status: 403 });

  // Per-peer write rate limit: one registration per 30s.
  const rl = await redis.set(`rl:${peerId}`, "1", { nx: true, ex: 30 });
  if (!rl) {
    return Response.json({ error: "rate limited" }, { status: 429 });
  }
  const record = { peer_id: peerId, public_key_b64: pubB64, addrs, ts_ms: ts, sig_b64: sigB64 };
  await redis.set(`peer:${peerId}`, JSON.stringify(record), { ex: 300 });
  return Response.json({ ok: true });
}

export const config = { runtime: "edge" };
