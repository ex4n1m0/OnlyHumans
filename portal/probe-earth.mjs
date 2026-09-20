// Read-only probe: compute the earth room id exactly like the portal does
// (portal.ts effectiveGk + globalRoomHex) and ask the hub for its host record.
import { argon2id } from "hash-wasm";
import { sha256 } from "@noble/hashes/sha2.js";

const BASE = "https://onlyhumans.deepflux.space";
const word = process.argv[3] ?? "earth";

const gkB64 = (await (await fetch(`${BASE}/api/gk`, { cache: "no-store" })).json()).gk_b64;
const gk = new Uint8Array(Buffer.from(gkB64, "base64url"));

const salt = sha256(new Uint8Array(Buffer.concat([Buffer.from("OH1-pass-v2|"), gk, Buffer.from(word)])));
const egk = new Uint8Array(await argon2id({
  password: Buffer.from(word),
  salt,
  parallelism: 1,
  iterations: 3,
  memorySize: 65536,
  hashLength: 32,
  outputType: "binary",
}));
const roomHex = Buffer.from(sha256(new Uint8Array(Buffer.concat([Buffer.from("OH1-room-v1|"), egk]))))
  .toString("hex").slice(0, 32);

console.log("gk_b64:", gkB64);
console.log("earth roomHex:", roomHex);

const minutes = Number(process.argv[2] ?? 1);
const deadline = Date.now() + minutes * 60_000;
let n = 0;
while (Date.now() < deadline) {
  const r = await fetch(`${BASE}/api/room/${roomHex}`, { cache: "no-store" });
  const body = await r.text();
  let host = "—";
  try { host = JSON.parse(body).host_peer_id?.slice(0, 16) ?? "—"; } catch {}
  console.log(`${new Date().toISOString()} GET /api/room/${roomHex.slice(0, 8)}… -> ${r.status} host=${host}`);
  n++;
  if (Date.now() + 20_000 > deadline) break;
  await new Promise((res) => setTimeout(res, 20_000));
}
console.log(`polled ${n} times`);
