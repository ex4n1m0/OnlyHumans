// PUT /api/reg — peers publish their current addresses.
// The hub is untrusted storage: it verifies the Ed25519 signature over the
// canonical payload before storing, and records expire (TTL 300s).
// Node-style handler + plain fetch to Upstash REST (no SDK).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createPublicKey, verify as nodeVerify } from "node:crypto";

// Ed25519 verify with zero dependencies: wrap the raw 32-byte public key
// in a fixed SPKI prefix and use Node's built-in crypto.
function ed25519Verify(sig: Uint8Array, msg: Uint8Array, rawPub: Uint8Array): boolean {
  const spki = Buffer.alloc(44);
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  prefix.copy(spki, 0);
  Buffer.from(rawPub).copy(spki, 12);
  try {
    const key = createPublicKey({ key: spki, format: "der", type: "spki" });
    return nodeVerify(null, Buffer.from(msg), key, Buffer.from(sig));
  } catch {
    return false;
  }
}

declare const process: { env: Record<string, string | undefined> };

function redisEnv(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

async function redisSet(key: string, value: string, opts: { ex?: number; nx?: boolean }) {
  const { url, token } = redisEnv()!;
  let u = `${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`;
  const q: string[] = [];
  if (opts.ex !== undefined) q.push(`EX=${opts.ex}`);
  if (opts.nx) q.push("NX");
  if (q.length) u += `?${q.join("&")}`;
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`upstash set ${r.status}: ${await r.text()}`);
  const j: any = await r.json();
  return j.result; // "OK" | null (NX refused)
}

// Minimal protobuf decode of a libp2p PublicKey:
// { required Type type = 1 (varint); required bytes data = 2 }
// Ed25519 keys are type 1 with a 32-byte payload.
function libp2pEd25519Key(buf: Uint8Array): Uint8Array | null {
  let i = 0;
  let type = -1;
  let data: Uint8Array | null = null;
  while (i < buf.length) {
    const tag = buf[i++];
    const fieldNum = tag >> 3;
    const wireType = tag & 7;
    if (wireType === 0) {
      // varint value
      let v = 0;
      let sh = 0;
      for (;;) {
        const b = buf[i++];
        v |= (b & 0x7f) << sh;
        sh += 7;
        if (!(b & 0x80)) break;
      }
      if (fieldNum === 1) type = v;
    } else if (wireType === 2) {
      // length-delimited: varint length then payload
      let len = 0;
      let sh = 0;
      for (;;) {
        const b = buf[i++];
        len |= (b & 0x7f) << sh;
        sh += 7;
        if (!(b & 0x80)) break;
      }
      const val = buf.subarray(i, i + len);
      i += len;
      if (fieldNum === 2) data = val;
    } else {
      return null; // unsupported wire type
    }
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
  const { peer_id: peerId, public_key_b64: pubB64, addrs, ts_ms: ts, sig_b64: sigB64 } = req.body ?? {};
  if (
    typeof peerId !== "string" || peerId.length > 128 ||
    typeof pubB64 !== "string" || pubB64.length > 256 ||
    !Array.isArray(addrs) || addrs.length > 16 ||
    addrs.some((a: any) => typeof a !== "string" || a.length > 256) ||
    typeof ts !== "number"
  ) {
    res.status(400).json({ error: "bad payload" });
    return;
  }
  const now = Date.now();
  if (Math.abs(now - ts) > 60_000) {
    res.status(400).json({ error: "stale timestamp" });
    return;
  }
  let ok = false;
  try {
    const pubRaw = libp2pEd25519Key(b64decode(pubB64));
    const sig = b64decode(sigB64);
    if (pubRaw && sig.length === 64) {
      ok = ed25519Verify(sig, canonical(peerId, pubB64, addrs, ts), pubRaw);
    }
  } catch {
    ok = false;
  }
  if (!ok) {
    res.status(403).json({ error: "signature verification failed" });
    return;
  }
  try {
    const rl = await redisSet(`rl:${peerId}`, "1", { ex: 30, nx: true });
    if (!rl) {
      res.status(429).json({ error: "rate limited" });
      return;
    }
    const record = { peer_id: peerId, public_key_b64: pubB64, addrs, ts_ms: ts, sig_b64: sigB64 };
    await redisSet(`peer:${peerId}`, JSON.stringify(record), { ex: 300 });
    res.status(200).json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: "redis failed", detail: String(e?.message ?? e) });
  }
}
