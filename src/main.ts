// OnlyHumans UI — minimal chat client over the Rust core.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface ChatMessage { id: number; sender: string; body: string; ts: number; outgoing: boolean; epoch: number }
interface Conversation { room: string; peer: string; isHost: boolean }
interface Contact { peer_id: string; name: string }
type NodeEvent =
  | { kind: "listening"; addr: string }
  | { kind: "invitationReceived"; room: string; host: string }
  | { kind: "roomReady"; room: string; peer: string; weAreHost: boolean; epoch: number }
  | { kind: "message"; room: string; sender: string; body: string; epoch: number }
  | { kind: "approvalRequested"; room: string; peer: string }
  | { kind: "rotated"; room: string; newEpoch: number }
  | { kind: "connectionStateChanged"; peer: string; connected: boolean }
  | { kind: "log"; message: string };

const app = document.getElementById("app")!;

// render() rewrites only #layout; the toast layer is a sibling so bursts of
// re-renders (e.g. the connectionStateChanged storm right after a dial) can
// never wipe a pending invitation/approval prompt.
const layout = document.createElement("div");
layout.id = "layout";
app.appendChild(layout);

/** Peers we currently have a libp2p connection to (per connectionStateChanged). */
const connectedPeers = new Set<string>();

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + time;
}

