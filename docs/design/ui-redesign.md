# OnlyHumans — UI/UX & Interaction Redesign Proposal

Status: PROPOSAL (v1, 2026-09-19). Nothing here is implemented yet; every
phase is shippable on its own through the normal release pipeline.
Grounded in the shipped 1.0.12 UI, live testing observations, and the
product's actual usage: a small community of friends on desktop (Windows
first, Linux, Android later), invited by word of mouth, mostly
non-technical, who value privacy and honesty.

---

## 1. Audit — what the current UI gets wrong

Evidence-based, from live sessions with real users (not guesses):

1. **Three scattered ways to move between rooms.** `✎ code` (pencil on
   the room card), `+ new room` (top-left action), and `log off` live in
   three different places with three different mental models. Users
   demonstrably confused them (recorded: "pressing ✎ code showed two
   windows"; the ✎ toast had to be rewritten to explain itself).
2. **Two action zones with no logic.** Global actions (`+ new room`,
   `log off`) sit top-left under the status line; room actions (rotate,
   clear, reset) sit in the chat titlebar; identity actions are nowhere.
   Scope (identity / room / app) is never communicated by placement.
3. **The sidebar mixes three taxonomies.** "THE ROOM" (navigation +
   status), "PRIVATE CHATS" (conversations), "PEOPLE IN THE ROOM"
   (actors). The room card and the people list describe the same thing
   twice; clicking a person silently starts a DM (mis-tap risk).
4. **Trust is invisible.** The site claims E2EE; the app never shows it.
   The only live trust signal is the site-link dot. Epoch, delivery
   path (direct vs. via site), and room sealing are invisible or
   text-only.
5. **Engineer vocabulary and anxious waiting.** "looking for the room…
   47s" with a ticking counter reads as a hang. States are honest but
   narrated in protocol terms ("founding", "epoch", "sealed").
6. **Dense, cold visuals.** 11px labels, five accent hues with ad-hoc
   semantics, no motion language, no warmth — for a product called
   *OnlyHumans*. First-run solo state ("1 member", empty chat) teaches
   nothing.
7. **HID gaps.** No visible keyboard map, no message actions (copy),
   no reduced-motion policy, Escape closes modals (undiscoverable),
   composer Enter/Shift+Enter unexplained, focus not managed after
   modal close, fixed 230px sidebar with no breakpoint story for the
   Android future.

The website is structurally sound but: five equal feature cards (no
hierarchy), a text-wall "How it works", no FAQ, no honest security page,
no OS-detected download, gallery without a narrative, and no changelog
despite shipping constantly.

---

## 2. North star

Three principles, decided once, applied everywhere:

- **P1 — One home per intent.** Anything a user wants to do has exactly
  one obvious home: Rooms live in the Room switcher, You live in the
  identity menu, People live in the sidebar. Never two doors to the
  same room (the 3-flows problem dies here).
- **P2 — Calm trust.** The UI doesn't shout "ENCRYPTED" — it shows
  verifiable, quiet signals where they matter: per-message path
  (direct / via site), per-person presence, room generation (epoch),
  sealed-state. Trust is a status, not a badge farm.
- **P3 — Say it human.** Status copy narrates in human sentences
  ("Finding the room — first join can take a minute"), never protocol
  jargon. Every wait state sets an expectation and every empty state
  teaches the next action.

Voice: plain, warm, honest about limitations (already the product's
ethos — extend it to the pixels).

---

## 3. App — new layout

### 3.1 Main window (desktop ≥ 900px)

```
┌────────────────────────────────────────────────────────────────────────┐
│ ◆ OnlyHumans   [ ⌂ Main room  ▾ ]                     ◉ aurora ▾  ● L │ A
├──────────────┬─────────────────────────────────────────────────────────┤
│ PEOPLE (4)   │  ⌂ Main room                          public · e2e · g1 │ B
│              │  everyone with the app lands here                       │
│ ● aurora     │ ┌─────────────────────────────────────────────────────┐ │
│   you·host   │ │                                                     │ │
│ ● bro        │ │   bro · 14:02                                       │ │
│   online     │ │   ▐ anyone else getting the counter on the site? ▌  │ │
│ ● dana       │ │                                                     │ │
│   via site ⇄ │ │              ▐ yeah, it's live ▌          aurora·14:03│ │
│   offline    │ │                                                     │ │
│ ● ed  offline│ │                                                     │ │
│              │ └─────────────────────────────────────────────────────┘ │
│ PRIVATE (1)  │  ⇄ dana is offline — this message will wait sealed on  │
│ ⇄ dana    2  │     the site and arrive when they're back              │
│              │ ┌────────────────────────────────────────┐ ┌─────────┐ │
│              │ │ message the room…            ⏎ send    │ │  Send   │ │
│              │ └────────────────────────────────────────┘ └─────────┘ │
└──────────────┴─────────────────────────────────────────────────────────┘
  A = command bar: brand · ROOM SWITCHER · identity menu · site-link (● L = live)
  B = room header: title, subtitle, pills (public/code, e2e, generation)
```

**Command bar (A).** Three zones, three scopes, in reading order:
1. Brand mark (logo + wordmark) — app scope.
2. **Room switcher** `[ ⌂ Main room ▾ ]` — THE fix for principle P1.
   Opens a menu: Main room, each code room (name + code word chip),
   separator, "New room…". Replaces `✎ code`, `+ new room`, and the
   room card entirely. The current room is always visible in the bar —
   you always know where you are.
3. **Identity menu** `◉ aurora ▾` — avatar + name; menu: Rename, Log
   off, About (version, room id, shortcuts). `log off` finally lives
   with the person, not next to the room controls.
4. **Site-link dot** stays in the bar (right-most): green = counted on
   the site, tooltip with live count (already shipped, keep).

**Sidebar = People + Private.** One taxonomy per section:
- `PEOPLE (n)` — everyone in the current room. Row = avatar, name,
  relation line (`you · host`, `online`, `via site ⇄`, `offline`),
  host ring on the host's avatar. Click = select (nothing scary
  happens); a hover-revealed `⇄` chip (or double-click) opens/starts
  the private chat. Kills the mis-tap-starts-a-DM risk.
