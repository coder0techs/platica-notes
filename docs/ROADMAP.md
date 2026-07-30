# Plática Notes — Roadmap (post-v1 feature ideas)

> Idea backlog for **Google Meet only**, for development **after** the Chrome
> Web Store v1 launch. Nothing here is committed to code yet — this is a
> brainstorming capture, not a spec. Each "Near-term" item still needs a proper
> design pass (open questions are listed) before it becomes a plan.
>
> **Captured:** 2026-06-19; extended 2026-06-29.
>
> **Coordination note:** the v2 output-file format (YAML front matter + turn grid,
> injection-safe via `yamlScalar`/`inlineText`) has **landed** in
> `src/background/format.ts`. The new "Output format & filename polish" item below
> is a refinement pass on top of it — preserve the injection-safety invariant and
> `tests/format.test.ts` coverage when touching it.

---

## Guiding principle (the product fork)

Today Plática Notes is a **capture + export** tool: a faithful transcript lands
as a local `.md`, 100% local, zero network. That is the USP and what keeps the
Web Store review trivially truthful.

Most of the *value* in this category (Otter / Tactiq / Fireflies) is not the
transcript but what is **derived** from it — summaries, action items, search,
Q&A. All of that needs an LLM, which collides with "zero network".

The resolution that does **not** break the local-only promise: **prompt-handoff**.
A "Summary" action does not call an API — it puts a ready-made prompt + the
transcript on the clipboard (or opens claude.ai with the input prefilled) and the
user pastes it into the assistant they already use. A local LLM via Ollama on
`localhost` is the alternative for a fully-offline path. Keep this principle in
mind for every feature: prefer the design that keeps egress at zero.

---

## Sequencing

1. **Finish the store blockers first** (screenshots, hosted privacy policy, store
   icon) and **freeze v1**. Do not grow scope before submitting, or the launch
   slips indefinitely.
2. Then take v2 features below, one design pass at a time.
3. The **only** candidate worth considering pre-store is the *capture-failure
   toast* (see Multilingual backlog) — it hardens base reliability rather than
   adding surface area.

---

## Near-term (explicitly requested 2026-06-19)

> **Status:** all three shipped 2026-06-19 on `main` (commits `4bb1bba`,
> `db0055f`, `4befe32`, `c37f41e`). Kept here for the design rationale and the
> open questions that were resolved.

### 1. In-meeting notes, bookmarks & panel search — ✅ DONE

