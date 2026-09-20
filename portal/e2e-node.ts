// E2E: a second peer (Node, using the portal module verbatim) joins a
// room hosted by the browser tab, exchanges one sealed message each way
// over the production hub. Usage: node .e2e.mjs <word>
import {
  Hub, RoomCrypto, buildJoin, effectiveGk, globalRoomHex, openRoomKey,
  verifyMailItem, peerIdFromPublic, publicKeyProtobuf, b64, unb64, unhex, utf8, fromUtf8,
} from "./portal.js";
import { ed25519 } from "@noble/curves/ed25519.js";

const BASE = "https://onlyhumans.deepflux.space";
const word = process.argv[2]!;
const CHAT = utf8("chat\0\0\0\0");

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
const rec = await hub.lookupRoom(roomHex);
if (!rec) { console.log("NO-HOST — start the browser tab first"); process.exit(2); }
console.log("host record:", rec.host_peer_id.slice(0, 16) + "…");

await hub.mailPush(peerId, pubB64, sign, rec.host_peer_id, [buildJoin(roomHex, peerId, "nodeguest", egk)]);
console.log("join mailed to host; polling for KeyDelivery…");

let room: RoomCrypto | null = null;
const members = new Map<string, string>();
for (let i = 0; i < 50 && !room; i++) {
  await new Promise((r) => setTimeout(r, 3500));
  for (const it of await hub.mailDrain(peerId, sign)) {
    const env = JSON.parse(it.env_json);
    if ("KeyDelivery" in env) {
      const kd = env.KeyDelivery;
      const key = openRoomKey(egk, unhex(roomHex), kd.epoch, peerId, unb64(kd.key_ct_b64));
      room = new RoomCrypto(unhex(roomHex), kd.epoch, key);
      kd.members.forEach((m) => members.set(m.peer, m.name));
      console.log(`JOINED — ${kd.members.length} member(s): ${[...members.values()].join(", ")}`);
    }
  }
}
if (!room) { console.log("TIMEOUT: no KeyDelivery"); process.exit(3); }

const seq = Date.now();
const frame = room.seal(peerId, seq, CHAT, utf8("hello from the node guest"));
await hub.mailPushBatch(peerId, pubB64, sign,
  [...members.keys()].filter((p) => p !== peerId).map((to) => ({ to, env: { Chat: { frame } } as never })));
console.log("SENT sealed chat to all members; waiting for a reply…");

for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 3500));
  for (const it of await hub.mailDrain(peerId, sign)) {
    verifyMailItem(it); // throws on any forgery
    const env = JSON.parse(it.env_json);
    if ("Chat" in env) {
      console.log("REPLY from browser host:", JSON.stringify(fromUtf8(room.open(env.Chat.frame, CHAT))));
      console.log("E2E-OK");
      process.exit(0);
    }
  }
}
console.log("NO-REPLY"); process.exit(4);
