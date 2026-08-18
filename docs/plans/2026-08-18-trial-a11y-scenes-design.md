# Design: Field-trial readiness, low-vision accessibility, auto scene detection

**Date:** 2026-08-18 · **Status:** validated with Lan (brainstorming session) · **Scope:** three features, one release

## Context

The app goes to a small unsupervised field trial: **3–8 pairs**, each one low-vision/blind
creator + one sighted helper (family/friend), sharing a project, using their own devices
over days/weeks with no researcher present. The app must therefore be provisionable,
robust, observable (research logs), usable by low-vision participants, and its scene
segmentation should follow content rather than a fixed clock.

Current anchors:

- Auth: email allowlist + password; projects joined via 4-digit codes.
- Segmentation: `planSegments(duration, video.segment_length_seconds)` — fixed windows
  (`server/src/services/segmentation.js`, called at `server/src/services/processVideo.js:65`).
- Accessibility: `web/src/contexts/AccessibilityContext.jsx` has textSize (S/M/L), TTS +
  speech rate; a `highContrast` state was previously stripped from the probe.
- Design system: "Calm Clinical" — all colors are CSS variables in `@theme`
  (`web/src/index.css`); warm off-white canvas, white cards.
- Deploy: Vercel (web, from main), Railway (server), Supabase free tier
  (**auto-pauses after ~1 week idle** — known trial risk).

## 1. Trial structure

**Onboarding — researcher pre-provisions everything.** No signup-flow changes.

- `scripts/provision-pair.mjs`: creates one trial unit per run — two accounts
  (creator + helper) with word-based passwords (`mango-river-42` style), one shared
  project, both memberships with roles. Drives the existing auth via the Supabase admin
  API (service-role key). Prints a per-participant credentials sheet (URL, email,
  password) suitable for a large-print handout.
- `scripts/reset-participant.mjs`: reset a forgotten password.

**Robustness for unsupervised weeks:**

1. **Supabase auto-pause** (biggest trial risk): GitHub Actions cron hits a new
   `/health/db` endpoint daily (touches the DB so the project never idles a week).
   Recommendation: additionally consider Supabase Pro for the trial months.
2. **Friendly failure states**: one shared error component shown when API/DB is
   unreachable — "The study system is having a problem — please tell Lan" with a mailto
   link — wired into sign-in and the API client, replacing generic errors.

**Not doing (YAGNI):** self-serve signup, researcher admin UI, in-app consent
(consent happens outside the app), multi-study support.

## 2. Interaction logging

**Storage** — migration `0014_events.sql`, one table:
`events(id, created_at, user_id, project_id, event_type, payload jsonb)`.
RLS: authenticated users may **insert only their own** events; no client may
select/update/delete. Reading is researcher-only via service role.

**Two logging paths:**

1. *Client*: `logEvent(type, payload)` util — fire-and-forget insert through the
   existing Supabase client; never throws, never blocks UI.
2. *Server*: routes that already do the heavy work (AI edit, suggestions, render,
   upload processing) insert events with the service role — more reliable than the
   client for these.

**Event vocabulary (~15 types):** `sign_in`, `page_view`, `video_upload`,
`processing_done`, `scene_play`, `scene_focus`, `tts_spoken`, `settings_change`
(theme, text size, speech rate — which themes low-vision participants choose is itself
research data), `ai_edit_request`, `ai_edit_confirm`, `ai_edit_reject`,
`suggestion_shown`, `suggestion_apply`, `suggestion_dismiss`, `render_start`,
`render_complete`, `export_download`.

**Decision (Lan approved):** `ai_edit_request` payloads include the participant's
prompt text — core analysis data, covered by study consent.

**Export:** `scripts/export-events.mjs --from <date>` → one combined CSV plus one CSV
per pair, with pair/role columns joined in.

**Not doing:** live dashboard, session replay, client-side batching queues.

## 3. Low-vision accessibility

**Mechanism.** Four theme blocks redefine the *same* CSS variables under
`html[data-theme=…]`; components restyle with no markup changes.

| Theme | Canvas | Ink | Notes |
|---|---|---|---|
| `default` | current warm off-white | current | unchanged — demo/poster look survives |
| `dark` | warm near-black | off-white | teal brand lifted for contrast |
| `hc-dark` | true black | near-white ≥7:1 (AAA) | shadows removed; hairlines → solid 2px borders; focus ring yellow; creator/helper accents brightened |
| `hc-light` | white | pure black | same strong-border treatment; for dark-on-light users |

**Defaulting.** First visit honors OS: `prefers-color-scheme: dark` → Dark;
`prefers-contrast: more` upgrades to the HC variant of that polarity. An explicit
Settings choice always wins and persists. An inline script in `web/index.html` applies
saved theme **and text size** before React mounts (no white flash on load).

**Context & Settings.** `AccessibilityContext` gains `theme` + `SET_THEME`
(generalizing the previously stripped `highContrast`), with storage validation like the
existing fields. Settings page gains a fourth fieldset: four radio cards with mini color
swatch previews, announced via the existing announcer, logged as `settings_change`.

**Text size.** Add **Extra large (24px)** to S/M/L. Tailwind spacing is rem-based so
layouts scale; audit the editor timeline explicitly at 24px.

**Sweep:** audit components for hardcoded colors (role accents, shadows, focus states)
so every theme reads from tokens.

## 4. Auto scene detection

**Integration point.** Replace the `planSegments` call at `processVideo.js:65` with
`detectScenes(sourceFile, duration, opts)` returning the **identical plan shape**
(`id, idx, start_seconds, end_seconds, label, midpoint`) — segment encoding, keyframes,
Gemini clip descriptions, suggestions, AI edit, render plan, and the editor UI stay
untouched. New uploads only; existing videos keep their segments.

**Detection pass.** One extra ffmpeg run per upload: decode-only, downscaled
(`scale=320:-2`), `scdet` filter, cut timestamps parsed from stderr. No x264 encode →
low memory, no OOM exposure.

**Post-processing** (pure, unit-testable):

1. Threshold: `SCENE_THRESHOLD` env, tunable.
2. Merge scenes shorter than `MIN_SCENE_SECONDS` (~3s) into a neighbor.
3. Split scenes longer than `MAX_SCENE_SECONDS` (default = the video's
   `segment_length_seconds`) at fixed intervals — a single-take phone video degrades to
   exactly today's behavior.
4. Cap at `MAX_SCENES` (default 30) by dropping the weakest cuts — cost guard; every
   scene is one Gemini description call.

**Safety.** Zero cuts → fixed windows. ffmpeg error → fixed windows. Detection can
never fail an upload. `AUTO_SCENES=0` reverts entirely (same convention as
`DESCRIBE_FROM_CLIP`).

**Testing.** Unit tests on post-processing math; parser tests against captured ffmpeg
stderr fixtures; `scripts/diag-scenes.mjs` for local runs; e2e with one multi-cut clip
and one single-take clip.

## Decisions log

- Trial format: unsupervised field trial; pairs (low-vision creator + sighted helper), 3–8 pairs.
- Logging: rich interaction logs, CSV export, **no dashboard**; AI-edit prompt text is logged (consented).
- Themes: 4 (default / dark / hc-dark / hc-light), OS-preference initial default.
- Scene detection: ffmpeg `scdet` on the existing Railway server — no new infra
  (Modal/PySceneDetect and Gemini-based detection considered and rejected for trial
  reliability, cost, and timestamp accuracy respectively).
