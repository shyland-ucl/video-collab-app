# Product Phase 1c — Realtime Collaboration & Editor Port Design

**Date:** 2026-06-12
**Status:** Approved by Lan (design dialogue, this date)
**Parent spec:** `2026-06-10-product-phase1-backend-design.md` (Phase 1, third slice)
**Builds on:** Phase 1a (auth/projects/join codes), Phase 1b (videos/segments/descriptions pipeline, tag `phase-1b`)

## Product definition

The creator (blind/low-vision, project owner) and her helper (sighted, joined member) collaboratively edit the project's videos from two devices in real time. The creator explores scenes by audio and edits by voice/keyboard/buttons; the helper sees a synced preview, receives the creator's task requests, and edits with visual tools. This ports the probe repo's Probe 2b/3 two-device experience (`DecoupledCreatorDevice` / `DecoupledHelperDevice`) onto the production backend.

## Scope decisions (made with Lan)

| Decision | Choice |
|---|---|
| Editing unit | **Whole-project timeline** — all `ready` videos merge into one ordered timeline of scenes (multi-source EDL) |
| AI in 1c | **VQA + basic Ask-AI edits** — VQA uses the live 1b endpoint; Ask-AI is an AI-as-command-interpreter over the editor's own operations (pulls a slice of Phase 3 forward) |
| AI edit flow | **Confirm-first** — AI proposes one operation with a spoken summary; nothing touches the timeline until the creator confirms |
| Helper toolkit | **Everything incl. colour** — clip ops, captions, text overlays, and brightness/contrast/saturation/zoom sliders. Colour persists in shared state but renders as a CSS-filter preview only until Phase 4 export applies it for real (UI labels this) |
| Sync architecture | **Approach A** — durable state in Postgres (versioned `project_state` rows + `tasks` table) synced via Realtime postgres_changes; transient events (playhead, awareness) via Realtime broadcast; presence via Realtime presence |

## 1. Data model (migration 0008)

```text
project_state            -- append-only versioned edit-state snapshots
  id uuid pk
  project_id uuid -> projects (cascade)
  version integer            -- unique (project_id, version)
  state jsonb                -- { clips, captions, textOverlays, colour }
  updated_by uuid -> auth.users
  created_at timestamptz

tasks                    -- "Ask Helper" requests, durable
  id uuid pk
  project_id uuid -> projects (cascade)
  created_by uuid -> auth.users (cascade)
  text text (1..500)
  segment_label text         -- e.g. "Scene 3" for context
  status text: pending | done | needs_discussion | cant_do
  created_at, updated_at timestamptz
```

- **RLS:** members select on both; members insert (`updated_by`/`created_by = auth.uid()`); members may UPDATE `tasks` (status responses). `project_state` is append-only — no update/delete policies.
- Both tables join the `supabase_realtime` publication so postgres_changes reach subscribed members (RLS applies to the stream).
- `state.clips` reference `sourceId = video_id`; **no URLs are stored** (signed URLs expire — sources are rebuilt at load from the `videos` table). `state.colour` is per-scene: `{ [sceneId]: { brightness, contrast, saturation, zoom } }`.
- Version history is unpruned for the pilot (a few KB/version); a cleanup job is a Phase 2 item.

## 2. Realtime design

One channel per project, `project:{project_id}`, carrying:

