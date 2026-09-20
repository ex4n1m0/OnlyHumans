// Browser runtime for the OnlyHumans portal (join.html): a mailbox-only
// room member. See portal.ts for the protocol mirror + KAT provenance.

import {
  Hub, RoomCrypto, buildJoin, effectiveGk, globalRoomHex, genRoomPhrase,
  openRoomKey, sealRoomKey, peerIdFromPublic, publicKeyProtobuf,
  ed25519RawFromProtobuf, verifyMailItem, admissionProof,
  b64, unb64, unhex, hex, utf8, fromUtf8, concat, type Envelope, type MemberInfo, type Sealed,
} from "./portal.js";
import { ed25519 } from "@noble/curves/ed25519.js";

const KIND = {
  chat: utf8("chat\0\0\0\0"),
  rotate: utf8("rotate\0\0"),
  members: utf8("members\0"),
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

interface Msg { ts: number; sender: string; name: string; body: string; out: boolean }

class Portal {
  hub = new Hub("");
  seed!: Uint8Array;
  peerId!: string;
  pubB64!: string;
  name = "";
  word = "";
  gk!: Uint8Array;
  egk!: Uint8Array;
  roomHex!: string;
  room: RoomCrypto | null = null;
  members = new Map<string, string>();
  isHost = false;
  mySeq = Date.now();
  seenSeq = new Map<string, number>();
  msgs: Msg[] = [];
  presenceToken = hex(crypto.getRandomValues(new Uint8Array(16)));
  online = 0;
  status = "starting…";

  get sign() { return (m: Uint8Array) => ed25519.sign(m, this.seed); }

  identity() {
    let seedHex = localStorage.getItem("oh-portal-seed");
    if (!seedHex || seedHex.length !== 64) {
      seedHex = hex(crypto.getRandomValues(new Uint8Array(32)));
      localStorage.setItem("oh-portal-seed", seedHex);
    }
    this.seed = unhex(seedHex);
    this.peerId = peerIdFromPublic(ed25519.getPublicKey(this.seed));
    this.pubB64 = b64(publicKeyProtobuf(ed25519.getPublicKey(this.seed)));
  }

  async join(name: string, word: string) {
    this.name = name;
    this.word = word;
    this.identity();
    setStatus("fetching the room base…");
    const gkRes = await fetch("/gk.json", { cache: "no-cache" });
    if (!gkRes.ok) throw new Error("portal not enabled for this app version yet");
    const gkJ = await gkRes.json();
    this.gk = unb64(gkJ.gk_b64);
    setStatus("deriving the room from your word…");
    this.egk = await effectiveGk(this.gk, word);
    this.roomHex = globalRoomHex(this.egk);
    setStatus("registering with the site…");
    await this.hub.reg(this.peerId, this.pubB64, this.sign);
    void this.beat();
    const rec = await this.hub.lookupRoom(this.roomHex);
    if (rec && rec.host_peer_id !== this.peerId) {
      this.isHost = false;
      setStatus("asking the host for a seat — PC apps check their site mailbox about every two minutes…");
      await this.hub.mailPush(this.peerId, this.pubB64, this.sign, rec.host_peer_id, [buildJoin(this.roomHex, this.peerId, name, this.egk)]);
    } else if (!rec) {
      const won = await this.hub.registerRoom(this.roomHex, this.peerId, this.pubB64, this.sign);
      if (won) {
        this.isHost = true;
        this.room = new RoomCrypto(unhex(this.roomHex), 1, crypto.getRandomValues(new Uint8Array(32)));
        this.members.set(this.peerId, name);
        setStatus("you created this room — the first person with the same word joins through the site");
        this.ready();
      } else {
        const again = await this.hub.lookupRoom(this.roomHex);
        if (again && again.host_peer_id !== this.peerId) {
          this.isHost = false;
          await this.hub.mailPush(this.peerId, this.pubB64, this.sign, again.host_peer_id, [buildJoin(this.roomHex, this.peerId, name, this.egk)]);
          setStatus("asking the host for a seat…");
        }
      }
    }
    this.loop();
  }

  ready() { this.status = ""; render(); }

  async beat() {
    try { this.online = await this.hub.presence(this.presenceToken); } catch { /* offline hub */ }
  }

  loop() {
    setInterval(() => void this.drain(), 3500);
    setInterval(() => {
      void this.hub.reg(this.peerId, this.pubB64, this.sign).catch(() => {});
      void this.beat();
      if (this.isHost) void this.hub.registerRoom(this.roomHex, this.peerId, this.pubB64, this.sign).catch(() => {});
    }, 120_000);
  }

  async drain() {
    let items;
    try { items = await this.hub.mailDrain(this.peerId, this.sign); } catch { return; }
    for (const item of items) {
      let from: string;
      try { from = verifyMailItem(item); } catch { continue; }
      let env: Envelope;
      try { env = JSON.parse(item.env_json); } catch { continue; }
      try { this.handle(from, env); } catch (e) { console.warn("envelope", e); }
    }
    if (items.length) render();
  }

  handle(from: string, env: Envelope) {
    if ("KeyDelivery" in env) {
      const kd = env.KeyDelivery;
      if (kd.room_id_hex !== this.roomHex || this.isHost) return;
      const key = openRoomKey(this.egk, unhex(this.roomHex), this.peerId, unb64(kd.key_ct_b64));
      this.room = new RoomCrypto(unhex(this.roomHex), kd.epoch, key);
      this.members = new Map(kd.members.map((m) => [m.peer, m.name]));
      this.mySeq = Date.now();
      this.status = "";
      return;
    }
    if ("Chat" in env) {
      if (!this.room) return;
      const body = fromUtf8(this.room.open(env.Chat.frame, KIND.chat));
      const sender = env.Chat.frame.sender;
      const seq = env.Chat.frame.seq;
      if (seq <= (this.seenSeq.get(sender) ?? 0)) return; // replay guard
      this.seenSeq.set(sender, seq);
      this.msgs.push({ ts: Date.now(), sender, name: this.members.get(sender) ?? sender.slice(0, 10), body, out: false });
      return;
    }
    if ("Members" in env) {
      if (!this.room) return;
      const body = fromUtf8(this.room.open(env.Members.frame, KIND.members));
      const list = (JSON.parse(body) as { members: MemberInfo[] }).members;
      this.members = new Map(list.map((m) => [m.peer, m.name]));
      return;
    }
    if ("Rotate" in env) {
      if (!this.room || this.isHost) return;
      const body = fromUtf8(this.room.open(env.Rotate.frame, KIND.rotate));
      this.room.applyRotation(JSON.parse(body));
      this.msgs.push({ ts: Date.now(), sender: "", name: "", body: "· key rotated to generation " + this.room.epoch + " — the room is closed to newcomers", out: false });
      return;
    }
    if ("Join" in env) {
      void this.hostHandleJoin(from, env.Join);
      return;
    }
    if ("Leave" in env) {
      if (!this.isHost) return;
      const name = this.members.get(from) ?? from.slice(0, 10);
      this.members.delete(from);
      this.msgs.push({ ts: Date.now(), sender: "", name: "", body: `· ${name} left`, out: false });
      void this.broadcastMembers();
      return;
    }
    if ("Error" in env) {
      setStatus(env.Error.message);
    }
  }

  async hostHandleJoin(from: string, j: Extract<Envelope, { Join: unknown }>["Join"]) {
    if (!this.isHost || !this.room) return;
    if (j.room_id_hex !== this.roomHex || j.guest_id !== from) return;
    const nonce = unb64(j.guest_nonce_b64);
    const expect = admissionProof(this.egk, j.guest_id, nonce);
    const got = unb64(j.guest_proof_b64);
    if (expect.length !== got.length || !expect.every((b, i) => b === got[i])) return; // proof failed
    const isNew = !this.members.has(from);
    this.members.set(from, j.name || from.slice(0, 10));
    if (isNew) this.msgs.push({ ts: Date.now(), sender: "", name: "", body: `· ${j.name || from.slice(0, 10)} joined`, out: false });
    const kd: Envelope = {
      KeyDelivery: {
        room_id_hex: this.roomHex,
        epoch: this.room.epoch,
        key_ct_b64: b64(sealRoomKey(this.egk, this.room.roomId, from, this.room.key)),
        members: [...this.members.entries()].map(([peer, name]) => ({ peer, name })),
      },
    };
    const batch: Array<{ to: string; env: Envelope }> = [{ to: from, env: kd }];
    const membersFrame = this.sealMembersFrame();
    if (membersFrame) {
      for (const p of this.members.keys()) if (p !== this.peerId) batch.push({ to: p, env: { Members: { frame: membersFrame } } });
    }
    await this.hub.mailPushBatch(this.peerId, this.pubB64, this.sign, batch).catch(() => {});
  }

  sealMembersFrame(): Sealed | null {
    if (!this.room) return null;
    this.mySeq++;
    return this.room.seal(this.peerId, this.mySeq, KIND.members,
      utf8(JSON.stringify({ members: [...this.members.entries()].map(([peer, name]) => ({ peer, name })) })));
  }

  async broadcastMembers() {
    if (!this.room || !this.isHost) return;
    const frame = this.sealMembersFrame();
    if (!frame) return;
    await this.fanOut({ Members: { frame } });
  }

  async fanOut(env: Envelope) {
    const batch = [...this.members.keys()].filter((p) => p !== this.peerId)
      .map((to) => ({ to, env }));
    await this.hub.mailPushBatch(this.peerId, this.pubB64, this.sign, batch).catch(() => {});
  }

  async send(text: string) {
    if (!this.room || !text.trim()) return;
    this.mySeq++;
    const frame = this.room.seal(this.peerId, this.mySeq, KIND.chat, utf8(text));
    this.msgs.push({ ts: Date.now(), sender: this.peerId, name: this.name, body: text, out: true });
    render();
    await this.fanOut({ Chat: { frame } });
  }
}

// ------------------------------------------------------------------- UI

const portal = new Portal();
window.__ohPortal = portal;

function setStatus(s: string) { portal.status = s; render(); }

let view = "gate";

function render() {
  const root = $("app");
  if (view === "gate") {
    root.innerHTML = `
      <div class="pgate">
        <img src="/logo.png" alt="" width="96" height="96">
        <h1>Join a room from your browser</h1>
        <p class="sub">Same sealed rooms as the desktop app — no install, no account.
        Everything you send travels end-to-end sealed through the site's mailbox;
        delivery between a browser and a PC app can take up to a couple of minutes
        while the app polls its mailbox.</p>
        <div class="row"><input id="p-name" placeholder="your name…" maxlength="32" autocomplete="off"></div>
        <div class="row">
          <input id="p-word" placeholder="room word" maxlength="64" autocomplete="off">
          <button id="p-dice" title="roll a strong private word" type="button">🎲</button>
        </div>
        <div class="row"><button id="p-earth" type="button">🌍 Earth — the public room</button></div>
        <div class="row"><button id="p-join" class="primary" type="button">Join the room</button></div>
        <p class="err" id="p-err"></p>
        <p class="fine">Your key lives in this browser's storage. Messages are kept
        for this tab's session only — the desktop app keeps history.</p>
      </div>`;
    const word = $("p-word") as HTMLInputElement;
    word.value = "earth";
    $("p-dice")?.addEventListener("click", () => { word.value = genRoomPhrase(); word.focus(); });
    $("p-earth")?.addEventListener("click", () => { word.value = "earth"; });
    $("p-join")?.addEventListener("click", () => void doJoin());
    ($("p-name") as HTMLInputElement).addEventListener("keydown", (e) => { if (e.key === "Enter") void doJoin(); });
    word.addEventListener("keydown", (e) => { if (e.key === "Enter") void doJoin(); });
    return;
  }
  // chat view
  const others = [...portal.members.values()].filter((n) => n !== portal.name).length;
  root.innerHTML = `
    <header>
      <img src="/logo.png" alt="" width="28" height="28">
      <div class="hd">
        <div class="t">${esc(portal.word)} <span class="pill">${portal.isHost ? "hosting" : "member"}</span></div>
        <div class="s">${portal.members.size || 1} in the room · <span class="on">${portal.online} online</span> · 🔒 e2e · ⇄ via site</div>
      </div>
    </header>
    <div class="msgs" id="p-msgs">
      ${portal.status ? `<div class="status">${esc(portal.status)}</div>` : ""}
      ${portal.msgs.map((m) => m.out
        ? `<div class="m out"><div class="b">${esc(m.body)}</div><div class="meta">${fmt(m.ts)} · ⇄ site</div></div>`
        : `<div class="m in">${m.name ? `<div class="who">${esc(m.name)}</div>` : ""}<div class="b">${esc(m.body)}</div><div class="meta">${fmt(m.ts)} · ⇄ site</div></div>`).join("")}
    </div>
    <div class="composer">
      <textarea id="p-send" rows="1" placeholder="message the room… (Enter sends)"></textarea>
      <button id="p-sendbtn" class="primary" type="button">Send</button>
    </div>`;
  const ta = $("p-send") as HTMLTextAreaElement;
  const sendIt = () => { const v = ta.value.trim(); if (!v) return; ta.value = ""; void portal.send(v); };
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendIt(); } });
  $("p-sendbtn")?.addEventListener("click", sendIt);
  const box = $("p-msgs")!;
  box.scrollTop = box.scrollHeight;
  if (!portal.status) ta.focus();
}

function fmt(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function doJoin() {
  const name = ($("p-name") as HTMLInputElement).value.trim();
  const word = ($("p-word") as HTMLInputElement).value.trim() || "earth";
  const err = $("p-err")!;
  if (!name) { err.textContent = "A name is required."; return; }
  err.textContent = "";
  localStorage.setItem("oh-portal-name", name);
  try {
    view = "chat";
    render();
    await portal.join(name, word);
  } catch (e) {
    view = "gate";
    render();
    $("p-err")!.textContent = String(e);
  }
}

const saved = localStorage.getItem("oh-portal-name");
render();
if (saved) { const n = $("p-name") as HTMLInputElement | null; if (n) n.value = saved; }