**What.** Let the user annotate a live meeting from inside the Meet window:
- **Bookmark a moment** via a hotkey — drops a timestamped marker.
- **Manual note** — type a short note pinned to the current point in the
  timeline (the user's own thought, not a caption).
- **Live search** inside the floating transcript panel — find a word said earlier
  without leaving the call.

**Why.** In long meetings the most valuable artifact is "what mattered when". This
is high-convenience, fully local, and carries no architectural risk (it does not
touch the capture or network model).

**Behaviour sketch.**
- Bookmarks/notes are captured into the active session alongside the transcript,
  so they survive reload/orphan-recovery (same durability path as `transcript`).
- They render into the saved file: either inline markers at their timestamp, or a
  dedicated `NOTES` / `BOOKMARKS` section. Decide in design.
- Panel search is pure client-side filter/highlight over the in-memory transcript.

**Open questions.**
- Where do notes/bookmarks render in the `.md` — inline at timestamp vs a separate
  section at the top (TL;DR-style) vs both?
- Hotkey choice that does not clash with Meet's own shortcuts; configurable?
- Does a bookmark need an optional label, or is a bare timestamp marker enough?
- Are manual notes private to the user even in a non-private meeting? (They are
  the user's text, never sent anywhere, so this is just about file placement.)

**Touches.** `meet.ts` (panel UI + hotkey), `feed.ts`/session types (carry
notes), **`format.ts` (render)** — *blocked on the parallel format change*.

**Risk.** Low. No network, no capture-path changes.

---

### 2. Default caption language as a sticky setting (vs per-meeting language) — ✅ DONE

**What.** Split the single caption-language value into two concepts:
- **Default language** — a persisted setting. Every **new** meeting starts in this
  language, regardless of what was manually selected in a previous meeting.
- **Per-meeting (active) language** — the in-meeting pill. Changing it
  resubscribes **only the current meeting** and is **ephemeral**: it does **not**
  overwrite the persisted default.
- **Fresh-install default = English** (`en-US`), not the current `ru-RU`. English
  is the right out-of-box default for a store audience; a user can still pick
  Russian or any other supported language.

**Why.** Current behaviour conflates the two: the pill/popup value is the single
`Settings.captionLanguage`, so a manual mid-meeting switch sticks to the next
meeting. For a multilingual day (e.g. ru / en / es) the desired model is "always
start from my default, override just-for-now when a specific call is in another
language".

**Behaviour sketch.**
- Popup control writes the **default** (sticky).
- The in-meeting pill changes the **active** language only (ephemeral, this
  meeting). It should **not** write back to the persisted default.
- On meeting start, seed `active = default`.

**Open questions.**
- Should the pill show a subtle hint that its change is temporary ("this meeting
  only")?
- Migration: existing users have `captionLanguage` set — keep their value as the
  new default on upgrade (do not silently reset anyone to English; English is
  only the *fresh-install* default).

**Touches.** `shared/` settings + storage (new default vs active split), `meet.ts`
(pill no longer persists), popup `<select>`, manifest/default seeding.

**Risk.** Low–medium. Behavioural change to an existing setting — needs the
migration handled so current users are not reset.

---

### 3. Hide/show toggle for all visible extension UI — ✅ DONE

**What.** A master toggle that hides **every** on-screen element the extension
draws — the top-center pill group (language select + privacy pill), the floating
transcript panel, and any toasts — so the meeting view is completely clean.

**Why.** When sharing the screen, demoing, recording, or when the controls simply
obscure the video, the user wants to collapse everything out of sight.

**Hard requirement.** Hiding the UI must **not** stop capture — the transcript
keeps recording in the background. This is purely a presentation toggle.

**Behaviour sketch.**
- Toggle reachable two ways: a hotkey (so it works when the UI is already hidden)
  and a control in the popup.
- When hidden, optionally leave a single tiny, unobtrusive affordance to bring it
  back — or rely solely on the hotkey + popup. Decide in design.

**Open questions.**
- Hotkey-only vs also a minimal "peek" handle when hidden?
- Does the hidden/shown state persist across meetings, or reset each meeting?
- Auto-hide on detected screen-share? (Nice-to-have, but "magic" — probably out of
  scope for v1 of this feature.)

**Touches.** `meet.ts` (all UI mount points), popup, settings (persisted toggle),
hotkey wiring.

**Risk.** Low, **provided** the capture lifecycle is fully decoupled from UI
visibility (verify the panel/pill being absent never gates capture).

---

## Near-term (captured 2026-06-29)

> Three areas the user flagged to revisit. All are **discuss-first** — none is a
> spec yet; each needs a design pass before code.

### 4. Output format & filename polish — 🔵 DISCUSS

**What.** Revisit the saved `.md`: trim/clarify the YAML front-matter header (drop
fields that carry little human value), consider how "proper Markdown" the body
should read, and tidy the filename scheme.

**Why.** The v2 format is structured and machine-parseable, but parts read as a
machine artifact (front matter, the `RAW CAPTION VERSIONS` dump). The user wants
it to look nicer for a human opening the file, without losing the structure.

**Open questions.**
- What in the front matter is surplus vs load-bearing? Which fields does anything
  downstream actually read?
- Full prose Markdown vs keep the front matter (it is the anti-forgery/parse seam)?
  If we go prettier, do we keep a machine block for tools and a human block on top?
- `RAW CAPTION VERSIONS`: keep / collapse / move to a separate file / make it opt-in?
- Filename scheme: pattern (title + datetime), collision handling, private-folder
  naming, characters to sanitise.

**Touches.** `format.ts` (render), `export.ts` (filename), `tests/format.test.ts`.
**Hard constraint.** Keep `yamlScalar`/`inlineText` injection-safety and its tests.
**Risk.** Low–medium. Pure output change, but it is the product's main artifact.

### 5. Merging repeated visits / sessions of "the same" meeting — 🔵 DISCUSS

**What.** When you accidentally leave and rejoin (same tab, different tab) or sit
in the same call across tabs, optionally fold the pieces into **one** file instead
of N separate ones.

**Why.** Today each visit/tab is its own session → its own file (per-visit by
design). Accidental drops fragment one logical meeting across several files.

**The hard part — identity.** You cannot key purely on the Meet code or title: a
**daily** recurring meeting reuses the *same code and title every day*, so naive
"same code → merge" would glue Monday onto Tuesday. A merge key needs **code +
temporal proximity** (same code within a bounded window, likely same calendar
day), not code alone.

**Open questions.**
- Merge key and window: same code within N minutes? Within the same day? Never
  across days.
- Cross-tab merge needs a **meeting-level** store; today state is per-`tabId`
  session. That is a real structural change.
- Merge mechanics: append with a visit separator? Dedupe overlapping tail? Rewrite
  the visit-1 file in place vs keep separate + a combined view?
- Participants policy interacts with the earlier "per-visit, not cumulative"
  decision — revisit if we merge.
- User-configurable (auto-merge vs always-separate), and how it shows in history.

**Touches.** background session/store (meeting identity beyond `tabId`),
`format.ts`/`export.ts` (append/rewrite), history.
**Risk.** Medium–high. Adds stateful identity + cross-tab coordination; easy to
regress the data-loss guarantees just fixed in 1.6.3.

### 6. Exhaustive end / rejoin / nav scenario coverage — 🔵 DISCUSS

**What.** We hit several meeting-lifecycle bugs (lost-on-toggle, lost-second-visit,
lost-first-on-different-meeting). Enumerate every end/rejoin/nav scenario and make
the handling deliberate rather than discovered bug-by-bug.

**Scenario matrix (current state).**

| # | Scenario (same tab unless noted) | Handling | State |
|---|---|---|---|
| 1 | Click Leave | delegated click listener → flush → finalize | ✅ |
| 2 | Keyboard leave / kicked / host ends (icon gone 3×) | end poller | ✅ |
| 3 | Navigate to a non-meeting URL | poller (path changed) | ✅ |
| 4 | Fast rejoin **same** code, soft-nav | drain-tail grace + re-arm cap | ✅ 1.6.1 |
| 5 | Leave → join **different** code, content script reloaded | stale session finalized before overwrite | ✅ 1.6.3 |
| 6 | Leave → join different code, soft-nav (no reload) | sequential loop finalizes then re-runs | ✅ |
| 7 | Tab closed mid-meeting | `tabs.onRemoved` + orphan recovery | ✅ |
| 8 | SW/browser crash, tab gone | orphan recovery on SW start | ✅ |
| 9 | Reload mid-meeting, same code | resume from snapshot | ✅ |
| 10 | Reload → lands on non-meeting, never returns | session lingers; finalized only on tab close | ⚠️ open |
| 11 | Two tabs, two different meetings | independent per-`tabId` sessions | ✅ |
| 12 | **Same** code in two tabs at once | two sessions → two files | ⚠️ open (→ #5) |
| 13 | Same meeting: leave tab A, rejoin tab B | two files | ⚠️ open (→ #5) |
| 14 | Hidden/background tab (Arc) during 2-tab capture | browser freezes the hidden tab → capture pauses | ⚠️ limitation |
| 15 | Ultra-fast multiple rejoins (< grace) | transcript kept, but roster sometimes empty → "Speaker N" | ⚠️ limitation |
| 16 | Empty session (joined, no captions) | no file; notes-only still kept | ✅ by design |

**Open items distilled.**
- *(O1)* Lingering unfinalized session (#10): add a heartbeat/timeout finalize, or
  accept "materialises on tab close"?
- *(O2)* Duplicate files for one logical meeting (#12/#13) — folds into item 5.
- *(O3)* Hidden-tab freeze (#14) — browser-imposed; needs a different capture
  strategy or is documented as a known limit.
- *(O4)* Roster loss on ultra-fast rejoin (#15) — candidate fix: a roster cache
  keyed by meeting id, shared across visits/tabs.
- *(O5)* The whole lifecycle rests on DOM selectors (`call_end`, meeting title) +
  the path regex. An **RTC "all media-sessions closed" authoritative end signal**
  (already in the backlog) would harden every row above.

**Risk.** Design/reliability work, not a single feature; pairs naturally with the
RTC-fallback backlog item.

---

## Backlog (broader menu, not yet prioritised)

- **Summary / action items via prompt-handoff** — the single highest-value
  feature. One click → clipboard with a structured prompt + transcript, or open
  claude.ai prefilled. Optional Ollama-on-localhost path for fully-offline. Turns
  "a text file" into "a useful meeting outcome" without breaking zero-network.
- **Multilingual hardening:**
  - *Capture-failure toast* — if join fired but no captions arrive within N
    seconds, surface "no captions detected — is the spoken language = your
    setting?". Closes the silent-empty-transcript footgun. (Pre-store candidate.)
  - Auto-detect / one-tap language switch beyond the manual pill.
- **Speaker rename / merge** — post-hoc fix in the history page ("Speaker 3" →
  real name); also covers the short-meeting self-name fallback edge case.
- **History as a real corpus:**
  - Full-text search across all stored meetings (today it is just a list of 30).
  - Pin meetings so retention never evicts them; configurable retention limit.
  - Tags / folders; bulk export / "export all".
- **Structured Markdown output** — timecodes every N minutes, a TL;DR header
  placeholder, collapsible per-speaker blocks. *(Touches `format.ts` — coordinate
  with the parallel format work.)*
- **RTC-based join/leave fallback** — reliability, not a feature:
  today join/leave detection is entirely DOM-selector-dependent and fails silently
  if Meet churns its markup. Route an "all media-sessions closed" RTC signal as an
  authoritative end trigger.

---

## Out of scope (deliberately, for now)

- ~~Other platforms (Zoom / Teams).~~ **Superseded 2026-07-30**: the adapter layer
  was extracted for real and an experimental Zoom skeleton landed behind an optional
  permission — see `docs/superpowers/specs/2026-07-30-platform-adapter-contract-design.md`.
  MS Teams is still out of scope (no chat path is known, and its capture depends on
  the client's internal calling object).
- Any feature that introduces network egress from the extension itself. If
  derived intelligence is wanted, it goes through prompt-handoff or a local LLM,
  per the guiding principle above.
