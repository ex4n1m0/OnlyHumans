// OnlyHumans UI — one global room. Everyone who runs the app joins the
// same room automatically; the first ever member founded it.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface ChatMessage { id: number; sender: string; body: string; ts: number; outgoing: boolean; epoch: number }
interface Contact { peer_id: string; name: string }
interface MemberInfo { peer: string; name: string }
type NodeEvent =
  | { kind: "listening"; addr: string }
  | { kind: "joinStatus"; status: string }
  | { kind: "roomReady"; room: string; peer: string; weAreHost: boolean; epoch: number }
  | { kind: "message"; room: string; sender: string; body: string; epoch: number }
  | { kind: "membersChanged"; room: string; members: MemberInfo[] }
  | { kind: "messagesCleared"; room: string }
  | { kind: "rotated"; room: string; newEpoch: number }
  | { kind: "connectionStateChanged"; peer: string; connected: boolean }
  | { kind: "log"; message: string };

const app = document.getElementById("app")!;

// render() rewrites only #layout; the toast layer is a sibling so bursts of
// re-renders can never wipe a pending prompt.
const layout = document.createElement("div");
layout.id = "layout";
app.appendChild(layout);

/** Peers we currently have a libp2p connection to. */
const connectedPeers = new Set<string>();

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + time;
}

async function main() {
  // First-run gate: the room is only joined once a username exists.
  const named: boolean = await invoke("has_username");
  if (!named) {
    renderGate();
    return;
  }
  await boot();
}

