# Product Phase 1 — Backend Foundation Design

> **Copied 2026-06-12 from the probe repo** (`video-collab-probe/docs/superpowers/specs/`), where the original is kept frozen.
> **Superseded sections:** §2 "Auth: email magic-link" and §4 "Auth & Invite Flow" — replaced by allowlist + password sign-in (`2026-06-12-allowlist-password-auth-design.md`) and 4-digit join codes (`2026-06-12-join-code-design.md`).

**Date:** 2026-06-10
**Status:** Approved direction, pending spec review
**Context:** Productizing the video-collab-probe research platform into a real, deployable product.

## Product Definition

A deployed, account-based collaborative video editing product where a blind/low-vision (BLV) creator and a sighted helper work together across two devices, with real AI assistance and real video export. This is the Probe 2b/3 concept matured into a product, with Probe 1's description/VQA layer as supporting infrastructure.

**First users:** A pilot deployment of tens of users (BLV creators and their own helpers — friends, family, community), using the product unsupervised.

## Decisions Made

| Decision | Choice |
|---|---|
| Product core | Creator–helper collaboration tool (two devices, task routing, awareness) |
| Scale | Pilot, ~10s of users, unsupervised real-world use |
| AI layer | Real AI from day one — no Wizard-of-Oz, no researcher in the loop |
| Video export | Real exportable video files (server-side FFmpeg rendering, Phase 4) |
| Accounts | Accounts + invite link (creator signs up, helper joins via link) |
| Backend stack | Supabase (auth, Postgres, storage, realtime) + small Node service (FFmpeg, Gemini) |
| Repo strategy | **New repo.** The probe repo stays frozen as the reproducible study artifact. |

## Phased Roadmap (Approach A: backend foundation first)

1. **Phase 1 (this spec):** Production backend — auth, projects, storage, processing, realtime sync. Functional port of existing creator/helper UI.
2. **Phase 2:** Product UX — one coherent creator experience + helper experience; no conditions, session setup, researcher dashboard, or WoZ panels.
3. **Phase 3:** Real AI — server-side proactive suggestions, task-routing responses, VQA.
4. **Phase 4:** Render service — EDL → FFmpeg → downloadable/shareable video file.

Each phase ends in something usable. Rationale for backend-first: the WS relay and pipeline API are currently Vite **dev plugins** — a production build has no collaboration and no upload at all, and all state dies with localStorage. Every other workstream blocks on a server existing.

**Pre-Phase-1 de-risk task (cheap, ~1 day):** prompt Gemini against real participant footage to sanity-check proactive-suggestion quality before committing to the Phase 3 design. The product bets on this.

## 1. New Repo & Stack

- Fresh repository (name TBD, e.g. `video-collab-app`). Probe repo is not modified further except for study maintenance.
- Same frontend stack so components port without friction: **Vite + React 19 (JavaScript) + Tailwind v4 + react-router**.
- Monorepo with two packages:
  - `web/` — the SPA
  - `server/` — the Node/Express service
- **Vitest** added from day one as the test runner (the probe repo has none).

### Imported from the probe repo
- Shared component layer: `VideoPlayer`, `SceneBlock`, `SceneBlockList`, `TransportControls`, editor panels (`MockEditor*`, overlay components)
- `usePlaybackEngine` (EDL playback), `useSpeechRecognition`, `useTextOverlay`
- Accessibility infrastructure: `AccessibilityContext`, `announce()` + `#sr-announcer`, `earcon.js`, `ttsService`
- Decoupled creator/helper components (`DecoupledCreatorDevice`, `DecoupledHelperDevice`, etc.) as UI seeds for Phase 1's functional port
- Pipeline services: `segmentation.js`, `geminiDescriptions.js`, `prompts/description_generation.txt`

### Left behind
- EventLoggerContext / research event export (replaced later by lightweight product analytics)
- Probe pages, researcher dashboard, all WoZ panels, session/dyad setup, condition ordering
- The Vite pipeline/WS-relay plugins (superseded by the real backend)

## 2. Architecture

Three pieces:

