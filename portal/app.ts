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

  /// The universe key is fetched once per tab from /api/gk (a function
  /// backed by a Vercel env var, so no key file ever lives in the repo),
  /// kicked off at page load so the round-trip hides behind the user's
  /// typing; join() awaits the same promise instead of a fresh fetch.
  gkPromise: Promise<void> | null = null;

  fetchGk(): Promise<void> {
    this.gkPromise = (async () => {
      const gkRes = await fetch("/api/gk", { cache: "no-cache" });
      if (!gkRes.ok) throw new Error("portal not enabled for this app version yet");
      const gkJ = await gkRes.json();
      this.gk = unb64(gkJ.gk_b64);
    })();
    return this.gkPromise;
  }

  /// Argon2id stretches are memoized per word: re-joining the same word
  /// and the idle warm-up for the pre-filled "earth" reuse the burn.
  stretchCache = new Map<string, Promise<Uint8Array>>();

  stretch(word: string): Promise<Uint8Array> {
    let p = this.stretchCache.get(word);
    if (!p) {
      p = effectiveGk(this.gk, word);
      p.catch(() => this.stretchCache.delete(word));
      this.stretchCache.set(word, p);
    }
    return p;
  }

  /// Everything that needs no user input: identity from localStorage, the
  /// GK fetch, and — idle permitting — the earth stretch. Removes most of
  /// the wait from the common join path.
  prefetch() {
    this.identity();
    void this.fetchGk();
    const warm = () => { if (this.gk) void this.stretch("earth"); };
    if ("requestIdleCallback" in window) requestIdleCallback(warm, { timeout: 4000 });
    else setTimeout(warm, 300);
  }

  async join(name: string, word: string) {
    this.name = name;
    this.word = word;
    this.identity();
    setStatus("fetching the room base…");
    await (this.gkPromise ?? this.fetchGk());
    setStatus("deriving the room from your word…");
    this.egk = await this.stretch(word);
    this.roomHex = globalRoomHex(this.egk);
    setStatus("registering with the site…");
    // Publishing our address and reading the room pointer are independent —
    // ship them as one round-trip instead of two sequential awaits.
    const [, rec] = await Promise.all([
      this.hub.reg(this.peerId, this.pubB64, this.sign),
      this.hub.lookupRoom(this.roomHex),
    ]);
    void this.beat();
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
    // First poll right away — a seat delivery used to wait out the whole
    // first tick — and poll faster while we still hold no room key.
    void this.drain();
    const drainTick = () => {
      void this.drain().catch(() => {}).then(() => setTimeout(drainTick, this.room ? 3500 : 2000));
    };
    setTimeout(drainTick, this.room ? 3500 : 2000);
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
          this.msgs.push({ ts: Date.now(), sender: "", name: "", body: "· the host left — this tab keeps the room open", out: false });
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
      const key = openRoomKey(this.egk, unhex(this.roomHex), kd.epoch, this.peerId, unb64(kd.key_ct_b64));
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
    // Constant-time compare — proof bytes cross the network.
    let diff = 0;
    if (expect.length !== got.length) return; // proof failed
    for (let i = 0; i < expect.length; i++) diff |= expect[i] ^ got[i];
    if (diff !== 0) return; // proof failed
    const isNew = !this.members.has(from);
    this.members.set(from, j.name || from.slice(0, 10));
    if (isNew) this.msgs.push({ ts: Date.now(), sender: "", name: "", body: `· ${j.name || from.slice(0, 10)} joined`, out: false });
    const kd: Envelope = {
      KeyDelivery: {
        room_id_hex: this.roomHex,
        epoch: this.room.epoch,
        key_ct_b64: b64(sealRoomKey(this.egk, this.room.roomId, this.room.epoch, from, this.room.key)),
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
// Mirrors the desktop app's shell (OnlyHumans-app/src/main.ts render()):
// command bar, sidebar with the room card and member list, chat pane
// with hue-labelled borderless bubbles.

const portal = new Portal();
window.__ohPortal = portal;

function setStatus(s: string) { portal.status = s; render(); }

let view = "gate";

/** Stable hue from a peer id — colors avatars and sender labels. */
function peerHue(peer: string): number {
  let h = 0;
  for (let i = 0; i < peer.length; i++) h = (h * 31 + peer.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Round avatar: initials for people, a mesh glyph for the room. */
function avatarHtml(peer: string, label: string): string {
  const hue = peerHue(peer);
  const initials = (label.replace(/\s+/g, "").slice(0, 2) || "?").toUpperCase();
  return `<span class="avatar" style="background:hsl(${hue} 40% 28%);color:hsl(${hue} 70% 75%)">${esc(initials)}</span>`;
}

const MAIN_ROOM_ICON = `<span class="avatar roomavatar">
  <svg viewBox="0 0 24 24" fill="none"><circle cx="6" cy="7" r="2.4" stroke="currentColor" stroke-width="1.6"/><circle cx="18" cy="8.6" r="2.4" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="17.4" r="2.4" stroke="currentColor" stroke-width="1.6"/><path d="M8.1 7.9 15.9 8.3 M7.3 9 10.6 15.3 M17 10.3 13.9 15.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
</span>`;

/** Keep the composer at one line until it genuinely needs more. */
function autosize(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 132) + "px";
}

const isEarth = () => portal.word.trim().toLowerCase() === "earth";
const roomName = () => (isEarth() ? "Earth room" : "Word room");

function statusLine(): string {
  if (portal.room) return "connected";
  return portal.status || "finding the room…";
}

const inviteText = () =>
  `Get OnlyHumans at onlyhumans.deepflux.space — install it, enter any name, then use the room word: ${portal.word}`;

async function copyInvite() {
  const t = inviteText();
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = t; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  }
  toast("Invite copied — paste it to a friend");
}

// Site link: green while presence beats keep arriving (same 6-minute
// staleness rule as the desktop app).
const origBeat = portal.beat.bind(portal);
let siteBeatAt = 0;
portal.beat = async () => { await origBeat(); siteBeatAt = Date.now(); };
const siteLive = () => siteBeatAt > 0 && Date.now() - siteBeatAt < 360_000;
const siteDotHtml = () => {
  const live = siteLive();
  const title = live
    ? `The site's public counter — ${portal.online} online now. No names, just a number.`
    : "The site's counter can't see this tab right now (hub unreachable). Chat keeps working.";
  return `<span class="sitelink ${live ? "on" : ""}" title="${esc(title)}"><span class="sitedot"></span><span class="sl-text">${live ? `${portal.online} online` : "site: offline"}</span></span>`;
};

function ensureToasts(): HTMLElement {
  let box = document.querySelector<HTMLElement>(".toasts");
  if (!box) { box = document.createElement("div"); box.className = "toasts"; document.body.appendChild(box); }
  return box;
}

function toast(text: string) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = text;
  ensureToasts().appendChild(t);
  setTimeout(() => t.remove(), 6000);
}

type MenuItem = { label: string; hint?: string; header?: boolean; act?: () => void };

/** Dropdown menu anchored to a command-bar control. One menu at a time;
 * dismissed by outside click or Escape. */
function openMenu(anchor: HTMLElement, items: MenuItem[]) {
  closeMenus();
  const m = document.createElement("div");
  m.className = "menu";
  m.id = "open-menu";
  for (const it of items) {
    if (it.header) {
      const h = document.createElement("div");
      h.className = "menu-header";
      h.textContent = it.label;
      m.appendChild(h);
      continue;
    }
    const b = document.createElement("button");
    b.className = "menu-item";
    b.innerHTML = `<span class="mi-label">${it.label}</span>${it.hint ? `<span class="mi-hint">${it.hint}</span>` : ""}`;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      closeMenus();
      it.act?.();
    });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8)) + "px";
  m.style.top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - m.offsetHeight - 8)) + "px";
}
function closeMenus() { document.getElementById("open-menu")?.remove(); }