function renderGate() {
  layout.innerHTML = `
    <div class="gate">
      <div class="brand" style="justify-content:center">
        <svg viewBox="0 0 44 44" style="width:40px;height:40px" aria-hidden="true">
          <rect x="2" y="2" width="40" height="40" rx="10" fill="none" stroke="#17a2b8" stroke-width="2.5"/>
          <circle cx="15" cy="15" r="3.6" fill="#17a2b8"/><circle cx="30" cy="17" r="3.6" fill="#17a2b8"/><circle cx="22" cy="31" r="3.6" fill="#17a2b8"/>
          <path d="M17.6 16.4 L27.4 16.9 M16.6 18 20.5 28 M28.6 20 24 28.4" stroke="#17a2b8" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
      </div>
      <h2>Welcome to OnlyHumans</h2>
      <p>Pick a name — the room will know you by it.</p>
      <div class="gaterow">
        <input id="name-input" placeholder="your name…" maxlength="32" spellcheck="false" autocomplete="off">
        <button class="primary" id="name-go">Enter the room</button>
      </div>
      <p class="gatehint" id="gate-err"></p>
    </div>`;
  const input = document.getElementById("name-input") as HTMLInputElement;
  input.focus();
  const go = async () => {
    const name = input.value.trim();
    if (!name) {
      document.getElementById("gate-err")!.textContent = "A name is required to continue.";
      return;
    }
    try {
      await invoke("set_username", { name });
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
  let clearArmed = false;
  let clearTimer: number | undefined;
  let messages: ChatMessage[] = [];

  render();
  await invoke("request_state").catch(() => {});
  await listen<NodeEvent>("node-event", (ev) => {
    void onNodeEvent(ev.payload);
  });

  async function onNodeEvent(p: NodeEvent) {
    switch (p.kind) {
      case "message": {
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
        room = p.room;
        members = p.members;
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
      case "log":
        if (p.message.startsWith("conn ") || p.message.startsWith("hub ")) return;
        console.debug("[node]", p.message);
        break;
      case "listening":
        break;
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

  function statusLine(): string {
    switch (status) {
      case "hosting": return "you host the room";
      case "connected": return `connected · ${displayName(hostPeer)} hosts`;
      case "joining": return "joining the room…";
      case "founding": return "creating the room (first member)…";
      default: return "looking for the room…";
    }
  }

  function toast(text: string) {
    const box = ensureToasts();
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = text;
    box.appendChild(t);
    setTimeout(() => t.remove(), 6000);
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
      <header>
        <span class="logo">OnlyHumans</span>
      </header>
      <main>
        <div class="sidebar">
          <div class="roominfo">
            <div class="status">${statusLine()}</div>
            <div class="members-n">${members.length || (ready ? 1 : 0)} member${(members.length || 1) === 1 ? "" : "s"}</div>
          </div>
          <ul>
            ${ready ? `
            <li data-room="${room}" class="roomrow ${activeRoom === room ? "active" : ""}">
              <i class="dot ${isHost || connectedPeers.size > 0 ? "on" : "off"}"></i>
              <span>main room</span>
              ${dms.size ? `<span class="peer">${dms.size} dm${dms.size === 1 ? "" : "s"}</span>` : ""}
            </li>` : ""}
            ${members.filter((m) => m.peer !== myId).map((m) => `
              <li data-peer="${m.peer}" class="${m.peer === hostPeer ? "ishost" : ""} ${dms.has(activeRoomOf(m.peer) ?? "") ? "hasdm" : ""}" title="${m.peer}">
                <i class="dot ${connectedPeers.has(m.peer) ? "on" : "off"}"></i>
                <span class="mname" data-peer="${m.peer}">${escapeHtml(memberLabel(m))}</span>
                ${m.peer === hostPeer ? '<span class="peer">host</span>' : ""}
                <button class="rename-btn" data-peer="${m.peer}" title="rename">✎</button>
              </li>`).join("")}
          </ul>
        </div>
        ${ready ? `
        <div class="chat">
          <div class="titlebar">
            ${activeRoom === room
              ? `<span class="status">${statusLine()} · key epoch ${epoch}</span>
                 ${isHost ? '<button id="rotate">Rotate key</button>' : ""}
                 <button id="clear-hist" class="${clearArmed ? "danger" : ""}">
                   ${clearArmed ? "Really clear for everyone?" : "Clear history"}
                 </button>`
              : (() => {
                  const dm = dms.get(activeRoom ?? "");
                  const peer = dm?.peer ?? "";
                  const on = connectedPeers.has(peer);
                  return `<span class="status"><i class="dot ${on ? "on" : "off"}"></i>${escapeHtml(displayName(peer))} · private</span>`;
                })()}
          </div>
          <div class="messages" id="msgs">
            ${(activeRoom === room ? messages : (dms.get(activeRoom ?? "")?.msgs ?? [])).map((m) => `
              <div class="msg ${m.outgoing ? "out" : "in"}">
                ${escapeHtml(m.body)}
                <div class="meta">${m.outgoing ? "you" : escapeHtml(displayName(m.sender))} · ${fmtTime(m.ts)}${activeRoom === room ? ` · e${m.epoch}` : ""}</div>
              </div>`).join("")}
          </div>
          <div class="composer">
            <input id="send-text" placeholder="message the room…" autocomplete="off" ${ready ? "" : "disabled"}>
            <button class="primary" id="send">Send</button>
          </div>
        </div>` : `<div class="empty">${statusLine()}<br>The room key is shared with everyone holding the community key.</div>`}
      </main>`;

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

    // Room switcher: the pinned main-room row.
    document.querySelector<HTMLElement>(".sidebar li.roomrow")?.addEventListener("click", async () => {
      if (!room) return;
      activeRoom = room;
      await refreshMessages();
      render();
    });
    // Member rows: click opens (or re-opens) a private room; the pencil
    // renames instead.
    document.querySelectorAll<HTMLElement>(".sidebar li[data-peer]").forEach((li) => {
      li.addEventListener("click", (e) => {
        const peer = li.dataset.peer!;
        if ((e.target as HTMLElement).classList.contains("rename-btn")) return;
        void invoke("open_dm", { peer }).catch((err) => toast(String(err)));
      });
    });
    document.querySelectorAll<HTMLElement>(".rename-btn").forEach((b) => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        renamingPeer = b.dataset.peer ?? null;
        render();
      });
    });
    if (renamingPeer) {
      // Renaming overlay lives in the toast layer (outside #layout).
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

    document.getElementById("send")?.addEventListener("click", sendCurrent);
    document.getElementById("send-text")?.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") sendCurrent();
    });
    document.getElementById("rotate")?.addEventListener("click", async () => {
      await invoke("rotate_key");
      toast("Key rotated — new key sent to current members only");
    });

    document.getElementById("clear-hist")?.addEventListener("click", async () => {
      if (!clearArmed) {
        // Destructive global action: require a second click within 8s.
        clearArmed = true;
        render();
        clearTimer = window.setTimeout(() => {
          clearArmed = false;
          render();
        }, 8000);
        return;
      }
      window.clearTimeout(clearTimer);
      clearArmed = false;
      await invoke("clear_history");
      toast("History cleared for everyone in the room");
      render();
    });

    async function sendCurrent() {
      const input = document.getElementById("send-text") as HTMLInputElement | null;
      if (!input || !room) return;
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      await invoke("send_message", { room: activeRoom ?? room, text });
      if (activeRoom !== room && activeRoom) {
        const dm = dms.get(activeRoom);
        if (dm) {
          dm.msgs.push({
            id: Date.now(), sender: myId, body: text,
            ts: Date.now(), outgoing: true, epoch: 1,
          });
        }
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