1. **Presence** — `{ user_id, role, email }`; join/leave announced ("Helper joined").
2. **postgres_changes** — INSERT on `project_state` and INSERT/UPDATE on `tasks`, filtered by project_id. Receiving a newer state version applies it, computes a change summary (ported `projectOverview`), announces it ("Helper trimmed Scene 2") and shows a toast.
3. **Broadcast** (transient, never persisted):
   - `playhead` `{ isPlaying, time, segmentId }` — creator → helper, throttled ~2s (probe's `STATE_UPDATE`)
   - `transport` `{ action: play|pause|seek, time, actor }` — immediate transport events
   - `activity` `{ action, detail, actor }` — helper awareness pings ("Seeked to 0:45") for the creator's activity stream

### Write path (edits) and conflict handling

Local optimistic apply → INSERT `project_state` with `version = latest + 1` → on unique-violation: refetch latest, **reapply the local operation on top**, retry once → on second failure announce "Your change conflicted with your helper's — the timeline was updated" and resync. Devices ignore their own postgres_changes echo (`updated_by` = self and version already applied). Last-writer-wins is acceptable at dyad scale; the version check prevents silent clobbering (parent spec §5).

### Recovery

Refresh / re-login / reconnect: fetch latest `project_state` + open `tasks`, resubscribe, rebuild sources with fresh signed URLs. Works with the peer offline — no peer-snapshot protocol.

## 3. Editor UI port

**Route:** `/projects/:projectId/edit` (RequireAuth). ProjectPage gains an "Open editor" button once ≥1 video is `ready`. Role comes from `project_members`: owner → Creator device, helper → Helper device. No role selector.

**Initial state:** if no `project_state` rows exist, build version 1 from all `ready` videos: `sources` = each video's original (signed URL), `clips` = one per segment (label, video-relative start/end), ordered by video `created_at` then `idx`.

**Creator device** (port of `DecoupledCreatorDevice` + `ExplorationMode`):
- Scene exploration: prev/next, play/pause, 3 description detail levels; keyboard map ArrowLeft/Right (scenes), ArrowUp/Down (detail), Space (play/pause), Escape (close modal); earcons; TTS read-out with "Stop reading"; live-region announcements throughout.
- **Edit Myself** modal: split at playhead, delete scene, move earlier/later, add caption, undo/redo (local stacks).
- **Ask Helper**: voice/typed task → `tasks` row; helper status changes announced back.
- **Ask about this scene** (VQA): voice/typed question → existing `POST /api/segments/:id/vqa` → spoken answer.
- **Ask AI to edit**: voice/typed request → `POST /api/projects/:id/ai-edit` → confirm-first dialog → applies via the same `sceneEditOps` path → announce.
- Recent-tasks panel fed by the `tasks` table.

**Helper device** (port of `DecoupledHelperDevice` + panels):
- Pinned synced preview (creator playhead mirrored via broadcast; independent scrubbing allowed, scrubs send `activity` pings).
- Activity feed: pending tasks with **Done / Needs discussion / Can't do**; creator activity stream.
- Editor tools: trim/split/move/delete, captions, text overlays (place/move/edit/remove), colour sliders (labelled "preview only until export").

**Shared ports:** `usePlaybackEngine` (multi-source EDL playback; signed URLs auto-refresh ~50min), `useSpeechRecognition` (+earcons), `useTextOverlay`, `useRootInert`, `ttsService`, `earcon.js`, `sceneEditOps`, `projectOverview` (change summaries), `AccessibilityContext` (defaults; no settings page yet — YAGNI).

**Stripped in the port:** probe condition switches, all Wizard-of-Oz `window.__*` hooks, researcher event broadcasting, `EventLoggerContext` (announcer stays), `MockColourControls` researcher variants, localStorage `projectState.js` (replaced by `project_state` table).

## 4. AI edit endpoint

`POST /api/projects/:id/ai-edit` `{ request: string }` (auth + membership checked, same pattern as 1b routes):

1. Server loads the scene list (clip order, labels, level-1 descriptions) and the request.
2. Prompts Gemini (new `server/src/prompts/ai_edit.txt`; injected-model pattern → fully testable) with a constrained contract: *answer with exactly one JSON operation* `{ op: delete|split|move_earlier|move_later|caption|trim, target_clip_id, params, summary }` *or* `{ clarification: string }` if the request can't be mapped.
3. Server validates: known `op`, `target_clip_id` exists in the provided scene list, params well-formed (e.g. caption text non-empty, trim seconds within clip bounds). Anything invalid → clarification response, never a guess.
4. Client speaks the `summary` with Confirm/Cancel; on confirm applies the op locally through `sceneEditOps` and persists a new `project_state` version (the server never mutates state).

VQA needs no new work (1b endpoint).

## 5. Error handling

- **Concurrent edits:** see §2 write path.
- **Disconnect/reconnect:** auto-resubscribe; refetch state + tasks before trusting the channel; presence announces join/leave.
- **Signed URL expiry:** refresh timer ~50min swaps sources without interrupting playback position.
- **AI failures:** timeout/junk → clarification message; whitelist validation server-side; confirm gate client-side.
- **Videos finishing processing mid-session:** "New scenes available — reload the editor" notice; no live timeline surgery.
- **Empty/processing-only project:** editor entry hidden until ≥1 `ready` video.

## 6. Testing

- **Unit (vitest):** every `sceneEditOps` operation; versioned-write client (collision → rebase → retry, with fake supabase); change-summary generator; ai-edit endpoint (fake Gemini: valid op / unmappable / junk / invalid target); task & feed reducers.
- **Live smoke:** extend `scripts/e2e-smoke.mjs` — `project_state` + `tasks` RLS (member insert/read, outsider blocked), version-collision uniqueness.
- **Two-browser Playwright smoke** (acceptance vehicle): creator + helper signed in side-by-side against local dev — creator deletes a scene → helper's timeline updates + announces; helper marks a task done → creator's panel updates; mid-session refresh → state intact.

## 7. Acceptance criteria ("done means", deployed to production)

1. Creator opens the editor on real uploaded videos and explores scenes by keyboard/voice with TTS and announcements.
2. Creator edits (split/delete/move/caption) herself; helper sees each change live with an announcement, and vice versa for helper edits (incl. captions, overlays, colour).
3. Creator sends the helper a task; helper responds; creator hears the status change.
4. Creator asks the AI for an edit; AI proposes; creator confirms; the edit lands and syncs.
5. Creator asks a question about a scene and hears a real answer (VQA).
6. Both devices show the same timeline; it survives refresh, re-login, and a Railway redeploy.
7. No API keys in the browser; non-members can read/write none of the new tables.

## 8. Out of scope for 1c

Proactive AI suggestions and AI task routing beyond the single-op interpreter (Phase 3) · video export incl. rendered colour (Phase 4) · visual/UX redesign (Phase 2) · marks/voice notes (not fully implemented in probe; revisit in Phase 2) · accessibility settings page · project_state history pruning · product analytics.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Postgres round-trip per edit feels slow | Optimistic local apply; ~100–200ms persistence is imperceptible for tap-driven editing |
| AI maps requests badly (Phase-3 bet pulled forward) | Constrained single-op contract + server validation + confirm-first gate; clarification fallback; the spec's 1-day Gemini quality spike remains scheduled before full Phase 3 |
| Realtime postgres_changes latency/ordering | Versions are monotonic — receivers apply only newer versions, order is irrelevant |
| Two tabs same user (creator opens editor twice) | Same conflict path as two users; version check holds |
| Port drags in probe-only code | Explicit strip list (§3); plan tasks will enumerate per-file |