async function main() {
  const myId: string = await invoke("my_id");
  let conversations: Conversation[] = await invoke("conversations");
  const contactNames = new Map<string, string>();
  for (const c of await invoke<Contact[]>("contacts")) contactNames.set(c.peer_id, c.name);
  /** Saved peer name, falling back to a short id fragment. */
  const displayName = (peer: string) => contactNames.get(peer) ?? short(peer);
  let renamingPeer: string | null = null;
  let activeRoom: string | null = null;
  let messages: ChatMessage[] = [];

  render();

  await listen<NodeEvent>("node-event", (ev) => {
    void onNodeEvent(ev.payload);
  });

  async function onNodeEvent(p: NodeEvent) {
    switch (p.kind) {
      case "message": {
        await invoke("record_message", {
          room: p.room, sender: p.sender, body: p.body, epoch: p.epoch,
        });
        if (p.room === activeRoom) {
          await refreshMessages();
        } else {
          toast(`New message from ${displayName(p.sender)}`);
        }
        render();
        break;
      }
      case "roomReady": {
        conversations = await invoke("conversations");
        activeRoom = p.room;
        await refreshMessages();
        render();
        break;
      }
      case "rotated": {
        if (p.room === activeRoom) {
          await refreshMessages();
          render();
        }
        break;
      }
      case "approvalRequested":
        approvalToast(p.room, p.peer);
        break;
      case "invitationReceived":
        invitationToast(p.room, p.host);
        break;
      case "connectionStateChanged":
        if (p.connected) connectedPeers.add(p.peer);
        else connectedPeers.delete(p.peer);
        render();
        break;
      case "log":
        console.debug("[node]", p.message);
        break;
      case "listening":
        break;
    }
  }

  async function refreshMessages() {
    if (activeRoom) messages = await invoke("messages", { room: activeRoom, limit: 500 });
  }

  function short(peer: string) { return peer.slice(0, 10) + "…"; }

  function toast(text: string) {
    const box = ensureToasts();
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = text;
    box.appendChild(t);
    setTimeout(() => t.remove(), 6000);
  }

  function invitationToast(room: string, host: string) {
    const box = ensureToasts();
    const t = document.createElement("div");
    t.className = "toast";
    t.innerHTML = `<b>${escapeHtml(displayName(host))}</b> invites you to chat.`;
    const actions = document.createElement("div");
    actions.className = "actions";
    const yes = document.createElement("button");
    yes.className = "primary"; yes.textContent = "Accept";
    const no = document.createElement("button");
    no.className = "danger"; no.textContent = "Decline";
    yes.onclick = async () => {
      await invoke("accept_invitation", { room, host });
      t.remove();
    };
    no.onclick = () => t.remove();
    actions.append(yes, no);
    t.appendChild(actions);
    box.appendChild(t);
  }

  function approvalToast(room: string, peer: string) {
    const box = ensureToasts();
    const t = document.createElement("div");
    t.className = "toast";
    t.innerHTML = `<b>${short(peer)}</b> wants to join a room.`;
    const actions = document.createElement("div");
    actions.className = "actions";
    const yes = document.createElement("button");
    yes.className = "primary"; yes.textContent = "Admit";
    const no = document.createElement("button");
    no.className = "danger"; no.textContent = "Decline";
    yes.onclick = async () => {
      await invoke("approve_join", { peer, room, allow: true });
      t.remove();
    };
    no.onclick = async () => {
      await invoke("approve_join", { peer, room, allow: false });
      t.remove();
    };
    actions.append(yes, no);
    t.appendChild(actions);
    box.appendChild(t);
  }

  function ensureToasts(): HTMLElement {
    let box = document.querySelector<HTMLElement>(".toasts");
    if (!box) { box = document.createElement("div"); box.className = "toasts"; app.appendChild(box); }
    return box;
  }

  function render() {
    const active = conversations.find((c) => c.room === activeRoom);
    // A full re-render fires on every incoming message; keep whatever the
    // user is typing (value + focus) so the composer survives it.
    const prevSend = document.getElementById("send-text") as HTMLInputElement | null;
    const sendState = prevSend
      ? { value: prevSend.value, focused: document.activeElement === prevSend }
      : null;
    const peerValue = (document.getElementById("peer-input") as HTMLInputElement | null)?.value ?? "";
    const prevRename = document.getElementById("rename-input") as HTMLInputElement | null;
    const renameState = prevRename
      ? { value: prevRename.value, focused: document.activeElement === prevRename }
      : null;
    layout.innerHTML = `
      <header>
        <span class="logo">OnlyHumans</span>
        <span class="myid" title="click to copy — your ID">${myId}</span>
        <button id="copy-id">Copy ID</button>
      </header>
      <main>
        <div class="sidebar">
          <div class="newchat">
            <input id="peer-input" placeholder="peer id…" spellcheck="false">
            <button class="primary" id="open-chat">Chat</button>
          </div>
          <div class="hint">You start the room — you are its host.</div>
          <ul>
            ${conversations.map((c) => `
              <li data-room="${c.room}" class="${c.room === activeRoom ? "active" : ""}" title="${escapeHtml(c.peer)}">
                <span>${escapeHtml(displayName(c.peer))}</span>
                <span class="peer">${c.isHost ? "host" : "guest"}</span>
              </li>`).join("")}
          </ul>
        </div>
        ${active ? `
        <div class="chat">
          <div class="titlebar">
            ${renamingPeer === active.peer ? `
            <input id="rename-input" value="${escapeHtml(contactNames.get(active.peer) ?? "")}" placeholder="name…" spellcheck="false">
            <button class="primary" id="rename-save">Save</button>
            <button id="rename-cancel">Cancel</button>` : `
            <span class="status"><i class="dot ${connectedPeers.has(active.peer) ? "on" : "off"}"></i>${escapeHtml(displayName(active.peer))} · ${active.isHost ? "you host" : "peer hosts"} · ${connectedPeers.has(active.peer) ? "online" : "offline"}</span>
            <button id="rename" title="Name this peer">✎ name</button>`}
            <span class="epoch">key epoch ${messages.at(-1)?.epoch ?? 1}</span>
            ${active.isHost ? '<button id="rotate">Rotate key</button>' : ""}
          </div>
          <div class="messages" id="msgs">
            ${messages.map((m) => `
              <div class="msg ${m.outgoing ? "out" : "in"}">
                ${escapeHtml(m.body)}
                <div class="meta">${m.outgoing ? "you" : escapeHtml(displayName(m.sender))} · ${fmtTime(m.ts)} · e${m.epoch}</div>
              </div>`).join("")}
          </div>
          <div class="composer">
            <input id="send-text" placeholder="message…" autocomplete="off">
            <button class="primary" id="send">Send</button>
          </div>
        </div>` : `<div class="empty">Open a chat with someone's ID,<br>or wait for an invitation.</div>`}
      </main>`;

    (document.getElementById("msgs") as HTMLElement | null)?.scrollTo(0, 1e9);

    const sendEl = document.getElementById("send-text") as HTMLInputElement | null;
    if (sendEl && sendState) {
      sendEl.value = sendState.value;
      if (sendState.focused) sendEl.focus();
    }
    const peerEl = document.getElementById("peer-input") as HTMLInputElement | null;
    if (peerEl && peerValue) peerEl.value = peerValue;
    const renameEl = document.getElementById("rename-input") as HTMLInputElement | null;
    if (renameEl && renameState) {
      renameEl.value = renameState.value;
      if (renameState.focused) renameEl.focus();
    }

    document.getElementById("copy-id")?.addEventListener("click", () => {
      navigator.clipboard.writeText(myId);
      toast("ID copied");
    });
    document.querySelector<HTMLElement>(".myid")?.addEventListener("click", () => {
      navigator.clipboard.writeText(myId);
      toast("ID copied");
    });
    document.getElementById("open-chat")?.addEventListener("click", async () => {
      const input = document.getElementById("peer-input") as HTMLInputElement;
      const peer = input.value.trim();
      if (!peer) return;
      await invoke("open_conversation", { peer });
      toast("Inviting…");
      input.value = "";
    });
    document.querySelectorAll<HTMLElement>(".sidebar li").forEach((li) => {
      li.addEventListener("click", async () => {
        activeRoom = li.dataset.room!;
        await refreshMessages();
        render();
      });
    });
    document.getElementById("send")?.addEventListener("click", sendCurrent);
    document.getElementById("send-text")?.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") sendCurrent();
    });
    document.getElementById("rotate")?.addEventListener("click", async () => {
      if (!activeRoom) return;
      await invoke("rotate_key", { room: activeRoom });
      toast("Key rotated — new key sent to current participants only");
    });

    document.getElementById("rename")?.addEventListener("click", () => {
      if (!active) return;
      renamingPeer = active.peer;
      render();
      const input = document.getElementById("rename-input") as HTMLInputElement | null;
      input?.focus();
      input?.select();
    });
    document.getElementById("rename-save")?.addEventListener("click", saveRename);
    document.getElementById("rename-cancel")?.addEventListener("click", () => {
      renamingPeer = null;
      render();
    });
    document.getElementById("rename-input")?.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") void saveRename();
      if ((e as KeyboardEvent).key === "Escape") {
        renamingPeer = null;
        render();
      }
    });

    async function saveRename() {
      const input = document.getElementById("rename-input") as HTMLInputElement | null;
      const peer = renamingPeer;
      if (!input || !peer) return;
      const name = input.value.trim();
      if (name) {
        await invoke("add_contact", { peer, name });
        contactNames.set(peer, name);
      }
      renamingPeer = null;
      render();
    }

    async function sendCurrent() {
      const input = document.getElementById("send-text") as HTMLInputElement | null;
      if (!input || !activeRoom) return;
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      await invoke("send_message", { room: activeRoom, text });
      await invoke("record_message", {
        room: activeRoom, sender: myId, body: text,
        epoch: messages.at(-1)?.epoch ?? 1, outgoing: true,
      });
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
