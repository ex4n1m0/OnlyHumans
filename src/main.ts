// OnlyHumans UI — one global room. Everyone who runs the app joins the
// same room automatically; the first ever member founded it.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface ChatMessage { id: number; sender: string; body: string; ts: number; outgoing: boolean; epoch: number; pending?: boolean; viaSite?: boolean }
interface Contact { peer_id: string; name: string }
interface MemberInfo { peer: string; name: string }
interface RoomSnapshot { status: string; room: string | null; host: string | null; weAreHost: boolean; epoch: number; members: MemberInfo[]; updatedMs: number }
type NodeEvent =
  | { kind: "listening"; addr: string }
  | { kind: "joinStatus"; status: string }
  | { kind: "roomReady"; room: string; peer: string; weAreHost: boolean; epoch: number }
  | { kind: "message"; room: string; sender: string; body: string; epoch: number; viaSite?: boolean }
  | { kind: "membersChanged"; room: string; members: MemberInfo[] }
  | { kind: "messagesCleared"; room: string }
  | { kind: "rotated"; room: string; newEpoch: number }
  | { kind: "connectionStateChanged"; peer: string; connected: boolean }
  | { kind: "presence"; linked: boolean; online: number }
  | { kind: "log"; message: string };

const app = document.getElementById("app")!;

// render() rewrites only #layout; the toast layer is a sibling so bursts of
// re-renders can never wipe a pending prompt.
const layout = document.createElement("div");
layout.id = "layout";
app.appendChild(layout);

/** Peers we currently have a libp2p connection to. */
const connectedPeers = new Set<string>();

/** Stable hue from a peer id — colors avatars and sender labels. */
function peerHue(peer: string): number {
  let h = 0;
  for (let i = 0; i < peer.length; i++) h = (h * 31 + peer.charCodeAt(i)) >>> 0;
  return h % 360;
}


/** Round avatar: initials for people, a mesh glyph for the main room. */
function avatarHtml(peer: string, label: string): string {
  const hue = peerHue(peer);
  const initials = (label.replace(/\s+/g, "").slice(0, 2) || "?").toUpperCase();
  return `<span class="avatar" style="background:hsl(${hue} 40% 28%);color:hsl(${hue} 70% 75%)">${escapeHtml(initials)}</span>`;
}

const MAIN_ROOM_ICON = `<span class="avatar roomavatar">
  <svg viewBox="0 0 24 24" fill="none"><circle cx="6" cy="7" r="2.4" stroke="currentColor" stroke-width="1.6"/><circle cx="18" cy="8.6" r="2.4" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="17.4" r="2.4" stroke="currentColor" stroke-width="1.6"/><path d="M8.1 7.9 15.9 8.3 M7.3 9 10.6 15.3 M17 10.3 13.9 15.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
</span>`;

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + time;
}

async function main() {
  // First-run gate: the room is only joined once a username exists.
  // After a logoff the profile's room code is prefilled — the gate then
  // re-enters the SAME room under the new name.
  const named: boolean = await invoke("has_username");
  if (!named) {
    renderGate(await invoke<string | null>("passcode"));
    return;
  }
  await boot();
}

function renderGate(prefillCode: string | null = null) {
  layout.innerHTML = `
    <div class="gate">
      <div class="brand" style="justify-content:center">
        <img class="brandlogo" src="/logo.png" alt="" style="width:44px;height:44px;border-radius:10px">
      </div>
      <h2>Welcome to OnlyHumans</h2>
      <p>Pick a name — the room will know you by it.</p>
      <div class="gaterow">
        <input id="name-input" placeholder="your name…" maxlength="32" spellcheck="false" autocomplete="off">
        <button class="primary" id="name-go">Enter the room</button>
      </div>
      <div class="gaterow">
        <input id="code-input" placeholder="room code (optional)" maxlength="64" spellcheck="false" autocomplete="off">
      </div>
      <p class="gatenote">Leave the code empty for the main room everyone lands in.
      Enter a word and you'll meet only people who use the same word —
      same code, same room.</p>
      <p class="gatehint" id="gate-err"></p>
    </div>`;
  const input = document.getElementById("name-input") as HTMLInputElement;
  const codeInput = document.getElementById("code-input") as HTMLInputElement;
  if (prefillCode) codeInput.value = prefillCode;
  input.focus();
  const go = async () => {
    const name = input.value.trim();
    if (!name) {
      document.getElementById("gate-err")!.textContent = "A name is required to continue.";
      return;
    }
    try {
      await invoke("set_username", { name, passcode: codeInput.value });
      await boot();
    } catch (e) {
      document.getElementById("gate-err")!.textContent = String(e);
    }
  };
  document.getElementById("name-go")?.addEventListener("click", () => void go());
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void go();
  });
}

