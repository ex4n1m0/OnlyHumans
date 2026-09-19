# OnlyHumans hub

The website and rendezvous hub for **OnlyHumans** — a peer-to-peer encrypted
chat app where messages travel straight between devices and never pass
through a server that could read them.

- **Site:** <https://onlyhumans.deepflux.space>
- **Source (default branch `main`):** <https://github.com/ex4n1m0/OnlyHumans/tree/main>

This repository contains two things:

1. **`index.html`** — the single-page site (no framework, no trackers, no
   third-party requests): download buttons for the Windows/Linux installers,
   screenshots, a "how it works" tour, a graded security model, FAQ, and a
   changelog.
2. **`api/`** — the hub the desktop app talks to: Vercel serverless functions
   backed by Upstash Redis (REST, no SDK). The hub is deliberately
   **untrusted storage**: it verifies signatures before storing bytes it
   cannot read, every record is short-lived, and clients re-verify
   everything themselves.

## What the hub stores (and what it never sees)

| Record | Key | TTL | Purpose |
| --- | --- | --- | --- |
| Peer registration | `peer:<peerId>` | 300 s | Signed `{peer → addresses}` directory so peers can find each other |
| Room host pointer | `room:<roomId>` | 300 s | Who currently hosts a room; first writer wins the election |
| Fallback mailbox | `inbox:<peerId>` | 24 h | Sealed, signed envelopes for peers that can't connect directly |
| Presence tokens | `presence` (ZSET) | 300 s | Anonymous "an app is online" counter for the site's live pill |

Messages are sealed on the members' devices with per-message keys. The hub
only ever holds addresses and ciphertext envelopes — never a word it could
read, forge, or alter.

## API

| Endpoint | Method | Notes |
| --- | --- | --- |
| `/api/reg` | PUT | Publish signed addresses. Ed25519 over `OH1-reg\|…`, ±60 s timestamp, 30 s per-peer rate limit. Returns the observed IP (mini-STUN, advisory only, never stored). |
| `/api/lookup/<peerId>` | GET | Fetch a peer's latest signed registration. 404 when expired. |
| `/api/room` | PUT | Claim hosting of a room (`OH1-room\|…`). First writer wins (Redis `NX`); 409 returns the live record. |
| `/api/room/<roomId>` | GET | Fetch the current host record of a room. |
| `/api/inbox` | PUT | Store 1–16 sealed envelopes per call (`OH1-mail-v1\|…`), signature verified against the sender's included libp2p key; 4 s per-sender throttle; each inbox keeps its last 32 items. |
| `/api/inbox/<peerId>` | GET | Destructively drain a mailbox. Requires an ownership signature (`OH1-drain-v1\|…`) verified against the peer's *registered* key. |
| `/api/presence` | GET/POST | Anonymous live counter. The token is a random hex string minted per app session — no peer id, no name, no room. |

All signatures are Ed25519, verified with zero dependencies: the raw 32-byte
key is wrapped in a fixed SPKI prefix and checked with `node:crypto`, and the
libp2p `PublicKey` protobuf is minimally decoded in place
(`api/_mail-crypto.ts`).

## Deploying

The project deploys on Vercel as-is (`vercel.json` only enables clean URLs).
Set two environment variables pointing at an Upstash Redis database:

```
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

Without them, the API answers `503 hub storage not configured` and the site
still renders — it just shows no live counter.

## Releases

`version.json` drives the site's download buttons (version, sizes, deploy
date, file paths); the installers themselves live in `download/`
(`.exe` for Windows, `.AppImage` and `.deb` for Linux). To ship a release:
drop the new artifacts into `download/`, update `version.json` and the
fallback `href`s in `index.html`, and add a changelog line on the site.

## Honest limits

The site's security page says it plainly, and so does this README: a
compromised device defeats everything, guessable code words are not access
control, and metadata-resistant routing is not implemented. The hub — and
anyone observing it — can learn which peer ids exist, who hosts which room,
and the sender/recipient/timing/size of fallback envelopes. For the full
graded model see the [security section](https://onlyhumans.deepflux.space#security).