### Supabase
- **Auth:** email magic-link sign-in. No password to manage; a one-field form is the most screen-reader-friendly login flow.
- **Postgres:** all durable state (schema below) with row-level security.
- **Storage:** video files and keyframes. Uploads use the **TUS resumable upload protocol** from the start — phone uploads over mobile connections are the flakiest part of the system; this is a Phase 1 decision, not a later optimization.
- **Realtime:** one channel per project. Presence (who's online), broadcast for transient events (playhead position, awareness pings), Postgres-changes subscription for durable state (EDL updates). This fully replaces the custom WS relay.

### Node service (`server/`)
Grown from the existing pipeline Express code. Owns everything that needs FFmpeg or a secret key:
- Upload processing: segmentation, keyframe extraction (FFmpeg)
- Gemini description generation (3 levels)
- **All Gemini calls, including VQA, move server-side in Phase 1.** The browser never holds an API key (`VITE_GEMINI_API_KEY` is retired).
- Phases 3–4 (AI suggestions, rendering) slot into this same service.
- Authenticates requests by validating the caller's Supabase JWT; talks to Supabase with a service-role key (server-only).

### Web SPA (`web/`)
- Talks to Supabase directly for auth, data, and realtime.
- Talks to the Node service for processing endpoints (upload-complete trigger, description generation, VQA proxy).
- Mobile-first (creators and helpers are on phones), desktop works.

### Hosting (pilot tier)
- Frontend: Vercel or Netlify
- Node service: Railway, Render, or Fly.io
- Supabase free tier
All comfortably cover tens of users at free-or-cheap cost.

## 3. Data Model

Core tables (Postgres, RLS: members see only their projects):

- `projects` — owner, title, status, created_at
- `project_members` — user_id, project_id, role (`creator` | `helper`)
- `invites` — project_id, token, role, expires_at, used_by
- `videos` — project_id, storage_path, duration, metadata, processing_status
- `segments` — video_id, index, start/end time, storage_path, keyframe_path
- `descriptions` — segment_id, level (1–3), text, source (`ai` | `edited`)
- `project_state` — project_id, version, state JSON (EDL clips, marks, selected level). Direct descendant of what `projectState.js` writes to localStorage today. Versioned rows give cheap history/undo and conflict detection.

## 4. Auth & Invite Flow

1. Creator signs up (magic link) → creates project → uploads video → Node service processes it (segments + descriptions).
2. Creator taps "Invite helper" → app creates an `invites` row → creator shares `/join/<token>` (system share sheet).
3. Helper opens link → signs in with their email (magic link) → token redeemed → `project_members` row with role `helper` → lands in the project.

No dyad codes, no researcher provisioning.

## 5. Error Handling

- **Uploads:** resumable (TUS); interrupted uploads continue rather than restart. Processing status surfaced per video (`uploading → processing → ready → failed`) with screen-reader announcements on transitions.
- **Processing failures:** FFmpeg/Gemini failures mark the video `failed` with a retry action; partial description generation is resumable per segment.
- **Realtime:** on reconnect, client refetches `project_state` and rejoins presence; broadcast events are fire-and-forget (transient by design).
- **Conflicts:** `project_state` writes carry the version they were based on; a stale write is rejected and the client refetches and reapplies (last-writer-wins is acceptable at dyad scale, but the version check prevents silent clobbering).

## 6. Testing

- Vitest unit tests for: EDL/state serialization, invite-token redemption logic, server route handlers (Supertest), description-generation prompt assembly.
- One scripted two-browser smoke test (Playwright) for the Phase 1 acceptance flow below.
- RLS policies tested with Supabase's local dev stack.

## 7. Phase 1 Acceptance Criteria ("done means")

A deployed URL where:
1. A creator signs up with email, creates a project, and uploads a phone video.
2. The video is segmented with 3-level AI descriptions, with status announced accessibly.
3. The creator invites a helper via link; the helper joins on a second device.
4. Both devices show the same project; edit state (EDL, marks) syncs live and survives refresh and re-login.
5. No API keys ship to the browser.

UI at this stage is a functional port of the existing creator/helper screens; visual/UX redesign is Phase 2.

## 8. Out of Scope for Phase 1

Proactive AI suggestions and AI task routing (Phase 3) · video export/rendering (Phase 4) · unified product UX redesign (Phase 2) · billing · moderation · native mobile apps.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Phone uploads over mobile networks fail mid-transfer | TUS resumable uploads from day one |
| AI suggestion quality without a wizard is unproven | 1-day Gemini prompt spike against real footage before Phase 3 design |
| Supabase vendor lock-in | Accepted for pilot scale; data model is plain Postgres and exportable |
| Free-tier limits (storage especially, video is heavy) | Monitor; Supabase storage is the first thing to upgrade (~$25/mo tier) |
| Magic-link email deliverability for pilot users | Test with participant email domains early; password fallback can be enabled in Supabase without code changes |
