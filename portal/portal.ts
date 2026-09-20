// OnlyHumans web portal — a browser member of the PC apps' rooms.
//
// Speaks the same protocol as core/src (Rust), byte for byte:
//   - room word -> effective GK via Argon2id (64 MiB, t=3, p=1) over
//     SHA256("OH1-pass-v2|" | gk | word) salt, mirroring effective_gk()
//   - admission proofs: HKDF-SHA256(GK, salt=[], info="adm"|peer|nonce)
//   - room key delivery: XChaCha20-Poly1305 with HKDF-derived key/nonce
//     bound to (GK, room), AAD = "OH1"|kind|room|epoch|sender|seq
//   - chat frames: per-message subkeys HKDF(room_key, room|epoch,
//     kind|sender|seq), plaintext padded to size buckets
//   - delivery: everything travels through the site's sealed mailbox
//     (the PC apps drain it on their hub tick), so the portal is a
//     mailbox-only peer with no direct addresses.
// Verified against Rust known-answer vectors in kat-test.mjs.

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { argon2id } from "hash-wasm";

// ---------------------------------------------------------------- encoding

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function b64(data: Uint8Array): string {
  let out = "";
  for (let i = 0; i < data.length; i += 3) {
    const b0 = data[i]!, b1 = data[i + 1] ?? 0, b2 = data[i + 2] ?? 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += B64_ALPHABET[(n >> 18) & 63]! + B64_ALPHABET[(n >> 12) & 63]!;
    if (i + 1 < data.length) out += B64_ALPHABET[(n >> 6) & 63]!;
    if (i + 2 < data.length) out += B64_ALPHABET[n & 63]!;
  }
  return out;
}

export function unb64(s: string): Uint8Array {
  const vals = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const idx = B64_ALPHABET.indexOf(s[i]!);
    if (idx < 0) throw new Error("invalid base64 character");
    vals[i] = idx;
  }
  const out = new Uint8Array(Math.floor((s.length * 3) / 4) + 2);
  let o = 0;
  for (let i = 0; i < vals.length; i += 4) {
    const c = vals.subarray(i, i + 4);
    let n = 0;
    for (let k = 0; k < c.length; k++) n |= c[k]! << (18 - 6 * k);
    out[o++] = (n >> 16) & 0xff;
    if (c.length > 2) out[o++] = (n >> 8) & 0xff;
    if (c.length > 3) out[o++] = n & 0xff;
  }
  return out.subarray(0, o);
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export const u64le = (v: number): Uint8Array =>
  new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0].map((_, i) => (v / 2 ** (8 * i)) & 0xff));

export function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
export function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

// ------------------------------------------------------------- libp2p ids

// libp2p Ed25519 PublicKey protobuf: { varint type=1; bytes data(32) }
// PeerId = base58btc(identity multihash of that protobuf).
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function publicKeyProtobuf(pubRaw: Uint8Array): Uint8Array {
  return concat(new Uint8Array([0x08, 0x01, 0x12, 0x20]), pubRaw);
}

// Minimal parse of the libp2p Ed25519 PublicKey protobuf
// { varint type=1; bytes data(32) }: the fixed-shape encoding is
// [0x08,0x01,0x12,0x20] followed by the 32 raw key bytes (36 total).
export function ed25519RawFromProtobuf(protobuf: Uint8Array): Uint8Array {
  if (protobuf.length !== 36 || protobuf[0] !== 0x08 || protobuf[1] !== 0x01 ||
      protobuf[2] !== 0x12 || protobuf[3] !== 0x20) {
    throw new Error("bad libp2p public key protobuf");
  }
  return protobuf.subarray(4);
}

