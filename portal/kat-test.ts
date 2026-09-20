// Cross-implementation check: every portal primitive against the Rust
// core's known-answer vectors (core/examples/kat.rs output in kat.json).
//   npx esbuild portal/kat-test.ts --bundle --format=esm --outfile=.kat-test.mjs && node .kat-test.mjs

import { readFileSync } from "node:fs";
import {
  effectiveGk, globalRoomHex, admissionProof, openRoomKey, RoomCrypto,
  peerIdFromPublic, ed25519RawFromProtobuf, unb64, unhex, utf8, fromUtf8,
} from "./portal.js";
import { ed25519 } from "@noble/curves/ed25519.js";

const kat = JSON.parse(readFileSync(new URL("portal/kat.json", import.meta.url), "utf8"));

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) { failures++; console.error(`FAIL ${name} ${detail}`); } else { console.log(`ok   ${name}`); }
};

const gk = unhex(kat.gk_hex);

// 1. Argon2id word derivation (params, salt recipe, folding)
const earth = await effectiveGk(gk, "earth");
check("effectiveGk(earth)", unhex(kat.earth_gk_hex).every((b, i) => b === earth[i]));
const secret = await effectiveGk(gk, "Secret"); // folds to lowercase
check("effectiveGk(Secret->secret)", unhex(kat.secret_gk_hex).every((b, i) => b === secret[i]));

// 2. Room id derivation
check("globalRoomHex", globalRoomHex(earth) === kat.room_hex);

// 3. Admission proof
const proof = admissionProof(earth, kat.peer_id, unhex(kat.proof_nonce_hex));
check("admissionProof", unhex(kat.admission_proof_hex).every((b, i) => b === proof[i]));

// 4. PeerId derivation from the protobuf public key (libp2p-compatible)
const rawPub = ed25519RawFromProtobuf(unb64(kat.public_key_b64));
check("peerIdFromPublic", peerIdFromPublic(rawPub) === kat.peer_id,
  peerIdFromPublic(rawPub));

// 5. GK-sealed room key delivery opens to the room key
const roomKey = openRoomKey(earth, unhex(kat.room_hex), kat.peer_id, unb64(kat.key_ct_b64));
check("openRoomKey", unhex(kat.room_key_hex).every((b, i) => b === roomKey[i]));

// 6. Open a Rust-sealed chat frame
const rc = new RoomCrypto(unhex(kat.room_hex), 1, unhex(kat.room_key_hex));
const opened = fromUtf8(rc.open(kat.sealed, utf8("chat\0\0\0\0")));
check("open Rust-sealed chat frame", opened === kat.chat_plaintext, opened);

// 7. Verify a Rust mailbox signature
check("ed25519.verify Rust mail sig", ed25519.verify(unb64(kat.mail_sig_b64), utf8(kat.mail_msg), rawPub));

// 8. Seal in JS -> open in JS (round trip through the exact seal path)
const sealed = rc.seal(kat.peer_id, Date.now(), utf8("chat\0\0\0\0"), utf8("round trip"));
check("JS seal/open round trip", fromUtf8(rc.open(sealed, utf8("chat\0\0\0\0"))) === "round trip");

if (failures) { console.error(`\n${failures} FAILURES`); process.exit(1); }
console.log("\nall KAT checks passed — portal crypto matches the Rust core");
