// Browser runtime for the OnlyHumans portal (join.html): a mailbox-only
// room member. See portal.ts for the protocol mirror + KAT provenance.

import {
  Hub, RoomCrypto, buildJoin, effectiveGk, globalRoomHex,
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

/// Build id = the content hash in this bundle's own script URL. The
/// shipped file is the single source of truth, so the UI can never show
/// a stale version after `npm run build:portal` mints a new bundle.
const BUILD = (() => {
  const src = (document.currentScript as HTMLScriptElement | null)?.src ?? "";
  return /portal-([A-Za-z0-9]+)\.js/.exec(src)?.[1] ?? "dev";
})();

/// Local-only browser label parsed from the UA — nothing is sent or
/// stored anywhere (the site stays identity-free). Answers "which
/// browser is this?" during support without server-side tracking.
const BROWSER = (() => {
  const ua = navigator.userAgent;
  const m = (re: RegExp) => re.exec(ua)?.[1];
  const ios = /iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const os = ios ? `iOS ${m(/OS (\d+[._]\d+)/)?.replace("_", ".") ?? "?"}`
    : m(/Android (\d+)/) ? `Android ${m(/Android (\d+)/)}`
    : /Windows/.test(ua) ? "Windows"
    : /Macintosh/.test(ua) ? "macOS" : "unknown OS";
  const name = m(/Edg\/(\d+)/) ? `Edge ${m(/Edg\/(\d+)/)}`
    : m(/CriOS\/(\d+)/) ? `Chrome ${m(/CriOS\/(\d+)/)}`
    : m(/FxiOS\/(\d+)/) ? `Firefox ${m(/FxiOS\/(\d+)/)}`
    : m(/Chrome\/(\d+)/) ? `Chrome ${m(/Chrome\/(\d+)/)}`
    : m(/Firefox\/(\d+)/) ? `Firefox ${m(/Firefox\/(\d+)/)}`
    : m(/Version\/(\d+).*Safari/) ? `Safari ${m(/Version\/(\d+)/)}` : "unknown browser";
  return `${name} · ${os}`;
})();

interface Msg { ts: number; sender: string; name: string; body: string; out: boolean }

/** One line of the connection log — every discovery/seating attempt the
 *  tab makes, so two clients that can't see each other are debuggable at
 *  a glance instead of staring at a spinner. */
interface ConnEvent { ts: number; text: string; kind: "try" | "ok" | "warn" }

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
  /// Connection log + attempt bookkeeping, rendered live while we hold
  /// no seat. See ConnEvent.
  events: ConnEvent[] = [];
  seatAttempts = 0;
  lastJoinMailAt = 0;
  lastFoundTry = 0;
  lastRegAt = 0;
  lastBeatAt = 0;
  lastRefreshAt = 0;
  loopStarted = false;
  /// Last hub contact verdict: null = never checked. Drives the site
  /// chip and the "site not answering" log line on transitions.
  siteOk: boolean | null = null;

  logConn(text: string, kind: ConnEvent["kind"] = "try") {
    this.events.push({ ts: Date.now(), text, kind });
    if (this.events.length > 40) this.events.shift();
    render();
  }

  noteSite(ok: boolean) {
    if (this.siteOk === ok) return;
    this.siteOk = ok;
    this.logConn(ok ? "the site answered" : "the site is not answering — retrying", ok ? "ok" : "warn");
  }

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
    // Best-effort first contact. A transient failure here (flaky cellular,
    // a refused request) must not bounce the user back to the gate: the
    // tab stays unseated and the connection loop retries aggressively.
    // Publishing our address and reading the room pointer are independent
    // — ship them as one round-trip instead of two sequential awaits.
    let rec: { host_peer_id: string } | null = null;
    try {
      const [, r] = await Promise.all([
        this.hub.reg(this.peerId, this.pubB64, this.sign).catch(() => {}),
        this.hub.lookupRoom(this.roomHex),
      ]);
      rec = r;
      this.lastRegAt = Date.now();
      this.noteSite(true);
    } catch {
      this.noteSite(false);
      this.logConn("first contact with the site failed — the connection loop takes over", "warn");
    }
    void this.beat();
    try {
      if (rec && rec.host_peer_id === this.peerId) {
        // Our own record survived a page refresh (key was memory-only and
        // is gone): re-claim it and mint a fresh room — members converge
        // back through their own re-discovery.
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
    } catch {
      this.logConn("could not finish joining — retrying in the background", "warn");
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
    this.lastRefreshAt = Date.now();
    this.seatAttempts = 0;
    this.logConn("this tab created the room and is holding it open", "ok");
    this.ready();
  }

  /// Ask `host` for a seat. Remember who we asked: only their KeyDelivery
  /// may seat us (anyone holding the GK could otherwise hand us their own
  /// key and hijack the session).
  seekSeat(host: string) {
    this.isHost = false;
    this.hostId = host;
    this.seatAttempts++;
    this.lastJoinMailAt = Date.now();
    setStatus(`asking host ${host.slice(0, 8)}… for a seat (attempt ${this.seatAttempts}) — their tab must be open`);
    this.logConn(`seat request #${this.seatAttempts} mailed to host ${host.slice(0, 8)}…`);
    void this.hub.mailPush(this.peerId, this.pubB64, this.sign, host, [buildJoin(this.roomHex, this.peerId, this.name, this.egk)])
      .catch(() => this.logConn("the site refused the seat request — retrying", "warn"));
  }

  /// While we hold no room (host died, Join lost to the 32-item inbox cap,
  /// page refreshed): re-run discovery and re-ask until seated. Runs on
  /// the fast connection tick — a phone tab that slept through its host's
  /// reply reconnects in seconds, not at the next 2-minute mark.
  async retryJoin() {
    if (!this.roomHex || !this.egk) return;
    let rec;
    try { rec = await this.hub.lookupRoom(this.roomHex); }
    catch { this.noteSite(false); return; }
    this.noteSite(true);
    try {
      if (!rec) {
        if (Date.now() - this.lastFoundTry < 10_000) return;
        this.lastFoundTry = Date.now();
        this.logConn("no host on the site — claiming the room");
        const won = await this.hub.registerRoom(this.roomHex, this.peerId, this.pubB64, this.sign);
        if (won) this.found();
        return;
      }
      if (rec.host_peer_id === this.peerId) {
        if (Date.now() - this.lastFoundTry < 10_000) return;
        this.lastFoundTry = Date.now();
        await this.hub.registerRoom(this.roomHex, this.peerId, this.pubB64, this.sign);
        this.found();
        return;
      }
      // A new host, or a re-nudge for the same one — the join mail sits
      // in their inbox for 24h, but a fresh one also survives a crowded
      // inbox (only the last 32 items are kept).
      if (rec.host_peer_id !== this.hostId || Date.now() - this.lastJoinMailAt > 15_000) {
        this.seekSeat(rec.host_peer_id);
      }
    } catch { /* retry next cycle */ }
  }

  ready() { this.status = ""; render(); }

  async beat() {
    this.lastBeatAt = Date.now();
    try {
      this.online = await this.hub.presence(this.presenceToken);
      this.siteOk = true;
    } catch {
      this.siteOk = false; // network-level failure (a refused/429 response still means "up")
      this.online = 0;
    }
  }

  loop() {
    // A log-off → re-join cycle would stack a second set of timers and
    // wake listeners on the same tab; the guards inside each pass make
    // that harmless, but one loop is the contract.
    if (this.loopStarted) return;
    this.loopStarted = true;
    // Mail drain: the hot path — incoming keys, chat, member frames.
    void this.drain();
    const drainTick = () => {
      void this.drain().catch(() => {}).then(() => setTimeout(drainTick, this.room ? 3500 : 2000));
    };
    setTimeout(drainTick, this.room ? 3500 : 2000);

    // Connection tick: discovery / seat-seeking / host refresh every 5s
    // (each action is internally throttled to respect the hub's limits).
    const connTick = () => {
      void this.cycle().catch(() => {}).then(() => setTimeout(connTick, 5000));
    };
    setTimeout(connTick, 2000);

    // Phones suspend background tabs mid-tick — timers freeze for minutes.
    // The moment this tab is visible again (or the network returns), run a
    // full cycle NOW instead of waiting out the 5s/45s timers above.
    const wake = () => {
      if (document.visibilityState !== "visible") return;
      void this.drain().catch(() => {});
      void this.cycle().catch(() => {});
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
  }

  /// One connection-maintenance pass. Separate from drain() so wake
  /// events can run it immediately.
  async cycle() {
    if (!this.room) {
      await this.retryJoin();
    } else if (this.isHost) {
      // Room records live 300s on the hub; refresh at 45s so a phone
      // throttling our timers still keeps the room findable, and a
      // dead-host pointer clears fast once we are really gone.
      if (Date.now() - this.lastRefreshAt > 45_000) await this.hostRefresh();
    } else if (Date.now() - this.lastHostContact > 45_000) {
      await this.rediscover();
    }
    // Address registration + presence counter piggyback here. The hub
    // throttles both to one per 30s per peer/token — the 31s guard
    // stays on the good side of that (except the fast beat retry
    // while the site looks down, which the endpoint cheaply refuses).
    if (Date.now() - this.lastRegAt > 31_000) {
      this.lastRegAt = Date.now();
      void this.hub.reg(this.peerId, this.pubB64, this.sign).catch(() => {});
    }
    if (Date.now() - this.lastBeatAt > 31_000 || this.siteOk === false) {
      void this.beat();
    }
  }

  /// Hosts keep the room record alive (the hub lets the current host
  /// refresh). A 409 means a LIVE record names someone else: a member took
  /// over after we looked away, or a fresh room was founded. Yield to the
  /// live record — we stay a member with our key; rediscover() handles
  /// re-seating us on the new host if needed.
  async hostRefresh() {
    this.lastRefreshAt = Date.now();
    try {
      const won = await this.hub.registerRoom(this.roomHex, this.peerId, this.pubB64, this.sign);
      this.noteSite(true);
      if (won) return;
      const rec = await this.hub.lookupRoom(this.roomHex);
      if (rec && rec.host_peer_id !== this.peerId) {
        this.isHost = false;
        this.logConn("another tab holds the room now — switching to a seat", "warn");
        this.msgs.push({ ts: Date.now(), sender: "", name: "", body: "· another live host holds the room", out: false });
      }
    } catch { this.noteSite(false); /* retry next cycle */ }
  }

  /// A member whose host vanished (tab closed, app gone past the record
  /// TTL) would otherwise sit in a dead room forever. Record gone → we take
  /// over hosting with the key we already hold (same room, same epoch).
  /// Record held by someone else (unknown, or our known host has gone quiet
  /// — e.g. we missed a key rotation) → prove GK knowledge and (re)take a
  /// seat; the host's KeyDelivery restores the current key.
  async rediscover() {
    let rec;
    try { rec = await this.hub.lookupRoom(this.roomHex); }
    catch { this.noteSite(false); return; }
    this.noteSite(true);
    if (!rec) {
      try {
        if (Date.now() - this.lastFoundTry < 10_000) return;
        this.lastFoundTry = Date.now();
        const won = await this.hub.registerRoom(this.roomHex, this.peerId, this.pubB64, this.sign);
        if (won) {
          this.isHost = true; // keep our RoomCrypto: same key, same epoch
          this.hostId = this.peerId;
          this.lastRefreshAt = Date.now();
          this.status = "";
          this.logConn("the host left — this tab took over the room", "ok");
          this.msgs.push({ ts: Date.now(), sender: "", name: "", body: "· the host left — this tab keeps the room open", out: false });
        }
      } catch { /* retry next cycle */ }
      return;
    }
    const holder = rec.host_peer_id;
    const healthy = this.members.has(holder) && Date.now() - this.lastHostContact < 300_000;
    if (healthy) return; // host still known and talking to us
    if (Date.now() - this.lastJoinMailAt < 15_000) return; // a request is already in flight
    this.seekSeat(holder);
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
      this.seatAttempts = 0;
      this.status = "";
      this.logConn(`seated by host ${from.slice(0, 8)}… — generation ${kd.epoch}`, "ok");
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
    if (isNew) {
      this.msgs.push({ ts: Date.now(), sender: "", name: "", body: `· ${j.name || from.slice(0, 10)} joined`, out: false });
      this.logConn(`seated ${j.name || from.slice(0, 8)}… — key sent`, "ok");
    }
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

// iOS Safari ignores interactive-widget=resizes-content (a Chromium
// feature): the keyboard overlays the layout viewport and pans the
// fixed-inset shell up until the header is off screen and unreachable.
// The visual viewport reports what is actually visible — size the shell
// to it and follow its offset, so the header stays on screen and the
// composer rides just above the keyboard. On Android (which already
// resizes the layout) and desktop this is a no-op.
const vv = window.visualViewport;
if (vv) {
  const fitApp = () => {
    const el = document.getElementById("app");
    if (!el) return;
    el.style.height = `${vv.height}px`;
    el.style.transform = `translateY(${vv.offsetTop}px)`;
  };
  vv.addEventListener("resize", fitApp);
  vv.addEventListener("scroll", fitApp);
  fitApp();
}

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
  if (portal.room) {
    if (portal.isHost) return "hosting — this tab holds the room open";
    return `seated with host ${portal.hostId.slice(0, 8)}… · generation ${portal.room.epoch}`;
  }
  return portal.status || "finding the room…";
}

/** Newest-last slice of the connection log, shown while we hold no seat. */
function connLogHtml(rows = 4): string {
  const slice = portal.events.slice(-rows);
  if (!slice.length) return `<div class="cl-row"><span class="cl-ts">${fmt(Date.now())}</span>contacting the site…</div>`;
  return slice.map((e) => `<div class="cl-row ${e.kind}"><span class="cl-ts">${fmt(e.ts)}</span>${esc(e.text)}</div>`).join("");
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

// Site link: green only while a presence round-trip actually completed
// (same 6-minute staleness rule as the desktop app). beat() sets siteOk
// on every outcome, so a hung or unreachable hub shows grey.
const origBeat = portal.beat.bind(portal);
let siteBeatAt = 0;
portal.beat = async () => { await origBeat(); if (portal.siteOk) siteBeatAt = Date.now(); };
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
  if (!box) {
    box = document.createElement("div");
    box.className = "toasts";
    // Inside the fitted shell, not the body: a body-fixed toast lands
    // behind the open keyboard on iOS.
    (document.getElementById("app") ?? document.body).appendChild(box);
  }
  return box;
}

function toast(text: string) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = text;
  ensureToasts().appendChild(t);
  setTimeout(() => t.remove(), 6000);
}

type MenuItem = { label: string; hint?: string; header?: boolean; icon?: string; act?: () => void };

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
    b.innerHTML = `${it.icon ? `<span class="mi-icon">${it.icon}</span>` : ""}
      <span class="mi-text"><span class="mi-label">${it.label}</span>${it.hint ? `<span class="mi-hint">${it.hint}</span>` : ""}</span>`;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      closeMenus();
      it.act?.();
    });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  // Anchor rects are in visual coords; the fixed menu lives in layout
  // coords. While the iOS keyboard pans the shell (offsetTop > 0), add
  // the pan and clamp to the visible height, not the full window.
  const pan = window.visualViewport?.offsetTop ?? 0;
  const visH = window.visualViewport?.height ?? window.innerHeight;
  m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8)) + "px";
  m.style.top = Math.max(8 + pan, Math.min(r.bottom + 6 + pan, pan + visH - m.offsetHeight - 8)) + "px";
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
          <h2>Every word is a room</h2>
          <div class="gaterow">
            <input id="p-name" placeholder="your name…" maxlength="32" autocomplete="off" spellcheck="false">
          </div>
          <div class="gaterow">
            <input id="p-word" placeholder="room word" maxlength="64" autocomplete="off" spellcheck="false">
            <button id="p-join" class="primary" type="button">Enter the room</button>
          </div>
          <p class="gatehint" id="p-err"></p>
          <p class="gatebuild">browser portal · build ${BUILD}</p>
        </div>
      </div>`;
    const word = $("p-word") as HTMLInputElement;
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
        <div class="status">${esc(statusLine())}</div>
        ${portal.events.length ? `<div class="side-conn">${esc(portal.events[portal.events.length - 1]!.text)}</div>` : ""}
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
            <div class="tb-sub" title="${esc(statusLine())}">${esc(statusLine())}</div>
            <div class="pills">
              <span class="pill ${isEarth() ? "" : "amber"}" title="${isEarth() ? "everyone who uses the word earth meets here" : "only people who typed this room's word can be here"}">${isEarth() ? "public word" : "word room"}</span>
              <span class="pill lock" title="messages are sealed on your device — the site never sees them">🔒 e2e</span>
              ${portal.room.epoch > 1 ? `<span class="pill">gen ${portal.room.epoch}</span>` : ""}
            </div>
          </div>
          <div class="tb-actions">
            <button id="p-members" class="btn-ghost members-btn" title="people in this room">${memberCount} in room</button>
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
        <div class="connlog">${connLogHtml()}</div>
        <p class="connhint">Keep this tab open — the other side lands here the moment it uses the same word. Phones pause a tab when the screen locks; picking the phone back up reconnects it instantly.</p>
      </div>`}
    </main>`;

  $("p-idmenu")?.addEventListener("click", (e) => {
    e.stopPropagation(); // don't let the outside-click closer eat this menu
    const el = e.currentTarget as HTMLElement;
    if (document.getElementById("open-menu")) { closeMenus(); return; }
    openMenu(el, [
      { label: `${portal.name} · portal build ${BUILD}`, header: true },
      {
        label: "Log off",
        hint: "back to the join screen — your key stays in this browser",
        act: () => {
          view = "gate";
          render();
          const n = $("p-name") as HTMLInputElement | null;
          if (n) n.value = portal.name;
        },
      },
      { label: `${BROWSER} · Enter sends, Shift+Enter newline`, header: true },
    ]);
  });
  $("p-invite")?.addEventListener("click", () => void copyInvite());
  $("p-invite-empty")?.addEventListener("click", () => void copyInvite());

  // Phones fold the sidebar away — this button is the mobile home of the
  // member list (and the room card's word/generation facts).
  $("p-members")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    if (document.getElementById("open-menu")) { closeMenus(); return; }
    openMenu(el, [
      { label: `people in the room · ${roomName()}`, header: true },
      ...[...portal.members].map(([peer, name]): MenuItem => ({
        label: peer === myId ? `${name} (you)` : name,
        hint: peer === myId ? (portal.isHost ? "this device — holding the room open" : "this device") : peer === portal.hostId ? "holding the room open" : "via site",
        icon: avatarHtml(peer, name),
      })),
      { label: `${portal.word} · generation ${portal.room?.epoch ?? 1}`, header: true },
    ]);
  });

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

// The name is never remembered between visits — every load starts with a
// clean gate. removeItem also scrubs what older builds persisted.
localStorage.removeItem("oh-portal-name");
render();
portal.prefetch();
