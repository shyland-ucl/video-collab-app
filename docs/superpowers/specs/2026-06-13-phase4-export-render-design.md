# Phase 4 — Export / Render (v1: structural + colour) Design

**Date:** 2026-06-13
**Status:** Approved (scope: structural + colour; captions + overlays deferred to v2)
**Roadmap origin:** `2026-06-10-product-phase1-backend-design.md` — "Phase 4: Render service — EDL → FFmpeg → downloadable/shareable video file." Multiple specs label the editor's colour as "preview only until export", so colour rendering is part of the v1 promise.

---

## What this builds

The creator taps **Export**; the server renders the project's edit state (the EDL) into a single downloadable MP4 that reproduces:

- **Structure:** clip order, per-clip trims, splits, deletions — assembled into one continuous video.
- **Audio:** per-scene mute and volume.
- **Colour:** per-scene grade (brightness / contrast / saturation / zoom / rotate), matching the live preview.

**Out of scope (v2 fast-follow):** burned-in captions and text overlays (`drawtext`), which also require reconciling the caption time base (captions store source-time; the engine matches EDL-time). Attached sounds (`clip.sound`) are ignored — there is no real sound-asset pipeline.

This is **greenfield** — the probe never rendered (it plays the EDL live); there is no code to port. But it reuses the Phase 1b processing skeleton wholesale, so it introduces no new infrastructure patterns.

---

## Architecture

```
supabase/migrations/
  0012_renders.sql                NEW — renders table + RLS + realtime; raise bucket size limit

server/src/
  services/
    renderPlan.js                 NEW — PURE: EDL → ordered render plan (per-clip effective range,
                                          source id, colour, audio); + colourValuesToFfmpegFilter
    renderVideo.js                NEW — worker: load EDL + sources, per-clip ffmpeg cut+filter,
                                          concat, upload, status (mirrors processVideo.js)
    segmentation.js               REUSE — ffmpeg-static execFile harness (add render helpers OR
                                          a new ffmpegRender.js that follows the same pattern)
  routes/
    render.js                     NEW — POST /api/projects/:id/render (member-checked, atomic claim)
    renderData.js                 NEW — load the project's source videos (storage paths) for render
  app.js                          EDIT — mount makeRenderRoutes(supabaseClient)
  services/processVideo.js        EDIT — recoverInterrupted also fails interrupted 'rendering' renders
  index.js                        (unchanged — boot sweep already called)

web/src/
  lib/editor/rendersApi.js        NEW — requestRender(projectId), listRenders/latestRender(supabase,…),
                                          signed-url for a ready render
  lib/editor/projectChannel.js    EDIT — subscribe to the renders table (onRenderChange)
  pages/EditorPage.jsx            EDIT — onExport(); load + subscribe renders; announce status; pass down
  components/editor/ExportPanel.jsx NEW — the Export button + status + download link (accessible)
  components/editor/CreatorDevice.jsx EDIT — mount ExportPanel
  pages/ProjectPage.jsx           EDIT — an Export/Download affordance next to "Open editor"

scripts/diag-render.mjs           NEW — render a real project's EDL to an MP4 for human review (gate)
```

### Data model — `renders` table (migration 0012)

A render is **project-level** (the EDL can span multiple source videos), so it is keyed by `project_id`, not a single `videos` row.

| column | type | notes |
|---|---|---|
| `id` | uuid PK (gen_random_uuid) | the renderId |
| `project_id` | uuid NOT NULL → projects(id) on delete cascade | |
| `status` | text CHECK in (rendering, ready, failed) | the job state machine |
| `output_path` | text | `${project_id}/renders/<renderId>.mp4`, set on success |
| `error` | text | failure message |
| `edl_version` | integer | the project_state version rendered (provenance) |
| `created_by` | uuid → auth.users(id) | the creator who triggered it |
| `created_at` | timestamptz default now() | |

**RLS:** member SELECT (`is_project_member`); **no member INSERT/UPDATE** — only the server (service-role) writes, like `suggestions`. Add the table to `supabase_realtime`. **Raise the `videos` bucket `file_size_limit`** from 50 MB to a render-appropriate size (e.g. 500 MB) in the same migration; the bucket already permits `video/mp4` and RLS authorizes any path under `project_id/…`, so no new storage policy is needed.

### Render job lifecycle (mirrors `POST /api/videos/:id/process`)