export function peerIdFromPublic(pubRaw: Uint8Array): string {
  const protobuf = publicKeyProtobuf(pubRaw);
  const mh = concat(new Uint8Array([0x00, protobuf.length]), protobuf); // identity multihash
  let n = 0n;
  for (const byte of mh) n = n * 256n + BigInt(byte);
  let out = "";
  while (n > 0n) { out = B58_ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  // leading zero bytes encode as leading '1's
  for (const byte of mh) { if (byte !== 0) break; out = "1" + out; }
  return out;
}

// ----------------------------------------------------------------- crypto

export function normalizeWord(word: string): string {
  return word.trim().toLowerCase();
}

export const ARGON2 = { m_kib: 65536, t: 3, p: 1, len: 32 } as const;

export async function effectiveGk(gk: Uint8Array, word: string | null): Promise<Uint8Array> {
  const w = word == null ? "" : normalizeWord(word);
  if (w === "") return gk;
  const salt = sha256(concat(utf8("OH1-pass-v2|"), gk, utf8(w)));
  return argon2id({
    password: utf8(w),
    salt,
    parallelism: ARGON2.p,
    iterations: ARGON2.t,
    memorySize: ARGON2.m_kib,
    hashLength: ARGON2.len,
    outputType: "binary",
  }) as unknown as Uint8Array;
}

export function globalRoomHex(gk: Uint8Array): string {
  return hex(sha256(concat(utf8("OH1-room-v1|"), gk))).slice(0, 32);
}

const hkdf32 = (ikm: Uint8Array, salt: Uint8Array, info: Uint8Array): Uint8Array =>
  hkdf(sha256, ikm, salt, info, 32);

export function admissionProof(gk: Uint8Array, proverId: string, nonce: Uint8Array): Uint8Array {
  return hkdf32(gk, new Uint8Array(0), concat(utf8("adm"), utf8(proverId), nonce));
}

const KIND = {
  chat: utf8("chat\0\0\0\0"),
  rotate: utf8("rotate\0\0"),
  members: utf8("members\0"),
  clear: utf8("clear\0\0\0"),
  gkDeliv: utf8("gk-deliv"),
} as const;

function aad(kind: Uint8Array, room: Uint8Array, epoch: number, sender: string, seq: number): Uint8Array {
  return concat(utf8("OH1"), kind, room, u64le(epoch), utf8(sender), u64le(seq));
}

export function sealRoomKey(gk: Uint8Array, roomId: Uint8Array, recipient: string, key: Uint8Array): Uint8Array {
  const nonce = hkdf32(gk, roomId, utf8("gk-deliv-nonce")).subarray(0, 24);
  const cipherKey = hkdf32(gk, roomId, utf8("gk-deliv-key"));
  return xchacha20poly1305(cipherKey, nonce, aad(KIND.gkDeliv, roomId, 1, recipient, 0)).encrypt(key);
}

export function openRoomKey(gk: Uint8Array, roomId: Uint8Array, recipient: string, ct: Uint8Array): Uint8Array {
  const nonce = hkdf32(gk, roomId, utf8("gk-deliv-nonce")).subarray(0, 24);
  const cipherKey = hkdf32(gk, roomId, utf8("gk-deliv-key"));
  return xchacha20poly1305(cipherKey, nonce, aad(KIND.gkDeliv, roomId, 1, recipient, 0)).decrypt(ct);
}

// ----------------------------------------------------------- sealed frames

const PAD_BUCKETS = [128, 256, 512, 1024, 2048, 4096, 8192, 16384];

function pad(body: Uint8Array): Uint8Array {
  const real = 4 + body.length;
  const target = PAD_BUCKETS.find((b) => b >= real) ?? Math.ceil(real / 16384) * 16384;
  const out = new Uint8Array(target);
  new DataView(out.buffer).setUint32(0, body.length, true);
  out.set(body, 4);
  return out;
}

function unpad(padded: Uint8Array): Uint8Array {
  const len = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0, true);
  return padded.subarray(4, 4 + len);
}

export interface Sealed {
  room_id_hex: string;
  epoch: number;
  sender: string;
  seq: number;
  nonce_b64: string;
  ct_b64: string;
}

export class RoomCrypto {
  constructor(public roomId: Uint8Array, public epoch: number, public key: Uint8Array) {}

  get roomHex(): string { return hex(this.roomId); }

  private messageKey(sender: string, seq: number, kind: Uint8Array): Uint8Array {
    return hkdf32(this.key, concat(this.roomId, u64le(this.epoch)), concat(kind, utf8(sender), u64le(seq)));
  }

  seal(sender: string, seq: number, kind: Uint8Array, plaintext: Uint8Array): Sealed {
    const mk = this.messageKey(sender, seq, kind);
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const ct = xchacha20poly1305(mk, nonce, aad(kind, this.roomId, this.epoch, sender, seq)).encrypt(pad(plaintext));
    return { room_id_hex: this.roomHex, epoch: this.epoch, sender, seq, nonce_b64: b64(nonce), ct_b64: b64(ct) };
  }

  open(frame: Sealed, kind: Uint8Array): Uint8Array {
    if (frame.room_id_hex !== this.roomHex) throw new Error("frame belongs to a different room");
    if (frame.epoch !== this.epoch) throw new Error(`frame epoch ${frame.epoch} != current ${this.epoch}`);
    const mk = this.messageKey(frame.sender, frame.seq, kind);
    const nonce = unb64(frame.nonce_b64);
    const ct = unb64(frame.ct_b64);
    const padded = xchacha20poly1305(mk, nonce, aad(kind, this.roomId, this.epoch, frame.sender, frame.seq)).decrypt(ct);
    return unpad(padded);
  }

