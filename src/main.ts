// OnlyHumans UI — one global room. Everyone who runs the app joins the
// same room automatically; the first ever member founded it.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface ChatMessage { id: number; sender: string; body: string; ts: number; outgoing: boolean; epoch: number }
interface Contact { peer_id: string; name: string }
type NodeEvent =
  | { kind: "listening"; addr: string }
  | { kind: "joinStatus"; status: string }
  | { kind: "roomReady"; room: string; peer: string; weAreHost: boolean; epoch: number }
  | { kind: "message"; room: string; sender: string; body: string; epoch: number }
  | { kind: "membersChanged"; room: string; members: string[] }
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
  const myId: string = await invoke("my_id");
  const contactNames = new Map<string, string>();
  for (const c of await invoke<Contact[]>("contacts")) contactNames.set(c.peer_id, c.name);
  const displayName = (peer: string) => contactNames.get(peer) ?? short(peer);

  let room: string | null = null;
  let isHost = false;
  let epoch = 1;
  let status = "connecting";
  let hostPeer = "";
  let members: string[] = [];
  let renamingPeer: string | null = null;
  let messages: ChatMessage[] = [];

  render();
  await invoke("request_state").catch(() => {});
  await listen<NodeEvent>("node-event", (ev) => {
    void onNodeEvent(ev.payload);
  });

  async function onNodeEvent(p: NodeEvent) {
    switch (p.kind) {
      case "message": {
        await invoke("record_message", {
          room: p.room, sender: p.sender, body: p.body, epoch: p.epoch,
        });
        if (p.room === room || room === null) {
          room = p.room;
          await refreshMessages();
        } else {
          toast(`New message from ${displayName(p.sender)}`);
        }
        render();
        break;
      }
      case "roomReady": {
        room = p.room;
        isHost = p.weAreHost;
        hostPeer = p.peer;
        epoch = p.epoch;
        status = p.weAreHost ? "hosting" : "connected";
        await refreshMessages();
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
        <span class="myid" title="click to copy — your ID">${myId}</span>
        <button id="copy-id">Copy ID</button>
      </header>
      <main>
        <div class="sidebar">
          <div class="roominfo">
            <div class="status">${statusLine()}</div>
            <div class="members-n">${members.length || (ready ? 1 : 0)} member${(members.length || 1) === 1 ? "" : "s"}</div>
          </div>
          <ul>
            ${members.map((m) => `
              <li data-peer="${m}" class="${m === hostPeer ? "ishost" : ""}" title="${m}">
                <i class="dot ${m === myId || connectedPeers.has(m) ? "on" : "off"}"></i>
                <span>${m === myId ? "you" : escapeHtml(displayName(m))}</span>
                ${m === hostPeer ? '<span class="peer">host</span>' : ""}
              </li>`).join("")}
          </ul>
        </div>
        ${ready ? `
        <div class="chat">
          <div class="titlebar">
            <span class="status">${statusLine()} · key epoch ${epoch}</span>
            ${isHost ? '<button id="rotate">Rotate key</button>' : ""}
          </div>
          <div class="messages" id="msgs">
            ${messages.map((m) => `
              <div class="msg ${m.outgoing ? "out" : "in"}">
                ${escapeHtml(m.body)}
                <div class="meta">${m.outgoing ? "you" : escapeHtml(displayName(m.sender))} · ${fmtTime(m.ts)} · e${m.epoch}</div>
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

    document.getElementById("copy-id")?.addEventListener("click", () => {
      navigator.clipboard.writeText(myId);
      toast("ID copied");
    });
    document.querySelector<HTMLElement>(".myid")?.addEventListener("click", () => {
      navigator.clipboard.writeText(myId);
      toast("ID copied");
    });

    // Member rows: click to rename (adds a contact name).
    document.querySelectorAll<HTMLElement>(".sidebar li").forEach((li) => {
      li.addEventListener("click", () => {
        const peer = li.dataset.peer!;
        if (peer === myId) return;
        renamingPeer = peer;
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

    async function sendCurrent() {
      const input = document.getElementById("send-text") as HTMLInputElement | null;
      if (!input || !room) return;
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      await invoke("send_message", { text });
      await invoke("record_message", {
        room, sender: myId, body: text,
        epoch, outgoing: true,
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