document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenus(); });
document.addEventListener("click", (e) => {
  const m = document.getElementById("open-menu");
  if (m && !m.contains(e.target as Node)) closeMenus();
});

/** One message row — narration lines (empty sender) render centered. */
function msgHtml(m: Msg): string {
  if (!m.sender) return `<div class="narration">${esc(m.body.replace(/^·\s*/, ""))}</div>`;
  const meta = `<div class="meta">${fmt(m.ts)} · <span class="viasite" title="travelled end-to-end sealed through the site's mailbox">⇄ site</span></div>`;
  if (m.out) return `<div class="msg out">${esc(m.body)}${meta}</div>`;
  const hue = peerHue(m.sender);
  return `
    <div class="sender" style="color:hsl(${hue} 65% 70%)">${esc(m.name)}</div>
    <div class="msg in">${esc(m.body)}${meta}</div>`;
}

function render() {
  const root = $("app");
  if (view === "gate") {
    root.innerHTML = `
      <div class="gate">
        <div class="gate-inner">
          <img class="gate-logo" src="/icon-256.png" alt="">
          <h2>Join a room from your browser</h2>
          <p>Same sealed rooms as the desktop app — no install, no account.</p>
          <div class="gaterow">
            <input id="p-name" placeholder="your name…" maxlength="32" autocomplete="off" spellcheck="false">
            <button id="p-join" class="primary" type="button">Enter the room</button>
          </div>
          <div class="gaterow">
            <input id="p-word" placeholder="room word" maxlength="64" autocomplete="off" spellcheck="false">
            <button id="p-dice" class="dice" type="button" title="roll a strong private word">🎲</button>
          </div>
          <div class="gaterow">
            <button id="p-earth" class="earth" type="button" title="join the public room everyone meets in">🌍 Earth — the public room</button>
          </div>
          <p class="gatenote">Every room is a word. <b>Earth</b> is the one
          everyone meets in — the first person online creates it. Type or roll
          your own word and only people who use the same word can find you;
          the word never leaves your device.</p>
          <p class="gatenote">Everything you send travels end-to-end sealed
          through the site's mailbox; delivery between a browser and a PC app
          can take up to a couple of minutes while the app polls its mailbox.
          Your key lives in this browser's storage — messages are kept for
          this tab's session only; the desktop app keeps history.</p>
          <p class="gatehint" id="p-err"></p>
        </div>
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
  // chat view — the desktop app's three-part shell
  // A full re-render fires on every incoming message; keep whatever the
  // user is typing (value + focus) so the composer survives it.
  const prevSend = $("p-send") as HTMLTextAreaElement | null;
  const sendState = prevSend
    ? { value: prevSend.value, focused: document.activeElement === prevSend }
    : null;
  // peerId is unset until portal.join() mints the identity; render runs
  // before that, so fall back to the empty id (hue 0) for the first paint.
  const myId = portal.peerId || "";
  const others = [...portal.members].filter(([p]) => p !== myId);
  const memberCount = portal.members.size || 1;
  root.innerHTML = `
    <header class="cmdbar">
      <img class="brandlogo" src="/icon-256.png" alt="">
      <span class="logo">OnlyHumans</span>
      <span class="roomchip" title="this tab lives in ${isEarth() ? "the Earth room" : "a word room"} — the desktop app keeps history">
        <span class="rs-glyph">${isEarth() ? "⌂" : "◆"}</span>
        <span class="rs-label">${isEarth() ? "Main room" : "Code room"}</span>
      </span>
      ${siteDotHtml()}
      <button id="p-idmenu" class="idmenu" title="your profile" aria-haspopup="menu">
        ${avatarHtml(myId, portal.name || "you")}
        <span class="idname">${esc(portal.name)}</span>
        <span class="caret" aria-hidden="true">▾</span>
      </button>
    </header>
    <main>
      <div class="sidebar">
        <div class="status">${esc(portal.status || statusLine())}</div>
        <div class="side-label">this room</div>
        <div class="roomcard" title="${esc(portal.word)}">
          ${MAIN_ROOM_ICON}
          <div class="rc-body">
            <div class="rc-name">${roomName()}</div>
            <div class="rc-sub">${memberCount} member${memberCount === 1 ? "" : "s"} · ${isEarth() ? "the public word" : "same word"}</div>
          </div>
        </div>
        <div class="side-label">people in the room</div>
        <ul class="member-list">
          <li title="this is you">
            ${avatarHtml(myId, portal.name)}
            <div class="li-body">
              <span class="mname">${esc(portal.name)} (you)</span>
              <span class="li-sub">you</span>
            </div>
          </li>
          ${others.map(([peer, name]) => `
          <li>
            ${avatarHtml(peer, name)}
            <div class="li-body">
              <span class="mname">${esc(name)}</span>
              <span class="li-sub">via site</span>
            </div>
          </li>`).join("")}
        </ul>
      </div>
      ${portal.room ? `
      <div class="chat">
        <div class="titlebar">
          ${MAIN_ROOM_ICON}
          <div class="tb-body">
            <div class="tb-title">${roomName()}</div>
            <div class="tb-sub">${esc(statusLine())} · generation ${portal.room.epoch}</div>
            <div class="pills">
              <span class="pill ${isEarth() ? "" : "amber"}" title="${isEarth() ? "everyone who uses the word earth meets here" : "only people who typed this room's word can be here"}">${isEarth() ? "public word" : "word room"}</span>
              <span class="pill lock" title="messages are sealed on your device — the site never sees them">🔒 e2e</span>
            </div>
          </div>
          <div class="tb-actions">
            <button id="p-invite" class="btn-ghost" title="copy a message a friend can follow to land in this room">＋ Invite</button>
          </div>
        </div>
        <div class="messages" id="p-msgs">
          ${portal.msgs.length === 0 ? `<div class="chat-hint">${isEarth()
            ? (others.length === 0
              ? `You're in Earth — everyone who uses this word joins this room. Say hi, or <button id="p-invite-empty" class="linklike">invite a friend</button>.`
              : "You're in Earth — everyone who uses this word joins this room. Say hi.")
            : (others.length === 0
              ? `Nobody else has used this word yet — they land here the moment they type the same one. <button id="p-invite-empty" class="linklike">Invite someone</button>`
              : "You're in — only people who typed this room's word can be here.")}</div>` : ""}
          ${portal.msgs.map(msgHtml).join("")}
        </div>
        <div class="composer">
          <textarea id="p-send" rows="1" placeholder="message the room… (Enter sends)" title="Enter sends · Shift+Enter adds a newline" autocomplete="off"></textarea>
          <button id="p-sendbtn" class="primary" type="button">Send</button>
        </div>
      </div>` : `
      <div class="empty">
        <div class="join-progress"><span class="spin"></span><span>${esc(portal.status || "finding the room…")}</span></div>
        ${isEarth()
          ? "Nobody is in Earth yet — if no host appears within a minute, this tab creates the room."
          : "Only people with the same word (and the desktop app) can find this room."}
      </div>`}
    </main>`;

  $("p-idmenu")?.addEventListener("click", (e) => {
    e.stopPropagation(); // don't let the outside-click closer eat this menu
    const el = e.currentTarget as HTMLElement;
    if (document.getElementById("open-menu")) { closeMenus(); return; }
    openMenu(el, [
      { label: `${portal.name} · browser portal`, header: true },
      {
        label: "Log off",
        hint: "back to the join screen — your key stays in this browser",
        act: () => {
          localStorage.removeItem("oh-portal-name");
          view = "gate";
          render();
          const n = $("p-name") as HTMLInputElement | null;
          if (n) n.value = portal.name;
        },
      },
      { label: "Enter sends · Shift+Enter newline", header: true },
    ]);
  });
  $("p-invite")?.addEventListener("click", () => void copyInvite());
  $("p-invite-empty")?.addEventListener("click", () => void copyInvite());

  const ta = $("p-send") as HTMLTextAreaElement | null;
  const sendIt = () => {
    const v = ta!.value.replace(/\s+$/, "");
    if (!v.trim()) { ta!.value = ""; autosize(ta!); return; }
    ta!.value = "";
    autosize(ta!);
    void portal.send(v);
  };
  if (ta) {
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendIt(); } });
    ta.addEventListener("input", () => autosize(ta));
    if (sendState) {
      ta.value = sendState.value;
      if (sendState.focused) { ta.focus(); autosize(ta); }
    } else if (!portal.status) {
      ta.focus();
    }
  }
  $("p-sendbtn")?.addEventListener("click", sendIt);
  const box = $("p-msgs");
  if (box) box.scrollTop = box.scrollHeight;
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
  // The chat shell renders before portal.join() runs; seed the fields its
  // first paint reads so the room name and word are right immediately.
  portal.name = name;
  portal.word = word;
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
portal.prefetch();
if (saved) { const n = $("p-name") as HTMLInputElement | null; if (n) n.value = saved; }