  applyRotation(secret: { next_epoch: number; next_key_b64: string }): void {
    if (secret.next_epoch !== this.epoch + 1) throw new Error("rotation epoch does not follow");
    this.epoch = secret.next_epoch;
    this.key = unb64(secret.next_key_b64);
  }
}

// ------------------------------------------------------------- envelopes

export interface MemberInfo { peer: string; name: string }

export type Envelope =
  | { Join: { room_id_hex: string; guest_id: string; guest_nonce_b64: string; guest_proof_b64: string; name: string } }
  | { KeyDelivery: { room_id_hex: string; epoch: number; key_ct_b64: string; members: MemberInfo[] } }
  | { Members: { frame: Sealed } }
  | { Chat: { frame: Sealed } }
  | { Rotate: { frame: Sealed } }
  | { Leave: { room_id_hex: string } }
  | { Ack: Record<string, never> }
  | { Error: { message: string } };

export function buildJoin(roomHex: string, peerId: string, name: string, gk: Uint8Array): Envelope {
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const proof = admissionProof(gk, peerId, nonce);
  return { Join: { room_id_hex: roomHex, guest_id: peerId, guest_nonce_b64: b64(nonce), guest_proof_b64: b64(proof), name } };
}

// ------------------------------------------------------------ hub client

export interface MailItem { to: string; from: string; public_key_b64: string; env_json: string; ts_ms: number; sig_b64: string }

const mailCanonical = (from: string, to: string, ts: number, envJson: string): Uint8Array =>
  utf8(`OH1-mail-v1|${from}|${to}|${ts}|${envJson}`);
const drainCanonical = (peer: string, ts: number): Uint8Array => utf8(`OH1-drain-v1|${peer}|${ts}`);
const regCanonical = (peer: string, pub: string, addrs: string[], ts: number): Uint8Array =>
  utf8(`OH1-reg|${peer}|${pub}|${addrs.join(",")}|${ts}`);
const roomCanonical = (room: string, host: string, pub: string, ts: number): Uint8Array =>
  utf8(`OH1-room|${room}|${host}|${pub}|${ts}`);

export class Hub {
  constructor(private base: string) {}

  async reg(peerId: string, pubB64: string, sign: (m: Uint8Array) => Uint8Array): Promise<void> {
    const ts = Date.now();
    await fetch(`${this.base}/api/reg`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ peer_id: peerId, public_key_b64: pubB64, addrs: [], ts_ms: ts, sig_b64: b64(sign(regCanonical(peerId, pubB64, [], ts))) }),
    }).then((r) => { if (!r.ok) throw new Error(`reg failed: ${r.status}`); });
  }

  async lookupRoom(roomHex: string): Promise<{ host_peer_id: string } | null> {
    const r = await fetch(`${this.base}/api/room/${roomHex}`, { cache: "no-store" });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`room lookup failed: ${r.status}`);
    return await r.json();
  }

  async registerRoom(roomHex: string, peerId: string, pubB64: string, sign: (m: Uint8Array) => Uint8Array): Promise<boolean> {
    const ts = Date.now();
    const r = await fetch(`${this.base}/api/room`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ room_id: roomHex, host_peer_id: peerId, host_public_key_b64: pubB64, ts_ms: ts, sig_b64: b64(sign(roomCanonical(roomHex, peerId, pubB64, ts))) }),
    });
    if (r.status === 409) return false;
    if (!r.ok) throw new Error(`room register failed: ${r.status}`);
    return true;
  }

  async mailPush(peerId: string, pubB64: string, sign: (m: Uint8Array) => Uint8Array, to: string, envelopes: Envelope[]): Promise<void> {
    await this.mailPushBatch(peerId, pubB64, sign, envelopes.map((env) => ({ to, env })));
  }

  // The hub throttles per SENDER (one push every few seconds) and caps a
  // push at 16 items, so every fan-out ships as chunked single requests
  // carrying all recipients.
  async mailPushBatch(peerId: string, pubB64: string, sign: (m: Uint8Array) => Uint8Array, batch: Array<{ to: string; env: Envelope }>): Promise<void> {
    for (let i = 0; i < batch.length; i += 16) {
      const items: MailItem[] = batch.slice(i, i + 16).map(({ to, env }) => {
        const env_json = JSON.stringify(env);
        const ts = Date.now();
        return { to, from: peerId, public_key_b64: pubB64, env_json, ts_ms: ts, sig_b64: b64(sign(mailCanonical(peerId, to, ts, env_json))) };
      });
      const r = await fetch(`${this.base}/api/inbox`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items }),
      });
      if (!r.ok) throw new Error(`mail push failed: ${r.status}`);
    }
  }

  async mailDrain(peerId: string, sign: (m: Uint8Array) => Uint8Array): Promise<MailItem[]> {
    const ts = Date.now();
    const sig = b64(sign(drainCanonical(peerId, ts)));
    const r = await fetch(`${this.base}/api/inbox/${encodeURIComponent(peerId)}?ts_ms=${ts}&sig_b64=${encodeURIComponent(sig)}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`mail drain failed: ${r.status}`);
    const j = await r.json();
    return (j.items ?? []) as MailItem[];
  }

  async presence(token: string): Promise<number> {
    const r = await fetch(`${this.base}/api/presence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!r.ok) return 0;
    const j = await r.json();
    return j.online ?? 0;
  }
}

