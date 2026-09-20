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
  /// Peer id of the host we are seated with (or seeking a seat from).
  /// Only this peer's KeyDelivery may install or replace our room key.
  hostId = "";
  /// Last time we successfully opened a frame from the host; a member that
  /// stops hearing from a "live" host re-requests a seat (missed rotation).
  lastHostContact = 0;
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
    if (rec && rec.host_peer_id === this.peerId) {
      // Our own record survived a page refresh (key was memory-only and is
      // gone): re-claim it and mint a fresh room — members converge back
      // through their own re-discovery.
      await this.hub.registerRoom(this.roomHex, this.peerId, this.pubB64, this.sign);
      this.found();
    } else if (rec) {
      this.seekSeat(rec.host_peer_id);
    } else {
      const won = await this.hub.registerRoom(this.roomHex, this.peerId, this.pubB64, this.sign);
      if (won) {
        this.found();
      } else {
        const again = await this.hub.lookupRoom(this.roomHex);
        if (again && again.host_peer_id !== this.peerId) {
          this.seekSeat(again.host_peer_id);
        }
      }
    }
    this.loop();
  }

  /// Mint a fresh room key and host. (Used at founding and when re-claiming
  /// our own stale record after a refresh — the old key died with the tab.)
  found() {
    this.isHost = true;
    this.hostId = this.peerId;
    this.room = new RoomCrypto(unhex(this.roomHex), 1, crypto.getRandomValues(new Uint8Array(32)));
    this.members = new Map([[this.peerId, this.name]]);
    setStatus("you created this room — the first person with the same word joins through the site");
    this.ready();
  }

  /// Ask `host` for a seat. Remember who we asked: only their KeyDelivery
  /// may seat us (anyone holding the GK could otherwise hand us their own
  /// key and hijack the session).
  seekSeat(host: string) {
    this.isHost = false;
    this.hostId = host;
    setStatus("asking the host for a seat — delivery through the site can take up to a minute…");
    void this.hub.mailPush(this.peerId, this.pubB64, this.sign, host, [buildJoin(this.roomHex, this.peerId, this.name, this.egk)])
      .catch(() => {});
  }

  /// While we hold no room (host died, Join lost to the 32-item inbox cap,
  /// page refreshed): re-run discovery and re-ask until seated.
  async retryJoin() {
    let rec;
    try { rec = await this.hub.lookupRoom(this.roomHex); } catch { return; }
    try {
      if (!rec) {
        const won = await this.hub.registerRoom(this.roomHex, this.peerId, this.pubB64, this.sign);
        if (won) this.found();
        return;
      }
      if (rec.host_peer_id === this.peerId) {
        await this.hub.registerRoom(this.roomHex, this.peerId, this.pubB64, this.sign);
        this.found();
        return;
      }
      this.seekSeat(rec.host_peer_id);
    } catch { /* retry next cycle */ }
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
      if (this.isHost) {
        void this.hostRefresh();
      } else if (this.room) {
        void this.rediscover();
      } else {
        void this.retryJoin();
      }
    }, 120_000);
  }

  /// Hosts keep the room record alive (the hub lets the current host
  /// refresh). A 409 means a LIVE record names someone else: a member took
  /// over after we looked away, or a fresh room was founded. Yield to the
  /// live record — we stay a member with our key; rediscover() handles
  /// re-seating us on the new host if needed.
  async hostRefresh() {
    try {
      const won = await this.hub.registerRoom(this.roomHex, this.peerId, this.pubB64, this.sign);
      if (won) return;
      const rec = await this.hub.lookupRoom(this.roomHex);
      if (rec && rec.host_peer_id !== this.peerId) {
        this.isHost = false;
        this.msgs.push({ ts: Date.now(), sender: "", name: "", body: "· another live host holds the room", out: false });
      }
    } catch { /* offline hub: retry next cycle */ }
  }

  /// A member whose host vanished (tab closed, app gone past the record
  /// TTL) would otherwise sit in a dead room forever. Record gone → we take
  /// over hosting with the key we already hold (same room, same epoch).
  /// Record held by someone else (unknown, or our known host has gone quiet
  /// — e.g. we missed a key rotation) → prove GK knowledge and (re)take a
  /// seat; the host's KeyDelivery restores the current key.
  async rediscover() {
    let rec;
    try { rec = await this.hub.lookupRoom(this.roomHex); } catch { return; }
    if (!rec) {
      try {
        const won = await this.hub.registerRoom(this.roomHex, this.peerId, this.pubB64, this.sign);
        if (won) {
          this.isHost = true; // keep our RoomCrypto: same key, same epoch
          this.hostId = this.peerId;
          this.status = "";
          this.msgs.push({ ts: Date.now(), sender: "", name: "", body: "· the host left — you are hosting now", out: false });
        }
      } catch { /* retry next cycle */ }
      return;
    }
    const holder = rec.host_peer_id;
    const healthy = this.members.has(holder) && Date.now() - this.lastHostContact < 300_000;
    if (healthy) return; // host still known and talking to us
    try {
      this.seekSeat(holder);
    } catch { /* retry next cycle */ }
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
      // Only the host we deliberately asked may seat or re-key us: the GK
      // (public for earth) lets anyone SEAL a key, so an unrestricted
      // handler would let a stranger replace our room key and hijack the
      // session. A seated delivery always adopts the host's current
      // key/epoch (missed rotations, takeover forks).
      if (!this.hostId || from !== this.hostId) return;
      if (!Number.isInteger(kd.epoch) || kd.epoch < 1) return;
      if (this.room && kd.epoch < this.room.epoch) return; // no regression
      const key = openRoomKey(this.egk, unhex(this.roomHex), this.peerId, unb64(kd.key_ct_b64));
      this.room = new RoomCrypto(unhex(this.roomHex), kd.epoch, key);
      this.members = new Map(kd.members.map((m) => [m.peer, m.name]));
      this.mySeq = Date.now();
      this.lastHostContact = Date.now();
      this.status = "";
      return;
    }
    if ("Chat" in env) {
      if (!this.room) return;
      if (env.Chat.frame.epoch > this.room.epoch) { void this.resync(); return; }
      const body = fromUtf8(this.room.open(env.Chat.frame, KIND.chat));
      if (from === this.hostId) this.lastHostContact = Date.now();
      const sender = env.Chat.frame.sender;
      const seq = env.Chat.frame.seq;
      if (seq <= (this.seenSeq.get(sender) ?? 0)) return; // replay guard
      this.seenSeq.set(sender, seq);
      this.msgs.push({ ts: Date.now(), sender, name: this.members.get(sender) ?? sender.slice(0, 10), body, out: false });
      return;
    }
    if ("Members" in env) {
      if (!this.room) return;
      if (env.Members.frame.epoch > this.room.epoch) { void this.resync(); return; }
      const body = fromUtf8(this.room.open(env.Members.frame, KIND.members));
      if (from === this.hostId) this.lastHostContact = Date.now();
      const list = (JSON.parse(body) as { members: MemberInfo[] }).members;
      this.members = new Map(list.map((m) => [m.peer, m.name]));
      return;
    }
    if ("Rotate" in env) {
      if (!this.room || this.isHost) return;
      if (from !== this.hostId) return;
      const body = fromUtf8(this.room.open(env.Rotate.frame, KIND.rotate));
      this.room.applyRotation(JSON.parse(body));
      this.lastHostContact = Date.now();
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

  /// We hold an older key than the sender (missed a rotation, or the host
  /// re-keyed via takeover): ask the host for a fresh KeyDelivery.
  resync() {
    if (!this.hostId || this.isHost) return;
    void this.hub.mailPush(this.peerId, this.pubB64, this.sign, this.hostId,
      [buildJoin(this.roomHex, this.peerId, this.name, this.egk)]).catch(() => {});
  }

  async hostHandleJoin(from: string, j: Extract<Envelope, { Join: unknown }>["Join"]) {
    if (!this.isHost || !this.room) return;
    if (j.room_id_hex !== this.roomHex || j.guest_id !== from) return;
    // Mirror the Rust host: the first rotation seals the room — a valid GK
    // proof no longer mints a seat from epoch 2 onward.
    if (this.room.epoch > 1 && !this.members.has(from)) return;
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