async function boot() {
  const myId: string = await invoke("my_id");
  const myName: string = (await invoke<string | null>("username")) ?? "";
  const appVer: string = (await invoke<string>("app_version").catch(() => "")) ?? "";
  const contactNames = new Map<string, string>();
  for (const c of await invoke<Contact[]>("contacts")) contactNames.set(c.peer_id, c.name);
  const displayName = (peer: string) => {
    const shared = members.find((m) => m.peer === peer)?.name ?? "";
    return contactNames.get(peer) || shared || short(peer);
  };
  const memberLabel = (m: MemberInfo) => {
    if (m.peer !== myId) {
      return contactNames.get(m.peer) || m.name || short(m.peer);
    }
    // Our own name travels with the member list (sent on join).
    const selfName = m.name || "you";
    return selfName === "you" ? selfName : `${selfName} (you)`;
  };

  let room: string | null = null; // main room hex
  let activeRoom: string | null = null; // main hex or dm hex
  const dms = new Map<string, { peer: string; msgs: ChatMessage[] }>();
  let isHost = false;
  let epoch = 1;
  let status = "connecting";
  let hostPeer = "";
  let members: MemberInfo[] = [];
  let renamingPeer: string | null = null;
  let editingCode = false;
  let clearArmed = false;
  let clearTimer: number | undefined;
  let rotateModalOpen = false;
  let resetModalOpen = false;
  // True when this profile started with a room code: the app then lives
  // in the code's room universe instead of the main room.
  const codeRoom: boolean = await invoke("has_passcode");
  let messages: ChatMessage[] = [];
  // Quiet narration lines interleaved with messages by time (session-only).
  let narration: Array<{ ts: number; text: string }> = [];
  const narrate = (text: string) => {
    narration.push({ ts: Date.now(), text });
    if (narration.length > 50) narration = narration.slice(-50);
  };
  // Arrival times of site-mailbox-delivered messages: a stored message
  // whose timestamp falls inside a window gets the marker.
  let viaSiteTimes: number[] = [];
  const markViaSite = () => {
    const now = Date.now();
    viaSiteTimes.push(now);
    viaSiteTimes = viaSiteTimes.filter((t) => now - t < 600_000);
  };
  const cameViaSite = (ts: number) => viaSiteTimes.some((t) => Math.abs(t - ts) < 2500);
  // The friend-facing invite sentence for THIS room.
  let roomCodeWord: string | null = null;
  invoke<string | null>("passcode").then((c) => { roomCodeWord = c; }).catch(() => {});
  const inviteText = () => roomCodeWord
    ? `Get OnlyHumans at onlyhumans.deepflux.space — install it, enter any name, then use the code word: ${roomCodeWord}`
    : `Get OnlyHumans at onlyhumans.deepflux.space — install it, pick any name, and you're in the room everyone shares.`;
  const copyInvite = async () => {
    const t = inviteText();
    try {
      await navigator.clipboard.writeText(t);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = t; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); ta.remove();
    }
    toast("Invite copied — paste it to a friend");
  };

  // Site link (anonymous presence beacon): green = the site's public
  // counter currently includes us. Beats arrive with each hub cycle
  // (~2 min); consider the link stale if none landed for 6 min.
  let siteLinked = false;
  let siteOnline = 0;
  let siteBeatAt = 0;
  const siteLive = () => siteLinked && Date.now() - siteBeatAt < 360_000;
  const siteDotHtml = () => {
    const live = siteLive();
    const title = live
      ? `You're counted on the site's online counter${
          siteOnline > 0 ? ` — ${siteOnline} online now` : ""
        }. No names, just a number.`
      : "The site's counter can't see this app right now (hub unreachable). Chat keeps working.";
    return `<span class="sitelink ${live ? "on" : ""}" title="${title}"><span class="sitedot"></span>${
      live ? "on the site" : "site: offline"
    }</span>`;
  };
  const updateSiteDot = () => {
    document.querySelectorAll<HTMLElement>(".sitelink").forEach((el) => {
      el.outerHTML = siteDotHtml();
    });
  };
  setInterval(updateSiteDot, 30_000);

  // Live elapsed counter for the room-search phase: finding the room can
  // legitimately take ~60s (grace period before founding), which reads as
  // a hang without a ticking indicator. Full re-renders would fight the
  // incoming node events, so only the status text nodes are touched.
  const joinStart = Date.now();
  const joinTicker = setInterval(() => {
    if (room !== null) { clearInterval(joinTicker); return; }
    document.querySelectorAll<HTMLElement>(".live-status")
      .forEach((el) => (el.textContent = statusLine()));
  }, 1000);

  document.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape") {
      closeMenus();
      if (rotateModalOpen) closeRotateModal();
      if (resetModalOpen) closeResetModal();
    }
  });
  // Dismiss any open menu on an outside click (menu items stop
  // propagation, so this only fires for clicks elsewhere).
  document.addEventListener("click", (e) => {
    const m = document.getElementById("open-menu");
    if (m && !m.contains(e.target as Node)) closeMenus();
  });

  render();
  await invoke("request_state").catch(() => {});
  await listen<NodeEvent>("node-event", (ev) => {
    void onNodeEvent(ev.payload);
  });

  // Field-diagnostics: surface UI-side failures that would otherwise be
  // invisible in release builds (a dead listener looks exactly like a
  // broken network). Every listener crash lands on-screen + in the title.
  const diag = (msg: string) => {
    document.title = `! ${msg}`.slice(0, 120);
    let box = document.getElementById("ui-diag");
    if (!box) {
      box = document.createElement("pre");
      box.id = "ui-diag";
      box.style.cssText = "position:fixed;bottom:0;left:0;right:0;z-index:99;max-height:40%;overflow:auto;margin:0;padding:6px 10px;background:#5b1a1a;color:#ffd7d7;font:11px/1.5 Consolas,monospace;white-space:pre-wrap";
      document.body.appendChild(box);
    }
    box.textContent += `${new Date().toLocaleTimeString()} ${msg}\n`;
  };
  window.addEventListener("error", (e) => diag(`error: ${e.message} @${e.filename}:${e.lineno}`));
  window.addEventListener("unhandledrejection", (e) => diag(`unhandled: ${String((e as PromiseRejectionEvent).reason)}`));

  // Self-healing pull channel: the push events proved intermittently
  // lossy between the shell and this webview (a dropped RoomReady froze
  // the UI on "joining…" while the node was fully in the room). The
  // shell mirrors the node's state on the pump — poll it and replay the
  // same merge the events would run. Fast while joining, relaxed after.
  let pollTick = 0;
  setInterval(() => {
    void (async () => {
      pollTick++;
      if (room !== null && pollTick % 6 !== 0) return;
      try {
        const s = await invoke<RoomSnapshot | null>("room_snapshot");
        if (!s) return;
        await onNodeEvent({ kind: "joinStatus", status: s.status });
        if (s.room) {
          await onNodeEvent({ kind: "roomReady", room: s.room, peer: s.host ?? "", weAreHost: s.weAreHost, epoch: s.epoch });
          await onNodeEvent({ kind: "membersChanged", room: s.room, members: s.members ?? [] });
          if (activeRoom !== null) await refreshMessages();
        }
      } catch {
        /* node not running yet */
      }
    })();
  }, 10_000);

  async function onNodeEvent(p: NodeEvent) {
    try {
    switch (p.kind) {
      case "message": {
        if (p.viaSite) markViaSite();
        if (p.room === room) {
          // Main room: the core persists; refresh from the store.
          if (activeRoom === room) await refreshMessages();
        } else {
          // DM: memory only.
          const dm = dms.get(p.room);
          if (dm) {
            dm.msgs.push({
              id: Date.now(), sender: p.sender, body: p.body,
              ts: Date.now(), outgoing: false, epoch: p.epoch,
              viaSite: p.viaSite,
            });
            if (activeRoom === p.room) {
              render();
            } else {
              toast(`Private message from ${displayName(p.sender)}`);
            }
          }
        }
        render();
        break;
      }
      case "roomReady": {
        if (room === null || p.room === room) {
          // Main room (or first arrival).
          room = p.room;
          activeRoom = p.room;
          isHost = p.weAreHost;
          hostPeer = p.peer;
          epoch = p.epoch;
          status = p.weAreHost ? "hosting" : "connected";
          await refreshMessages();
        } else {
          // A private room opened (by us or an invite).
          dms.set(p.room, { peer: p.peer, msgs: [] });
          activeRoom = p.room;
        }
        render();
        break;
      }
      case "membersChanged": {
        const before = new Set(members.map((m) => m.peer));
        room = p.room;
        members = p.members;
        const after = new Set(members.map((m) => m.peer));
        for (const m of members) {
          if (!before.has(m.peer) && m.peer !== myId) narrate(`${memberLabel(m)} joined`);
        }
        for (const old of before) {
          if (!after.has(old) && old !== myId) narrate(`${displayName(old)} left`);
        }
        render();
        break;
      }
      case "joinStatus": {
        status = p.status;
        render();
        break;
      }
      case "messagesCleared": {
        room = p.room;
        messages = [];
        render();
        break;
      }
      case "rotated": {
        narrate(`key rotated to generation ${p.newEpoch} — the room is closed to newcomers`);
        epoch = p.newEpoch;
        if (p.room === room) {
          await refreshMessages();
          render();
        }
        break;
      }
      case "connectionStateChanged":
        if (p.connected) connectedPeers.add(p.peer);
        else connectedPeers.delete(p.peer);
        render();
        break;
      case "presence":
        siteLinked = p.linked;
        siteOnline = p.online;
        siteBeatAt = Date.now();
        updateSiteDot();
        break;
      case "log":
        if (p.message.startsWith("conn ") || p.message.startsWith("hub ")) return;
        console.debug("[node]", p.message);
        break;
      case "listening":
        break;
    }
    } catch (e) {
      diag(`node-event handler threw on kind=${(p as { kind: string }).kind}: ${String(e)}`);
    }
  }

  async function refreshMessages() {
    if (room) messages = await invoke("messages", { room, limit: 500 });
  }

  function short(peer: string) { return peer.slice(0, 10) + "…"; }

  function activeRoomOf(peer: string): string | null {
    for (const [hex, dm] of dms) if (dm.peer === peer) return hex;
    return null;
  }

  /** Offline targets for the active room (message stays undelivered). */
  function offlineTargets(): string[] {
    if (activeRoom === room) {
      return members.filter((m) => m.peer !== myId && !connectedPeers.has(m.peer))
        .map((m) => contactNames.get(m.peer) || m.name || m.peer.slice(0, 8));
    }
    const dm = dms.get(activeRoom ?? "");
    if (!dm) return [];
    return connectedPeers.has(dm.peer) ? [] : [displayName(dm.peer)];
  }

  function statusLine(): string {
    switch (status) {
      case "hosting": return "you host the room";
      case "connected": return `connected · ${displayName(hostPeer)} hosts`;
      case "joining": return "knocking — proving you know the way in…";
      case "founding": return "creating the room — you're the first…";
      case "sealed": return "closed by key rotation";
      default: return "finding the room…";
    }
  }

  function closeRotateModal() {
    rotateModalOpen = false;
    render();
  }

  function closeResetModal() {
    resetModalOpen = false;
    render();
  }