export function verifyMailItem(item: MailItem): string {
  const pub = ed25519RawFromProtobuf(unb64(item.public_key_b64));
  if (peerIdFromPublic(pub) !== item.from) throw new Error("mail item: key does not derive sender");
  const sig = unb64(item.sig_b64);
  if (!ed25519.verify(sig, mailCanonical(item.from, item.to, item.ts_ms, item.env_json), pub)) {
    throw new Error("mail item: signature verification failed");
  }
  return item.from;
}

// --------------------------------------------------------------- portal

const GEN_WORDS = [
  "amber", "anchor", "apple", "arrow", "atlas", "aurora", "autumn", "avian",
  "basil", "beacon", "birch", "bishop", "bloom", "brass", "breeze", "bronze",
  "cactus", "canyon", "cedar", "chalk", "cherry", "cinder", "cliff", "clover",
  "cobalt", "comet", "coral", "cotton", "crane", "crater", "creek", "cypress",
  "dahlia", "damask", "dawn", "delta", "denim", "diesel", "doodle", "dragon",
  "dune", "eagle", "ember", "emerald", "eucalyptus", "falcon", "fable", "fennel",
  "fern", "fjord", "flame", "flint", "forest", "fossil", "foxglove", "frost",
  "gadget", "galaxy", "garnet", "ginger", "glacier", "glider", "granite", "grotto",
  "harbor", "hazel", "heron", "hollow", "honey", "horizon", "ignite", "indigo",
  "iris", "island", "ivory", "jasmine", "jasper", "jigsaw", "jungle", "juniper",
  "kayak", "kelp", "kernel", "kestrel", "kitten", "koala", "lagoon", "lantern",
  "lattice", "laurel", "lavender", "ledge", "lemon", "lilac", "linen", "lotus",
  "lumber", "lunar", "lynx", "magnet", "mango", "maple", "marble", "marigold",
  "meadow", "mercury", "midnight", "mimosa", "mineral", "mirage", "mosaic", "moss",
  "mustard", "nebula", "nectar", "needle", "nest", "nickel", "nimbus", "noodle",
  "north", "oasis", "oat", "obsidian", "octave", "olive", "onyx", "opal",
  "orbit", "orchid", "osprey", "otter", "oyster", "paddle", "pancake", "papaya",
  "parsley", "pebble", "pelican", "pepper", "petal", "pewter", "pigeon", "pigment",
  "pine", "pistachio", "pixel", "plasma", "plume", "polar", "pollen", "pomelo",
  "prairie", "prism", "pumpkin", "quartz", "quasar", "quill", "radish", "rainbow",
  "raven", "ribbon", "ridge", "ripple", "river", "robin", "rocket", "rosemary",
  "rustic", "saffron", "sage", "sailor", "salmon", "sandal", "sapphire", "scarf",
  "sequoia", "shadow", "shale", "shrimp", "silver", "siren", "snorkel", "solar",
  "sparrow", "spiral", "spruce", "squid", "starling", "stratus", "sugar", "sulfur",
  "summit", "sunset", "syrup", "tagine", "tangent", "thistle", "thunder", "tiger",
  "tinsel", "topaz", "tulip", "tundra", "turquoise", "umbra", "vanilla", "velvet",
  "vertex", "violet", "vortex", "walnut", "wander", "wasabi", "willow", "winter",
  "wombat", "yarrow", "yonder", "zephyr", "zinnia", "zodiac", "zombie", "zucchini",
];

export function genRoomPhrase(): string {
  const pick = () => GEN_WORDS[Math.floor(Math.random() * GEN_WORDS.length)]!;
  const digits = String(10 + Math.floor(Math.random() * 90));
  return `${pick()}-${pick()}-${pick()}-${pick()}-${pick()}-${digits}`;
}
