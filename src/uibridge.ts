// UI bridge: the real Tauri IPC inside the app shell; a scripted fake
// world when the frontend runs in a plain browser (vite dev / preview)
// so the UI can be developed, reviewed, and screenshotted without Rust.
// Production paths are untouched — the mock exists only when the Tauri
// internals are absent.
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type ListenFn = <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;

const inBrowser = typeof window !== "undefined"
  && !(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  && window.location.protocol.startsWith("http");

// ── Browser preview mode ────────────────────────────────────────────
// Query params sculpt the world: ?state=host|member|joining|sealed,
// ?code=1 (code room), ?dm=1 (open a private chat), ?gate=1 (gate only).
function browserInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return Promise.resolve(browserWorld.invoke<T>(cmd, args));
}
function browserListen<T>(_event: string, handler: (event: { payload: T }) => void): Promise<() => void> {
  return Promise.resolve(browserWorld.subscribe(handler as (ev: { payload: unknown }) => void));
}

const browserWorld = makeBrowserWorld();

function makeBrowserWorld() {
  const q = new URLSearchParams(window.location.search);
  const selfId = "12d3koobjselfmockpeeridaaaa";
  const bro = "12d3koobjbromockpeeridbbbbb";
  const dana = "12d3koobjdanamockpeeridccccc";
  const ed = "12d3koobjedmockpeeriddddddd";
  const state = q.get("state") ?? "member";
  const isCode = q.get("code") === "1";
  const isHost = state === "host";
  const roomHex = "3f9c2a77b41d05e6a2c8841d0b7e5f33";
  const now = Date.now();
  const min = 60_000;

  const memberList = [
    { peer: selfId, name: "aurora" },
    { peer: bro, name: "bro" },
    { peer: dana, name: "dana" },
    { peer: ed, name: "" },
  ];

  const canned = [
    { sender: bro, body: "anyone else getting the green site dot?", ts: now - 9 * min },
    { sender: selfId, body: "yeah — it means the public counter can see the app", ts: now - 8 * min, outgoing: true },
    { sender: bro, body: "this one arrived while I was offline — through the site's mailbox", ts: now - 6 * min, viaSite: true },
    { sender: dana, body: "just landed — the room healed itself after the split this morning", ts: now - 4 * min },
  ];

  function invoke<T>(cmd: string, _args?: Record<string, unknown>): T {
    switch (cmd) {
      case "has_username": return (q.get("gate") !== "1") as T;
      case "my_id": return selfId as T;
      case "username": return "aurora" as T;
      case "app_version": return "1.0.15-dev" as T;
      case "contacts": return [{ peer_id: dana, name: "dana" }] as T;
      case "has_passcode": return isCode as T;
      case "passcode": return (isCode ? "nightmarket" : null) as T;
      case "messages": return canned.map((m, i) => ({
        id: i, sender: m.sender, body: m.body, ts: m.ts,
        outgoing: !!m.outgoing, epoch: 3, viaSite: m.viaSite,
      })) as T;
      case "room_snapshot": return (state === "joining" || state === "sealed" ? null : {
        status: isHost ? "hosting" : "connected",
        room: roomHex,
        host: isHost ? selfId : bro,
        weAreHost: isHost,
        epoch: 3,
        members: memberList,
        updatedMs: now,
      }) as T;
      case "request_state": return undefined as T;
      default:
        console.info(`[uibridge] mock invoke: ${cmd}`, _args);
        return undefined as T;
    }
  }

  const events: Array<{ delay: number; payload: Record<string, unknown> }> = [];
  if (state === "sealed") {
    events.push({ delay: 200, payload: { kind: "joinStatus", status: "sealed" } });
  } else if (state !== "joining") {
    events.push(
      { delay: 300, payload: { kind: "joinStatus", status: isHost ? "hosting" : "connected" } },
      { delay: 500, payload: { kind: "roomReady", room: roomHex, peer: isHost ? selfId : bro, weAreHost: isHost, epoch: 3 } },
      { delay: 700, payload: { kind: "membersChanged", room: roomHex, members: memberList } },
      { delay: 900, payload: { kind: "connectionStateChanged", peer: bro, connected: true } },
      { delay: 1100, payload: { kind: "presence", linked: true, online: 3 } },
    );
    if (isHost) {
      events.push({ delay: 1400, payload: { kind: "message", room: roomHex, sender: bro, body: "fresh message while you host — narration below", epoch: 3 } });
    }
    if (q.get("dm") === "1") {
      const dmHex = "aa99887766554433221100ffeeddccbba";
      events.push(
        { delay: 1600, payload: { kind: "roomReady", room: dmHex, peer: dana, weAreHost: false, epoch: 1 } },
        { delay: 1800, payload: { kind: "connectionStateChanged", peer: dana, connected: false } },
        { delay: 2000, payload: { kind: "message", room: dmHex, sender: dana, body: "hey — this one is private, violet and all", epoch: 1, viaSite: true } },
      );
    }
  }

  const listeners: Array<(ev: { payload: unknown }) => void> = [];
  let started = false;
  function subscribe(handler: (ev: { payload: unknown }) => void): () => void {
    listeners.push(handler);
    if (!started) {
      started = true;
      for (const e of events) {
        window.setTimeout(() => listeners.forEach((l) => l({ payload: e.payload })), e.delay);
      }
    }
    return () => { /* no-op unlisten */ };
  }

  console.info("[uibridge] browser preview — scripted world active", { state, code: isCode, dm: q.get("dm") === "1", gate: q.get("gate") === "1" });
  return { invoke, subscribe };
}

export const invoke: InvokeFn = inBrowser ? browserInvoke : tauriInvoke;
export const listen: ListenFn = inBrowser ? browserListen : tauriListen;