function toast(text: string) {
  const box = ensureToasts();
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = text;
  box.appendChild(t);
  setTimeout(() => t.remove(), 6000);
}

type MenuItem = { label: string; hint?: string; danger?: boolean; header?: boolean; act?: () => void };

/** Dropdown menu anchored to a command-bar / titlebar control. One menu
 * at a time (id="open-menu"); dismissed by outside click or Escape. */
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
    b.className = "menu-item" + (it.danger ? " danger" : "");
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
function closeMenus() {
  document.getElementById("open-menu")?.remove();
}

  function ensureToasts(): HTMLElement {
    let box = document.querySelector<HTMLElement>(".toasts");
    if (!box) { box = document.createElement("div"); box.className = "toasts"; app.appendChild(box); }
    return box;
  }

  function render() {
    const ready = room !== null;
    // A full re-render fires on every incoming message; keep whatever the
    // user is typing (value + focus) so the composer survives it.
    const prevSend = document.getElementById("send-text") as HTMLInputElement | null;
    const sendState = prevSend
      ? { value: prevSend.value, focused: document.activeElement === prevSend }
      : null;
    const prevRename = document.getElementById("rename-input") as HTMLInputElement | null;
    const renameState = prevRename
      ? { value: prevRename.value, focused: document.activeElement === prevRename }
      : null;
    layout.innerHTML = `
      <header class="cmdbar">
        <img class="brandlogo" src="/logo.png" alt="">
        <span class="logo">OnlyHumans</span>
        <button id="room-switch" class="roomswitch" title="rooms — switch, move, or open another window">
          <span class="rs-glyph">${codeRoom ? "◆" : "⌂"}</span>
          <span class="rs-label">${codeRoom ? "Code room" : "Main room"}</span>
          <span class="caret">▾</span>
        </button>
        ${siteDotHtml()}
        <button id="identity-menu" class="idmenu" title="your profile">
          ${avatarHtml(myId, myName || "you")}
          <span class="idname">${escapeHtml(myName || "you")}</span>
          <span class="caret">▾</span>
        </button>
      </header>
      <main>
        <div class="sidebar">
          <div class="status live-status">${statusLine()}</div>
          <div class="side-label">people in the room</div>
          <ul class="member-list">
            ${ready ? `
            <li class="${isHost ? "ishost" : ""}" title="this is you">
              ${avatarHtml(myId, myName)}
              <div class="li-body">
                <span class="mname">${escapeHtml(myName ? `${myName} (you)` : "you")}</span>
                <span class="li-sub">${isHost ? "hosts the room" : "you"}</span>
              </div>
            </li>` : ""}
            ${members.filter((m) => m.peer !== myId).map((m) => `
              <li data-peer="${m.peer}" class="${m.peer === hostPeer ? "ishost" : ""}">
                ${avatarHtml(m.peer, memberLabel(m))}
                <div class="li-body">
                  <span class="mname">${escapeHtml(memberLabel(m))}</span>
                  <span class="li-sub">${m.peer === hostPeer ? "hosts the room" : (connectedPeers.has(m.peer) ? "online" : "offline")}</span>
                </div>
                <button class="dm-btn" data-peer="${m.peer}" title="private chat with ${escapeHtml(memberLabel(m))}">⇄</button>
                <button class="rename-btn" data-peer="${m.peer}" title="rename">✎</button>
              </li>`).join("")}
          </ul>
          ${dms.size ? `
          <div class="side-label plabel">private chats</div>
          <ul class="dm-list">
            ${[...dms.entries()].map(([hex, dm]) => {
              const name = displayName(dm.peer);
              return `
              <li data-dm="${hex}" class="dmrow ${activeRoom === hex ? "active" : ""}" title="${dm.peer}">
                ${avatarHtml(dm.peer, name)}
                <div class="li-body">
                  <span class="mname">${escapeHtml(name)}</span>
                  <span class="li-sub">${connectedPeers.has(dm.peer) ? "online" : "offline"}</span>
                </div>
              </li>`;}).join("")}
          </ul>` : ""}
        </div>
        ${ready ? `
        <div class="chat ${activeRoom === room ? "" : "dm"}">
          <div class="titlebar">
            ${activeRoom === room
              ? `${MAIN_ROOM_ICON}
                 <div class="tb-body">
                   <div class="tb-title">${codeRoom ? "Code room" : "Main room"}</div>
                   <div class="tb-sub">${statusLine()} · generation ${epoch}</div>
                   <div class="pills">
                     <span class="pill ${codeRoom ? "amber" : ""}" title="${codeRoom ? "only people who typed this room's code word can be here" : "everyone who opens the app lands here"}">${codeRoom ? "code room" : "public"}</span>
                     <span class="pill lock" title="messages are sealed on your device — the site never sees them">🔒 e2e</span>
                   </div>
                 </div>
                 <button id="room-actions" class="more-btn" title="room actions">⋯</button>`
              : (() => {
                  const dm = dms.get(activeRoom ?? "");
                  const peer = dm?.peer ?? "";
                  const on = connectedPeers.has(peer);
                  const name = displayName(peer);
                  return `${avatarHtml(peer, name)}
                    <div class="tb-body">
                      <div class="tb-title">${escapeHtml(name)} <span class="pp-pill">private</span></div>
                      <div class="tb-sub"><i class="dot ${on ? "on" : "off"}"></i>${on ? "online" : "offline"} · vanishes when you both leave</div>
                    </div>`;
                })()}
          </div>
          <div class="messages" id="msgs">
            ${activeRoom === room && messages.length === 0 ? `<div class="chat-hint">${codeRoom ? (members.filter((m) => m.peer !== myId).length === 0 ? `Nobody else has used this code word yet — they land here the moment they type the same word. <button id="invite-btn" class="linklike">Invite someone</button>` : "You're in — only people who typed this room's code word can be here.") : (members.filter((m) => m.peer !== myId).length === 0 ? `You're the first here. Everyone who opens the app lands in this room — say hi, or <button id="invite-btn" class="linklike">invite a friend</button>.` : "You're in — everyone who opens the app joins this room. Say hi.")}</div>` : ""}
            ${((): string => {
              const msgs = activeRoom === room ? messages : (dms.get(activeRoom ?? "")?.msgs ?? []);
              const items: Array<{ ts: number; html: string }> = msgs.map((m) => {
                const showSender = activeRoom === room && !m.outgoing;
                const hue = peerHue(m.sender);
                const via = !m.outgoing && (m.viaSite || (activeRoom === room && cameViaSite(m.ts)));
                return { ts: m.ts, html: `
              ${showSender ? `<div class="sender" style="color:hsl(${hue} 65% 70%)">${escapeHtml(displayName(m.sender))}</div>` : ""}
              <div class="msg ${m.outgoing ? "out" : "in"}">
                ${escapeHtml(m.body)}
                <div class="meta">${fmtTime(m.ts)}${activeRoom === room ? ` · gen ${m.epoch}` : ""}${via ? ' · <span class="viasite" title="arrived through the site mailbox while you were away">⇄ site</span>' : ""}${m.pending && offlineTargets().length ? ' · <span class="pend">waiting</span>' : ""}</div>
              </div>` };
              });
              if (activeRoom === room) {
                for (const n of narration) items.push({ ts: n.ts, html: `<div class="narration">${escapeHtml(n.text)}</div>` });
              }
              items.sort((a, b) => a.ts - b.ts);
              return items.map((i) => i.html).join("");
            })()}
          </div>
          ${offlineTargets().length ? `
          <div class="pending-strip">
            ⏱ ${offlineTargets().length === 1 ? escapeHtml(offlineTargets()[0]) + " is offline" : offlineTargets().length + " members are offline"}
            — messages wait sealed on the site and arrive when they're back (usually within a minute or two)
          </div>` : ""}
          <div class="composer">
            <input id="send-text" placeholder="${activeRoom === room ? "message the room…" : "message privately…"}" autocomplete="off" ${ready ? "" : "disabled"}>
            <button class="primary" id="send">Send</button>
          </div>
        </div>` : `<div class="empty">${status === "sealed"
            ? `<div class="join-progress"><span class="live-status">${statusLine()}</span></div>This room's key was rotated by its members — only the people who were inside keep access, and no one new can get in. To enter a different room, log off and use its code word.`
            : `<div class="join-progress"><span class="spin"></span><span class="live-status">${statusLine()}</span></div>${codeRoom ? "Only people with the same code word (and this build) can find this room." : "Nobody has answered the hub yet — if no host appears within a minute, this device creates the room."}`}</div>`}
      </main>
      ${rotateModalOpen ? `
      <div class="modal-backdrop" id="rotate-backdrop">
        <div class="modal">
          <h3>Rotate the room key?</h3>
          <p>The key changes now and travels only to the people already
          inside. From that moment the room is <b>closed to newcomers,
          forever</b>: for a room without a code word, no one who is not in
          it now will ever be able to get in — and a room code stops
          opening this room too. Members who are offline keep their seat
          and receive the new key when they return.</p>
          <div class="actions">
            <button id="rotate-cancel">Cancel</button>
            <button id="rotate-confirm" class="primary">Rotate now</button>
          </div>
        </div>
      </div>` : ""}
      ${resetModalOpen ? `
      <div class="modal-backdrop" id="reset-backdrop">
        <div class="modal">
          <h3>Reset this room?</h3>
          <p>This window forgets its room key and rediscovers the room from
          the hub: it joins whoever currently hosts it, or creates it
          fresh if nobody does. Use this to heal two computers that ended
          up each hosting their own copy of the room. Your saved history
          stays; the new key arrives from the host you join.</p>
          <div class="actions">
            <button id="reset-cancel">Cancel</button>
            <button id="reset-confirm" class="primary">Reset room</button>
          </div>
        </div>
      </div>` : ""}`;

    (document.getElementById("msgs") as HTMLElement | null)?.scrollTo(0, 1e9);

    const sendEl = document.getElementById("send-text") as HTMLInputElement | null;
    if (sendEl && sendState) {
      sendEl.value = sendState.value;
      if (sendState.focused) sendEl.focus();
    }
    const renameEl = document.getElementById("rename-input") as HTMLInputElement | null;
    if (renameEl && renameState) {
      renameEl.value = renameState.value;
      if (renameState.focused) renameEl.focus();
    }

    // ── Command bar menus ─────────────────────────────────────────
    // Rooms: one home for every room-moving flow (open a parallel
    // window, or move THIS window by restarting it under another code).
    document.getElementById("room-switch")?.addEventListener("click", (e) => {
      const el = e.currentTarget as HTMLElement;
      if (document.getElementById("open-menu")) { closeMenus(); return; }
      openMenu(el, [
        { label: codeRoom ? "◆ this window · code room" : "⌂ this window · main room", header: true },
        {
          label: "Open another room window",
          hint: "side by side — its own name and code",
          act: () => void invoke("open_parallel_room").catch((err) => toast(String(err))),
        },
        {
          label: "Move this window to another room…",
          hint: "type a code word — restarts here (empty = main)",
          act: () => {
            if (editingCode) { document.getElementById("code-edit-input")?.focus(); return; }
            editingCode = true;
            render();
          },
        },
      ]);
    });
    // Identity: the person-scoped actions live with the person.
    document.getElementById("identity-menu")?.addEventListener("click", (e) => {
      const el = e.currentTarget as HTMLElement;
      if (document.getElementById("open-menu")) { closeMenus(); return; }
      openMenu(el, [
        { label: `${myName || "you"} · v${appVer}`, header: true },
        {
          label: "Log off",
          hint: "forget this name — back to the gate",
          act: () => void invoke("logoff").catch((err) => toast(String(err))),
        },
        { label: "Enter sends · Shift+Enter newline · Esc closes", header: true },
      ]);
    });
    // Room actions: destructive/technical tools behind one overflow.
    document.getElementById("room-actions")?.addEventListener("click", (e) => {
      const el = e.currentTarget as HTMLElement;
      if (document.getElementById("open-menu")) { closeMenus(); return; }
      const showRoomMenu = () => {
        openMenu(el, [
          {
            label: "Invite to this room",
            hint: "copies a message a friend can follow",
            act: () => void copyInvite(),
          },
          ...(isHost ? [{
            label: "Rotate key…",
            hint: "new key — closes the room to newcomers forever",
            act: () => { rotateModalOpen = true; render(); },
          }] : []),
          {
            label: clearArmed ? "Really clear for everyone?" : "Clear history",
            hint: "wipes saved history on every member's device",
            danger: clearArmed,
            act: () => {
              if (!clearArmed) {
                clearArmed = true;
                window.clearTimeout(clearTimer);
                clearTimer = window.setTimeout(() => { clearArmed = false; render(); }, 8000);
                showRoomMenu();
                return;
              }
              window.clearTimeout(clearTimer);
              clearArmed = false;
              void invoke("clear_history").then(() => {
                toast("History cleared for everyone in the room");
                render();
              }).catch((err) => toast(String(err)));
            },
          },
          {
            label: "Reset room…",
            hint: "forget this window's key and rediscover",
            act: () => { resetModalOpen = true; render(); },
          },
        ]);
      };
      showRoomMenu();
    });
    // The editor lives in the toast layer, which render() never clears —
    // append it only once per open, or every re-render (connection and
    // member events fire them) stacks duplicate identical editors.
    if (editingCode && !document.getElementById("code-edit-input")) {
      const box = ensureToasts();
      const t = document.createElement("div");
      t.className = "toast";
      t.innerHTML = `<b>Change this window's room</b><div class="code-note">Type a word and Save — this window restarts inside that word's room (everyone using the same word meets there). Empty returns you to the main room. To keep this room open and open another one beside it, use “Open another room window” instead.</div>`;
      const row = document.createElement("div");
      row.className = "actions";
      const input = document.createElement("input");
      input.id = "code-edit-input";
      input.placeholder = "code word…";
      input.maxLength = 64;
      const save = document.createElement("button");
      save.className = "primary"; save.textContent = "Save";
      const cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      row.append(input, save, cancel);
      t.appendChild(row);
      box.appendChild(t);
      input.focus();
      const done = async () => {
        editingCode = false;
        try {
          await invoke("set_passcode", { word: input.value });
          // set_passcode restarts the app; this only runs if it errored.
          t.remove();
          render();
        } catch (err) {
          toast(String(err));
        }
      };
      save.onclick = () => void done();
      cancel.onclick = () => { editingCode = false; t.remove(); };
      input.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter") void done();
        if ((e as KeyboardEvent).key === "Escape") { editingCode = false; t.remove(); }
      });
    }
    // Open private rooms listed in the sidebar: click to switch.
    document.querySelectorAll<HTMLElement>(".sidebar li.dmrow").forEach((li) => {
      li.addEventListener("click", () => {
        const hex = li.dataset.dm!;
        if (dms.has(hex)) {
          activeRoom = hex;
          render();
        }
      });
    });
    // Member rows: the ⇄ chip opens (or re-opens) the private chat; the
    // pencil renames. Row clicks don't start conversations by accident.
    document.querySelectorAll<HTMLElement>(".sidebar button.dm-btn").forEach((b) => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const peer = (b as HTMLElement).dataset.peer!;
        void invoke("open_dm", { peer }).catch((err) => toast(String(err)));
      });
    });
    document.querySelectorAll<HTMLElement>(".rename-btn").forEach((b) => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        // Drop an editor opened for a different peer (or a stray one left
        // by an older render) so exactly one overlay exists.
        (document.getElementById("rename-input")?.closest(".toast") as HTMLElement | null)?.remove();
        renamingPeer = b.dataset.peer ?? null;
        render();
      });
    });
    if (renamingPeer && !document.getElementById("rename-input")) {
      // Renaming overlay lives in the toast layer (outside #layout), which
      // render() never clears — guard the append like the code editor.
      const box = ensureToasts();
      const t = document.createElement("div");
      t.className = "toast";
      t.innerHTML = `<b>Name for ${escapeHtml(short(renamingPeer))}</b>`;
      const row = document.createElement("div");
      row.className = "actions";
      const input = document.createElement("input");
      input.id = "rename-input";
      input.value = contactNames.get(renamingPeer) ?? "";
      input.placeholder = "name…";
      const save = document.createElement("button");
      save.className = "primary"; save.textContent = "Save";
      const cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      row.append(input, save, cancel);
      t.appendChild(row);
      box.appendChild(t);
      input.focus();
      const done = async () => {
        const name = input.value.trim();
        if (name && renamingPeer) {
          await invoke("add_contact", { peer: renamingPeer, name });
          contactNames.set(renamingPeer, name);
        }
        renamingPeer = null;
        t.remove();
        render();
      };
      save.onclick = () => void done();
      cancel.onclick = () => { renamingPeer = null; t.remove(); };
      input.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter") void done();
        if ((e as KeyboardEvent).key === "Escape") { renamingPeer = null; t.remove(); }
      });
    }

    document.getElementById("invite-btn")?.addEventListener("click", () => void copyInvite());
    document.getElementById("send")?.addEventListener("click", sendCurrent);
    document.getElementById("send-text")?.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") sendCurrent();
    });
    document.getElementById("rotate-cancel")?.addEventListener("click", closeRotateModal);
    document.getElementById("rotate-backdrop")?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeRotateModal();
    });
    document.getElementById("rotate-confirm")?.addEventListener("click", async () => {
      rotateModalOpen = false;
      await invoke("rotate_key").catch((e) => toast(String(e)));
      toast("Key rotated — the room is now closed to newcomers; current members keep their seats");
      render();
    });

    document.getElementById("reset-cancel")?.addEventListener("click", closeResetModal);
    document.getElementById("reset-backdrop")?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeResetModal();
    });
    document.getElementById("reset-confirm")?.addEventListener("click", async () => {
      resetModalOpen = false;
      // Drop the UI's view of the room immediately; the node forgets its
      // side on the command below and re-emits RoomReady when it lands
      // in the room again (joining the current host, or founding anew).
      room = null;
      activeRoom = null;
      isHost = false;
      epoch = 1;
      members = [];
      messages = [];
      status = "connecting";
      await invoke("reset_room").catch((e) => toast(String(e)));
      render();
    });

    async function sendCurrent() {
      const input = document.getElementById("send-text") as HTMLInputElement | null;
      if (!input || !room) return;
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      const targets = offlineTargets();
      await invoke("send_message", { room: activeRoom ?? room, text });
      if (activeRoom !== room && activeRoom) {
        const dm = dms.get(activeRoom);
        if (dm) {
          dm.msgs.push({
            id: Date.now(), sender: myId, body: text,
            ts: Date.now(), outgoing: true, epoch: 1,
            pending: targets.length > 0,
          });
        }
      }
      if (targets.length) {
        toast(`⏱ ${targets.length === 1 ? escapeHtml(targets[0]) + " is offline" : targets.length + " members are offline"} — queued, delivered when they're back`);
      }
      await refreshMessages();
      render();
    }
  }
}


function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

main().catch((e) => {
  app.innerHTML = `<div class="empty">Failed to start: ${String(e)}</div>`;
});
