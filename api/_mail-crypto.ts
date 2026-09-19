// Shared Ed25519 verification helpers for the mailbox endpoints (same
// zero-dependency approach as reg.ts: raw key wrapped in a fixed SPKI
// prefix + node:crypto; libp2p PublicKey protobuf minimally decoded).
import { createPublicKey, verify as nodeVerify } from "node:crypto";

export function ed25519Verify(sig: Uint8Array, msg: Uint8Array, rawPub: Uint8Array): boolean {
  const spki = Buffer.alloc(44);
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  prefix.copy(spki, 0);
  Buffer.from(rawPub as unknown as Uint8Array).copy(spki as unknown as Uint8Array, 12);
  try {
    const key = createPublicKey({ key: spki as unknown as Buffer, format: "der", type: "spki" });
    return nodeVerify(null, msg as unknown as Buffer, key, sig as unknown as Buffer);
  } catch {
    return false;
  }
}

// Minimal protobuf decode of a libp2p PublicKey:
// { required Type type = 1 (varint); required bytes data = 2 }
// Ed25519 keys are type 1 with a 32-byte payload.
export function libp2pEd25519Key(buf: Uint8Array): Uint8Array | null {
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

export function b64decode(s: string): Uint8Array {
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

// Canonical bytes an sender signs for one mailbox item.
export function mailCanonical(from: string, to: string, ts: number, envJson: string): Uint8Array {
  return new TextEncoder().encode(`OH1-mail-v1|${from}|${to}|${ts}|${envJson}`);
}

// Canonical bytes a peer signs to prove ownership when draining its inbox.
export function drainCanonical(peer: string, ts: number): Uint8Array {
  return new TextEncoder().encode(`OH1-drain-v1|${peer}|${ts}`);
}