1. **Route** (`render.js`): `requireAuth` → confirm project + caller is a member (404 / 403).
2. **Atomic claim:** reject if a `rendering` row already exists for this project (409 `already_rendering`) — the single-flight guard, same idea as the processing 409.
3. Validate the EDL is renderable (≥1 clip, sources resolvable) → else 400.
4. Insert a `renders` row `status='rendering'`, `edl_version` = the loaded state version → `res 202 { renderId }`.
5. **Await `renderVideo()` after responding** (fire-and-forget; on throw, set `status='failed'` + `error`).
6. `recoverInterrupted` (boot) additionally flips any `rendering` → `failed` (interrupted_by_restart), preserving single-instance restart safety.

### `renderVideo.js` worker (mirrors `processVideo.js`)

`renderVideo({ supabase, runFfmpeg, projectId, renderId, log })`:
1. `mkdtemp` work dir.
2. Load the EDL (`loadLatestState`) + the project's source videos (`renderData.loadProjectSources` → `{ id, storage_path }`).
3. Build the **render plan** (pure `renderPlan.buildRenderPlan(state, sources)`): the ordered list of `{ index, sourceId, sourcePath, effStart, effEnd, colour, muted, volume }`, skipping clips whose source can't be resolved; error if the plan is empty.
4. Download each **distinct** source original once into the work dir.
5. **Per clip:** `runFfmpeg(clipCutArgs)` → an intermediate `clip_NNN.mp4` cut `[effStart, effEnd]` from its source, with the colour filter chain + scale/pad to the canonical output size + audio (mute/volume), encoded to identical params (libx264/aac/720p/30fps).
6. **Concat** the intermediate files via the concat demuxer (`-f concat -safe 0 -i list.txt -c copy out.mp4`) — a cheap stream copy because every clip shares params.
7. Upload `out.mp4` to `${project_id}/renders/<renderId>.mp4`; set `renders.status='ready'`, `output_path`.
8. `catch` → `status='failed'` + `error`; `finally` → `fs.rm(workDir)`.

`runFfmpeg` is the injected ffmpeg runner (default: promisified `execFile(ffmpegPath, args, { maxBuffer })`, exactly as `segmentation.js`) so the worker is unit-testable without spawning ffmpeg.

### The pure units (testable without ffmpeg or network)

- **`renderPlan.buildRenderPlan(state, sources)`** → ordered plan. Effective range per clip = `startTime + (trimStart||0)` … `endTime − (trimEnd||0)` (the exact `computeClipLayout` math). Order = the `clips` array order. Splits = two adjacent plan entries of the same source. Deletes = absent from `clips` → absent from the plan. Colour resolved via `rootSegmentId(clip.id)` against `state.colour`. Volume/mute from the clip. Clips whose `sourceId` has no matching source are dropped (logged). Empty plan → throws a typed error the route maps to 400.
- **`renderPlan.colourValuesToFfmpegFilter(colour)`** → the ffmpeg `-vf` colour chain string (or `null` when neutral), mirroring `colourValuesToFilter`/`colourValuesToTransform` **exactly**:
  - contrast → `eq=contrast=${1 + contrast/200}` (ffmpeg `eq` contrast pivots on mid-grey, matching CSS).
  - saturation → `eq=saturation=${1 + saturation/100}` (direct multiplier, exact match).
  - brightness (CSS is multiplicative `×(1+brightness/200)`) → a multiplicative step (`lutrgb`/`colorlevels`), NOT ffmpeg `eq=brightness` (which is additive). The exact filter is finalized + frame-compared in the diag.
  - zoom (`zoom/100`) → `scale=iw*z:ih*z` then `crop=W:H` centered (CSS `scale()` zooms about center, container clips overflow).
  - rotate → `rotate=${rotate}*PI/180` (degrees → radians), composited after scale (CSS applies `scale` then `rotate`).
  - **Colour fidelity is the one real correctness task**; `diag-render.mjs` renders a graded frame and we compare it to the preview filter to confirm the match before shipping.
- **`renderPlan.clipFfmpegArgs(planEntry, output, opts)`** → the full `execFile` arg array for one clip (input, `-ss/-to`, `-vf` colour+scale+pad, `-af`/`-an` audio, codec/fps/size), so the command is a pure, asserted function.

### Output target

**1280×720, 30 fps, H.264 (yuv420p) + AAC**, each clip scaled to fit with letterbox/pillarbox (`scale=…:force_original_aspect_ratio=decrease, pad=1280:720:(ow-iw)/2:(oh-ih)/2`) so mixed-resolution / mixed-orientation sources never distort. A predictable default for short clips; revisable later.

### Client / UX

