// PUT /api/room — publish who currently hosts a room.
// First writer wins (NX): that is the "first to join creates the room"
// election. The record's CURRENT host may refresh (plain overwrite of its
// own record) alongside its address registration — hosts retry every
// ~120s while records live 300s, so without the refresh every room's
// pointer would lapse 5 minutes after founding and a joiner in the gap
// would fork the room under a new key. Records still expire (TTL 300s)
// so a dead host's pointer clears.
// Node-style handler + plain fetch to Upstash REST (no SDK).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { peerIdFromLibp2pKey } from "./_mail-crypto";

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

function redisGet(key: string): Promise<string | null> {
  const { url, token } = redisEnv()!;
  return fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: any) => (j && typeof j.result === "string" ? j.result : null));
}

// Minimal protobuf decode of a libp2p PublicKey (Ed25519, type 1, 32 bytes).
function libp2pEd25519Key(buf: Uint8Array): Uint8Array | null {
  let i = 0;
  let type = -1;
  let data: Uint8Array | null = null;
  while (i < buf.length) {
    const tag = buf[i++];
    const fieldNum = tag >> 3;
    const wireType = tag & 7;
    if (wireType === 0) {
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
      return null;
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

function canonical(roomId: string, host: string, pubB64: string, ts: number): Uint8Array {
  const s = `OH1-room|${roomId}|${host}|${pubB64}|${ts}`;
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
  const {
    room_id: roomId,
    host_peer_id: hostPeerId,
    host_public_key_b64: pubB64,
    ts_ms: ts,
    sig_b64: sigB64,
  } = req.body ?? {};
  if (
    typeof roomId !== "string" || !/^[0-9a-f]{32}$/.test(roomId) ||
    typeof hostPeerId !== "string" || hostPeerId.length > 128 ||
    typeof pubB64 !== "string" || pubB64.length > 256 ||
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
  let derivedHost: string | null = null;
  try {
    const pubProto = b64decode(pubB64);
    const pubRaw = libp2pEd25519Key(pubProto);
    const sig = b64decode(sigB64);
    if (pubRaw && sig.length === 64) {
      ok = ed25519Verify(sig, canonical(roomId, hostPeerId, pubB64, ts), pubRaw);
      if (ok) derivedHost = peerIdFromLibp2pKey(pubProto);
    }
  } catch {
    ok = false;
  }
  // The signature only proves control of the included key; without this
  // binding anyone could claim any host_peer_id (e.g. "refresh" a live
  // record they do not own by naming its host and signing with their own
  // key — pinning a dead host's pointer forever and blocking takeover).
  if (!ok || derivedHost !== hostPeerId) {
    res.status(403).json({ error: "signature verification failed (key does not derive host peer id)" });
    return;
  }
  const record = { room_id: roomId, host_peer_id: hostPeerId, host_public_key_b64: pubB64, ts_ms: ts, sig_b64: sigB64 };
  try {
    // First-writer-wins election for a NEW host: NX refuses if a live
    // record exists. The CURRENT host refreshes with a plain SET (extend
    // the TTL) — but only when BOTH the host id and the host key match the
    // live record, so the identity key is the refresh credential. The
    // GET→SET has a milliseconds-wide race if the old record expires
    // underneath a refresh and a new host claims in between — the loser
    // then sees a 409 or yields to the live record exactly as clients
    // already do.
    const existing = await redisGet(`room:${roomId}`);
    let mine = false;
    if (existing !== null) {
      try {
        const cur = JSON.parse(existing) as { host_peer_id?: string; host_public_key_b64?: string };
        mine = cur.host_peer_id === hostPeerId && cur.host_public_key_b64 === pubB64;
      } catch {
        mine = false;
      }
    }
    const won = await redisSet(`room:${roomId}`, JSON.stringify(record), { ex: 300, nx: !mine });
    if (!won) {
      const current = existing ?? (await redisGet(`room:${roomId}`));
      res.status(409).json({ error: "room already hosted", record: current && JSON.parse(current) });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: "redis failed", detail: String(e?.message ?? e) });
  }
}
