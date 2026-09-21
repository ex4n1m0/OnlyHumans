// E2E host counterpart to e2e-node.ts: a Node peer that FOUNDS a room and
// keeps it open, seating every guest and echoing their chat back sealed.
// Lets the browser tab be tested on the SEEKER path (the phone scenario).
// Usage: node .e2e-host.mjs <word>
import {
  Hub, RoomCrypto, buildJoin, effectiveGk, globalRoomHex, sealRoomKey,
  openRoomKey, verifyMailItem, admissionProof, peerIdFromPublic, publicKeyProtobuf,
  b64, unb64, unhex, utf8, fromUtf8, type Envelope, type Sealed,
} from "./portal.js";
import { ed25519 } from "@noble/curves/ed25519.js";

const BASE = "https://onlyhumans.deepflux.space";
const word = process.argv[2]!;
const KIND = {
  chat: utf8("chat\0\0\0\0"),
  members: utf8("members\0"),
};

const seed = crypto.getRandomValues(new Uint8Array(32));
const pub = ed25519.getPublicKey(seed);
const peerId = peerIdFromPublic(pub);
const pubB64 = b64(publicKeyProtobuf(pub));
const sign = (m: Uint8Array) => ed25519.sign(m, seed);
const hub = new Hub(BASE);

const gk = unb64((await (await fetch(`${BASE}/api/gk`, { cache: "no-store" })).json()).gk_b64);
const egk = await effectiveGk(gk, word);
const roomHex = globalRoomHex(egk);

await hub.reg(peerId, pubB64, sign);
const won = await hub.registerRoom(roomHex, peerId, pubB64, sign);
if (!won) { console.log("ROOM TAKEN — a live host already holds this word"); process.exit(2); }

const room = new RoomCrypto(unhex(roomHex), 1, crypto.getRandomValues(new Uint8Array(32)));
const members = new Map<string, string>([[peerId, "nodehost"]]);
let mySeq = Date.now();
const seen = new Map<string, number>();
let refreshAt = Date.now();
let echoCount = 0;

console.log(`HOSTING ${word} as ${peerId.slice(0, 16)}… — waiting for guests`);

const sealMembers = (): Sealed => {
  mySeq++;
  return room.seal(peerId, mySeq, KIND.members,
    utf8(JSON.stringify({ members: [...members.entries()].map(([peer, name]) => ({ peer, name })) })));
};

for (;;) {
  await new Promise((r) => setTimeout(r, 3000));
  try {
    for (const it of await hub.mailDrain(peerId, sign)) {
      const from = verifyMailItem(it);
      const env = JSON.parse(it.env_json) as Envelope;
      if ("Join" in env) {
        const j = env.Join;
        const expect = admissionProof(egk, j.guest_id, unb64(j.guest_nonce_b64));
        let diff = 0;
        const got = unb64(j.guest_proof_b64);
        if (expect.length === got.length) {
          for (let i = 0; i < expect.length; i++) diff |= expect[i] ^ got[i];
        } else diff = 1;
        if (diff) { console.log(`join from ${from.slice(0, 8)}… FAILED proof`); continue; }
        const isNew = !members.has(from);
        members.set(from, j.name || from.slice(0, 10));
        console.log(`GUEST SEATED: ${j.name} (${from.slice(0, 12)}…)${isNew ? "" : " (re-seat)"}`);
        const kd: Envelope = {
          KeyDelivery: {
            room_id_hex: roomHex,
            epoch: room.epoch,
            key_ct_b64: b64(sealRoomKey(egk, room.roomId, room.epoch, from, room.key)),
            members: [...members.entries()].map(([peer, name]) => ({ peer, name })),
          },
        };
        const batch: Array<{ to: string; env: Envelope }> = [{ to: from, env: kd }];
        const mf = sealMembers();
        for (const p of members.keys()) if (p !== peerId) batch.push({ to: p, env: { Members: { frame: mf } } });
        await hub.mailPushBatch(peerId, pubB64, sign, batch);
      } else if ("Chat" in env) {
        const body = fromUtf8(room.open(env.Chat.frame, KIND.chat));
        const sender = env.Chat.frame.sender;
        const seq = env.Chat.frame.seq;
        if (seq <= (seen.get(sender) ?? 0)) continue;
        seen.set(sender, seq);
        console.log(`CHAT from ${members.get(sender) ?? sender.slice(0, 8)}…: ${body}`);
        mySeq++;
        const frame = room.seal(peerId, mySeq, KIND.chat, utf8(`host heard: ${body}`));
        echoCount++;
        await hub.mailPushBatch(peerId, pubB64, sign,
          [...members.keys()].filter((p) => p !== peerId).map((to) => ({ to, env: { Chat: { frame } } as never })));
        console.log(`ECHO #${echoCount} sealed and sent`);
      }
    }
    if (Date.now() - refreshAt > 45_000) {
      refreshAt = Date.now();
      await hub.registerRoom(roomHex, peerId, pubB64, sign); // extend the record
    }
  } catch (e) {
    console.log("cycle error:", String(e));
  }
}