- **`ExportPanel.jsx`** (in CreatorDevice + a lighter affordance on ProjectPage): an **Export video** button → `onExport()` → `POST /render`. While `rendering`: a polite-live status ("Rendering your video…"). On `ready`: a **Download** link (signed URL via `rendersApi.signedUrl`). On `failed`: assertive announce + a retry. The creator triggers (project-level action); the helper surface stays read-only.
- **`projectChannel`** gains an `onRenderChange` subscription; **`EditorPage`** loads the latest render on open, subscribes, and routes status to `announce()` + the panel. Accessibility: the same `#sr-announcer` / earcon conventions; the button ≥48 px; status is a non-duplicating live region.

### Error handling

| Condition | Behaviour |
|---|---|
| Not a member / unauth | 403 / 401 |
| Empty or unresolvable EDL | 400 `nothing_to_render` |
| Render already in flight (project) | 409 `already_rendering` |
| ffmpeg / download / upload failure | `renders.status='failed'` + `error`; assertive announce; retry offered |
| Interrupted by restart | boot sweep → `failed` |
| Misconfigured server | 5xx before the 202 |

### Testing

- **Unit:** `renderPlan.test.js` — effective ranges, order, splits, deletes, colour-by-rootSegmentId, empty-plan error; `colourValuesToFfmpegFilter` per slider + neutral→null; `clipFfmpegArgs` arg assertions. `renderVideo.test.js` — injected fake `runFfmpeg` + fake supabase: downloads sources, renders per clip, concats, uploads, sets status; failure path sets `failed`. `render.test.js` (route) — 401/404/403, 409 already-rendering, 400 empty EDL, 202 happy path. `rendersApi.test.js`, a `projectChannel` renders-subscription assertion.
- **Live (the quality gate):** `scripts/diag-render.mjs <projectId>` renders a real project's EDL to an MP4 on disk for you to watch (confirms structure + colour fidelity), and a frame-compare for the colour filter. Extend the Playwright e2e: creator taps Export → status reaches `ready` → a download link appears (generous timeout; live ffmpeg).

---

## Decomposition note

This is one coherent plan (one render job, one table, one route, one UI). v2 (captions + overlays) is a separate spec — it adds `drawtext` per overlay/caption and resolves the caption time base, with no change to the job/table/route built here.

## Adversarial review outcome (2026-06-13)

A 3-lens review (security/ffmpeg-safety, correctness, a11y) + verify pass ran
over the diff: 3 critical + 7 important confirmed, **all fixed**:

- **CRITICAL — ffmpeg filtergraph injection** via an unsanitised `rotate` value
  (project_state JSONB is member-writable with no DB shape check, so a crafted
  `rotate` string could inject filters / read local files on the render host).
  Fixed: `colourToVf` coerces every field with `Number()` (injection-proof on
  its own), and `buildRenderPlan` `sanitizeColour`-clamps every grade + coerces
  all time/volume fields. A non-numeric value can never reach the `-vf` string.
- **CRITICAL — muted clips used `-an`**, breaking `concat -c copy` across mixed
  muted/unmuted timelines. Fixed: mute = `volume=0` (keeps a uniform audio
  stream), and every clip pins `-c:a aac -ar 48000 -ac 2` so the concat copies.
- **CRITICAL — stranded focus** when the Download link appears. Fixed: the link
  is focused on mount (rAF), mirroring the suggestion-route focus fixes.
- **IMPORTANT**: time/volume fields coerced+validated (same root cause as the
  rotate injection); `MAX_CLIPS=300` DoS bound; the optimistic 'pending' render
  row can no longer block the real row (and a 409 refetches the in-flight row);
  the ExportPanel rendering card + "Preparing…" are no longer duplicate live
  regions (EditorPage announces once); `latestRender` has a deterministic
  tiebreak.

Accepted / deferred minors: rotate's visual frame is not expanded to match the
CSS preview exactly (rare, cosmetic); a source with NO audio track would fail
the `volume=0` filter (phone videos always have audio — v1 limitation); the
single-flight 409 is check-then-insert (one creator, UI-gated — low risk).

## Constraints (carried from the project)

`scripts/diag-smtp.mjs` never staged; probe read-only; `gemini-2.5-flash` injected (N/A here); commit messages end `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; `npx supabase db push --yes` = LIVE (migration 0012 is additive — a new table + a bucket-limit bump). The render worker runs in-process after the 202 (single-instance Railway), consistent with the processing pipeline; if renders prove long enough to risk request-process limits, a real queue is a future change, not part of v1.