- `PRIVATE (n)` — open DM conversations with unread count. Same click
  target as today. Section hidden entirely when none (first-run
  sidebar is just PEOPLE — one less empty label).

**Room header (B).** Title + one-line subtitle ("everyone with the app
lands here" / "only people with the code word ‘nightmarket'"), then a
pill row: `public`/`code room` (amber), `e2e` (with lock glyph, tooltip:
"messages are sealed on your device — the site never sees them"),
`g3` generation chip (tooltip: "room key generation — rotates on host
action"). **Room actions move into an overflow `⋯` menu** (Rotate key,
Clear history, Reset room) — destructive/technical actions shouldn't be
always-on buttons; host-only ones marked with a host glyph.

**Message list.**
- Keep colored-initial avatars and per-sender hue labels (they work).
- **Delivery path is visible:** messages delivered via the site mailbox
  get a tiny `⇄ site` marker in their meta line (honest signal of the
  path taken — P2). Direct = no marker (default must stay quiet).
- Timestamps on hover; message hover reveals copy affordance (copy
  text, copy sender name).
- System narration as centered quiet lines: "orion joined · 14:01",
  "key rotated to generation 2 · 14:05" — turns invisible events into
  a readable room history.
- Auto-scroll with a "↓ new messages" pill when the user scrolled up.

**Pending strip → inline expectation.** The offline notice moves to a
single calm line above the composer (as wired above), with the ⇄ glyph
matching the mailbox path. While sending via site: the composer stays
enabled; the sent bubble shows `… waiting on site` → clears on ack.

**Empty states (P3):**
- Solo main room: "You're the first here. Every person who opens the
  app lands in this room — send a message to say hi, or start a code
  room to meet one specific friend." + [Copy invite words] (see 3.4).
- Empty code room: "Nobody else has used ‘nightmarket' yet. They will
  land here the moment they type the same word."
- New DM: "This is just the two of you. Messages vanish when you both
  leave."

### 3.2 Welcome gate (first run / log off)

Keep it as one focused card (it's the best screen we have), with two
additions:

```
        ◆  OnlyHumans
   Chat that never passes through a server.

   your name            [ aurora          ]
   room code (optional) [ nightmarket     ]
   [ Enter the room ]

   Leave the code empty to land in the room everyone
   shares. Type a word, and you'll meet only people
   who type the same word — same word, same room.
```

- Live presence under the button: "● 3 humans online right now" (same
  public counter as the site — instant social proof at the exact
  moment of hesitation).
- Name field validates as you type (green check when non-empty);
  button disabled until valid (removes the error-message round trip).

### 3.3 Waiting states (the join ticker, humanized)

Replace elapsed-seconds counters with a stepped narrative + slim
progress bar (indeterminate, 3 stages):

1. "Finding the room…" (sub: "usually a few seconds; first search can
   take up to a minute")
2. "Knocking — proving you know the way in…"
3. "Getting the room key…"

No numbers counting up (anxiety), no protocol words. If a stage
exceeds its expectation, the sub-line updates honestly ("still
looking — the room's host may be offline; messages will use the site
relay when they return"). Sealed room: "This room closed its door
after a key rotation — only current members can get in."

### 3.4 Invite affordance (new, small, high value)

The product spreads by word of mouth; the UI should carry the words.
In the room overflow menu and the solo-empty state: **"Invite to this
room"** — copies a plain sentence: "Get OnlyHumans at
onlyhumans.deepflux.space — open it, enter any name, and use the code
word: nightmarket" (main room: same without the code). One click, the
whole onboarding story for a friend.

### 3.5 HID / interaction spec

**Keyboard map** (show it in `You ▾ → About → Shortcuts`; hints in
placeholder/tooltips):
- `Enter` send · `Shift+Enter` newline · `Esc` close modal/menu, then
  clear room filter
- `Ctrl/Cmd+K` room switcher (palette-style, type to filter rooms,
  `↓↑ Enter`, `Alt+N` new room)
- `Ctrl/Cmd+F` focus composer (`F` follows focus — message-first app)
- `Alt+1..9` open nth person's private chat; `Alt+0` main room
- `Ctrl/Cmd+Shift+C` copy last received message
- All menus: arrow keys + Enter + Esc; focus trapped in modals, returns
  to the invoker on close.

**Pointer:**
- 40×40px minimum targets on everything clickable in the sidebar and
  pills; room switcher ≥ 44px tall (touch-ready for Android).
- Hover states: 120ms fade-in, never the only signal (focus ring also
  shows).
- Two-click confirm pattern stays for Clear history / Rotate (it's
  good HID); Rotate keeps the modal (irreversible + protocol-visible).

**Motion:** 150–200ms ease-out for panels/menus; message entry 120ms
rise+fade; the site-link dot keeps its 2.4s pulse; **everything honors
`prefers-reduced-motion`** (pulses and slides become opacity-only).

**Sound/notifications:** keep OS toasts metadata-only; add an
in-app unread badge (sidebar PRIVATE count + taskbar overlay badge on
Windows via window badge when supported).

**Accessibility floor:** WCAG AA contrast on all text (current muted
`#7d95a0` on `#14202a` passes ~4.6:1 — keep, but bump 11px labels to
12px minimum); visible 2px focus rings (teal) on ALL focusables;
aria-labels on icon-only buttons (`✎` died with the redesign; `⇄`,
`⋯`, `●` all get labels); reduced-motion + high-contrast tested;
screen-reader announcement for incoming messages when unfocused.

### 3.6 Responsive / Android groundwork

Define the breakpoints NOW so the redesign doesn't paint us in:
- ≥900px: layout above.
- 600–900: sidebar collapses to an icon rail (avatars with presence
  dots); room header drops subtitle.
- <600 (Android portrait): no sidebar — People live behind a
  `👥` sheet; command bar becomes: brand · room ▾ · avatar · ●;
  composer docked above keyboard with send on the virtual Enter.

### 3.7 Visual direction

Evolution, not revolution: keep the dark teal world (it's the brand,
it photographs well, users know it), but systematize and warm it:

- **One accent system, five fixed meanings** (see tokens, §5). Teal =
  app/brand/public, violet = private, green = live/site link, amber =
  code rooms/waiting, red = destructive only.
- Type scale: 12 / 13 / 14 / 16 / 20 / 28 (kill the 11px).
- Surfaces: two elevations (panel, panel-raised) + hairline borders;
  kill nested boxes (chat area becomes ONE surface, bubbles sit on it).
- Radius scale: 8 (cards/modals) / 999 (pills/dots) / 6 (inputs).
- One shadow token (subtle, for modals only). Dark UIs don't need
  shadow stacks.
- Warmth: room-subtitle + system narration lines use the humanist
  sentence copy; brand glyph appears in empty states (a small moment
  of delight, e.g. the mesh icon's nodes pulse once when someone
  joins).

---

## 4. Website — new structure

Keep it one page (it converts), restructure top-to-bottom into a
narrative with a sticky nav:

```
 nav: ◆ OnlyHumans · [See it work] [How it works] [Security] [FAQ]     ● N online
 HERO: "Chat that never passes through a server."
       + live counter AS the headline proof (big, animated count-in):
         "● N humans are in the room right now" (0 → shows "be the
          first" state, honest)
       + [Download for Windows] (OS-detected: swap label/file for the
          visitor's OS; both others one click away) + size/version meta
 PROOF STRIP: 3 numbers, not 5 cards — "0 servers read your words" /
       "2 platforms, one room" / "E2E sealed on your device"
 SEE IT WORK: the gallery, but as a 3-step story with captions:
       1. First run (gate)  2. The room (host)  3. Same code, second
       machine (guest) — click-through, captions teach the flow
 HOW IT WORKS: the existing mesh SVG becomes an interactive 3-layer
       diagram (toggle: FIND / TALK / FALLBACK):
       FIND  — signed, expiring address records on this site
       TALK  — direct device-to-device, sealed end-to-end
       FALLBACK — sealed envelopes wait on the site when two people
       can't connect, and drain when they're back
 SECURITY (new page/section): the honest graded threat model the
       product already lives by — what's protected, what's visible to
       the hub (metadata, honestly listed), what's out of scope
       (device compromise). Written for the friend who asks
       "is this actually safe?"
 FAQ (new): 6–8 real questions (Do I need an account? Where do
       messages live? What if the site disappears? Who can join the
       main room? What's a code room? Does it work on my phone?)
 CHANGELOG (new): one line per release, newest first — we ship
       constantly; show it (also builds trust for the version number
       in the installer)
 footer: brand, source link, "no trackers, no cookies, no third-party
       requests" (already true — say it)
```

Specifics:
- **OS detection** (`navigator.userAgent` + platform) reorders the
  primary button; wrong-OS visitors still see both under "also
  available for".
- The hero counter and the app's site-link dot use the SAME visual
  language (green dot + count) — site and app mirror each other, which
  is literally the feature.
- Security section gets the graded model in three tiers with icons
  (✔ protected / ◐ visible-to-your-hub-metadata / ✕ out of scope) —
  matches the user's standing requirement for honest graded threat
  models.
- Keep: self-hosted everything, no CDN fonts, the mesh illustration,
  the real screenshots (refreshed per release — standing rule).
- Add structured data (SoftwareApplication) for clean search results.

---

## 5. Design tokens (single source, app + site)

```css
/* color — semantic, frozen meanings */
--bg:        #0e1518      /* app background            */
--panel:     #14202a      /* raised surface            */
--line:      #1f3038      /* hairlines                 */
--ink:       #d8e4e8      /* primary text              */
--muted:     #8fa6b0      /* secondary text (raised from #7d95a0) */
--teal:      #17a2b8      /* brand · public · focus    */
--violet:    #8b5cf6      /* private (DMs)             */
--green:     #22c55e      /* live · site link · online */
--amber:     #f59e0b      /* code rooms · waiting      */
--red:       #c0564f      /* destructive only          */

/* type */
--fs-xs: 12px; --fs-s: 13px; --fs-m: 14px; --fs-l: 16px;
--fs-xl: 20px; --fs-hero: clamp(2rem, 5vw, 3.1rem)

/* space (4px base) · radius · motion */
--sp-1..6: 4/8/12/16/24/32px
--r-card: 8px; --r-pill: 999px; --r-input: 6px
--t-fast: 120ms; --t-ui: 180ms; ease: cubic-bezier(.2,.7,.3,1)
```

Both surfaces import the same token block (the site inlines it; the
app's app.css adopts it verbatim) so they can never drift apart.

---

## 6. Rollout plan (each phase independently shippable)

**Phase 0 — Tokens & consistency (zero layout risk).**
Adopt tokens in app.css; raise 11px→12px; unify buttons/pills; focus
rings everywhere; reduced-motion guards. Invisible-by-design diff.

**Phase 1 — The command bar (kills the 3-flows problem).**
Room switcher + identity menu; delete `✎ code` / `+ new room` /
`log off` buttons and the room card; sidebar becomes PEOPLE + PRIVATE.
Biggest UX win, contained blast radius.

**Phase 2 — Trust & narration.**
Message-path markers (⇄ site), e2e/generation pills, system narration
lines, humanized wait states, empty states, invite-affordance.

**Phase 3 — Website restructure.**
Sticky nav, OS-detected download, proof strip, 3-step gallery, layered
how-it-works, Security + FAQ + Changelog.

**Phase 4 — HID depth & Android groundwork.**
Keyboard map + shortcuts, focus management, icon rail breakpoint,
copy/message actions, badge counts.

Verification at every phase: isolated two-instance code-room runs
(PrintWindow captures), gallery refresh, and the user's own live test
(standing workflow).
```
