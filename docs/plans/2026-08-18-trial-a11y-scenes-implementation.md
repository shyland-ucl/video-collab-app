# Implementation plan: trial readiness + low-vision themes + auto scene detection

**Design:** `2026-08-18-trial-a11y-scenes-design.md` · **Branch:** `feat/trial-a11y-scenes`
**Order:** A (themes) → B (scene detection) → C (events logging) → D (provisioning + robustness) → E (verification). Each phase compiles, tests green, and commits on its own.

## Phase A — 4 themes + XL text size (web only)

1. **Tokens** (`web/src/index.css`): keep `@theme` as the default palette. Add
   `html[data-theme="dark"]`, `[data-theme="hc-dark"]`, `[data-theme="hc-light"]`
   blocks that override the same `--color-*` variables (canvas, surface, sunken,
   ink×3, line×2, brand×3, creator, helper, danger×2, success, shadows).
   HC blocks additionally: `--shadow-card/--shadow-pop: none`-equivalent,
   focus outline color via a new `--color-focus` token (default = brand; hc-dark
   = yellow `#ffd60a`; hc-light = `#0000cc`-class blue). Update `:focus-visible`
   and `.alert-error`/`::selection` to use tokens only. Add `color-scheme:
   dark`/`light` per theme so native controls (scrollbars, inputs, video
   controls) match. The `body` radial-gradient tint becomes a token
   (`--canvas-glow`) so dark themes can zero it.
2. **Text size**: add `html[data-text-size="x-large"] { font-size: 24px }`.
3. **Context** (`AccessibilityContext.jsx`): add `theme` to defaults
   (`'default'`), validate stored value against
   `['default','dark','hc-dark','hc-light']`, add `SET_THEME` + `setTheme`,
   extend textSize validation with `'x-large'`. New effect mirrors the textSize
   one: `root.dataset.theme = state.theme`. Initial default when nothing stored:
   read `matchMedia('(prefers-color-scheme: dark)')` and
   `('prefers-contrast: more)')` → dark / hc-dark / hc-light.
4. **No-flash boot** (`web/index.html`): tiny inline script (pre-module) reads
   `localStorage.accessibilitySettings`, applies `data-theme` + `data-text-size`
   with the same validation lists, falls back to media queries. Must never throw
   (try/catch whole thing). Also set `<meta name="color-scheme">`.
5. **Settings page**: fourth fieldset "Colour theme" — 4 radio cards, each with
   a 3-dot swatch preview (canvas/ink/brand chips rendered from the theme's
   actual values via inline style), announce on change. Add "Extra large" to
   TEXT_SIZE_OPTIONS.
6. **Sweep**: grep web/src for hex colors, `bg-white`, `text-black`,
   `shadow-`, raw `rgba(` in JSX/CSS; route everything through tokens.
   Editor components (`components/editor/*`) are the likely offenders.
7. **Tests**: context reducer/validation (theme + x-large), SettingsPage renders
   4 theme options and dispatches, boot-script validation logic extracted to a
   testable pure module is overkill — instead assert context applies
   `data-theme` (jsdom).

## Phase B — auto scene detection (server only)

1. **`segmentation.js`** additions (keep all existing exports):
   - `buildSceneDetectArgs(sourceFile)` → `['-i', src, '-vf',
     'scale=320:-2,scdet=threshold=<T>', '-an', '-f', 'null', '-']` decode-only.
   - `parseScdetStderr(stderr)` → `[{time, score}]` (lines contain
     `lavfi.scd.time` / `scd.score`; write fixture from a real run first).
   - `boundariesToScenes(cuts, duration, {minLen, maxLen, maxScenes})` pure:
     sort+dedupe cuts → segments; merge `<minLen` into previous (or next for the
     first); split `>maxLen` into equal chunks `≤maxLen`; if count > maxScenes,
     drop weakest-score cuts and rebuild (splits keep priority over weak cuts);
     emit the exact plan shape `{id: seg_NNN, idx, start_seconds, end_seconds,
     label: 'Scene N', midpoint}`.
   - `detectScenes(sourceFile, duration, opts)` orchestrator: env-driven
     defaults `SCENE_THRESHOLD` (scdet threshold, default 10 — scdet score is
     0–100), `MIN_SCENE_SECONDS=3`, `MAX_SCENES=30`; `maxLen` passed in from
     `video.segment_length_seconds`. On zero cuts or ffmpeg error → return
     `planSegments(duration, maxLen)` and log why. Exported with injectable
     `run` for tests.
2. **`processVideo.js`**: replace line 65 with
   `AUTO_SCENES !== '0' ? await detectScenes(sourceFile, planDuration, {maxLen: video.segment_length_seconds, log}) : planSegments(...)`.
3. **`scripts/diag-scenes.mjs`**: `node scripts/diag-scenes.mjs <file>` — runs
   detection on a local file, prints the cut list, scores, and final plan next
   to what fixed windows would have produced. No env needed (pure local).
4. **Tests**: `boundariesToScenes` (merge/split/cap/empty/edge), parser against
   captured stderr fixture, `detectScenes` fallback paths (injected run that
   throws / returns no cuts), processVideo still green (its planSegments dep is
   injected — add `plan` dep injection if needed to avoid spawning ffmpeg in
   unit tests).

## Phase C — events logging

1. **Migration `0014_events.sql`**: table
   `events(id uuid pk default gen_random_uuid(), created_at timestamptz default
   now(), user_id uuid references auth.users on delete set null, project_id
   uuid references projects on delete cascade, event_type text not null check
   (char_length ≤ 64), payload jsonb not null default '{}')`.
   Index `(project_id, created_at)`. RLS on; single policy:
   `for insert with check (user_id = auth.uid())`. No select/update/delete
   policies (service role only). NOT added to realtime publication.
2. **Web `lib/events.js`**: `logEvent(type, payload = {}, projectId = null)` —
   fire-and-forget `supabase.from('events').insert(...)`, `.then(noop, noop)`;
   reads user id from the session; never throws. Call sites:
   - `SignInPage` success → `sign_in`
   - `RouteAccessibility` title effect → `page_view {path-shape}` (use the
     titleForPath name, not raw ids)
   - `SettingsPage` handlers → `settings_change {setting, value}`
   - `ttsService.speak` callers already centralised? If not, log in
     `SettingsPage`/editor where TTS toggled + spoken → `tts_spoken {chars}`
   - Editor: `scene_play {sceneId}`, `scene_focus {sceneId}`,
     `suggestion_shown/apply/dismiss {suggestionId}` — wire where those actions
     already announce/dispatch.
   - Video/export download click → `export_download`.
3. **Server `services/events.js`**: `logServerEvent(supabase, {userId,
   projectId, type, payload})` — insert via service role, catch+console.warn.
   Call sites: videos route (`video_upload` on process kick, `processing_done`
   in processVideo success path), aiEdit route (`ai_edit_request {prompt}`,
   `ai_edit_confirm/reject`), suggest route (`suggestions_generated {count}`),
   render route (`render_start`, `render_complete {status}`).
4. **`scripts/export-events.mjs`**: `node --env-file=server/.env
   scripts/export-events.mjs [--from ISO] [--out dir]` — joins
   project_members (role) + auth email (admin API), writes `events.csv` +
   `events-<projectId>.csv` per project. CSV-escape everything.
5. **Tests**: web logEvent (mocked supabase — never rejects), server
   logServerEvent (insert failure swallowed), route tests assert an event
   insert happens on ai_edit_request (extend existing route test mocks).

## Phase D — trial provisioning + robustness

1. **`scripts/provision-pair.mjs`**: args `--creator-email --helper-email
   [--title "Family videos"] [--pair P01]`. Steps: insert both emails into
   `allowed_emails` (upsert), `auth.admin.createUser({email, password,
   email_confirm: true})` with generated word-passwords (wordlist in-script,
   `word-word-NN`), insert project (owner = creator), insert both
   `project_members` rows (roles creator/helper), print credentials sheet
   (plain text block per participant). Idempotency: if user exists, abort with
   clear message (never overwrite a live participant).
2. **`scripts/reset-participant.mjs`**: `--email` → new word-password via
   `auth.admin.updateUserById`, prints it.
3. **`/health/db`** (app.js): `supabase.from('projects').select('id',
   {head: true, count: 'exact'}).limit(1)` — returns `{ok: true}` or 503
   `{ok: false}`. Keeps both Railway and Supabase warm.
4. **`.github/workflows/keepalive.yml`**: daily cron, `curl -fsS
   $SERVER_URL/health/db` with `SERVER_URL` repo variable; fails the run (so
   you get a GitHub email) when the endpoint is down. This is the trial's
   dead-man switch.
5. **Friendly failure**: `web/src/components/StudyErrorNotice.jsx` — renders the
   "study system is having a problem — please tell Lan" message with
   `mailto:l.xiao.22@ucl.ac.uk`. Used by: SignInPage GENERIC branch (network /
   unexpected errors only — wrong-password stays as-is) and `serverApi.js`
   consumers via a mapped error (`server_unreachable`) that pages can present
   with the component. ErrorBoundary fallback also gets the contact line.
6. **Tests**: health/db (app test with mocked supabase), password generator
   (shape `^[a-z]+-[a-z]+-\d{2}$`), StudyErrorNotice render, describeError
   unchanged for auth errors.

## Phase E — verification

- `npm test` (web + server) green; `npm run build` green.
- Manual: dev server, flip all 4 themes × 4 text sizes on Settings, Projects,
  Editor; screenshot hc-dark editor at x-large.
- `node scripts/diag-scenes.mjs` on one multi-cut clip + one single-take clip.
- Deploy checklist (for Lan, not automated): `supabase db push` (0014), Railway
  env (`AUTO_SCENES`, `SCENE_THRESHOLD` optional), Vercel auto on push, GitHub
  repo variable `SERVER_URL`, run provision script per pair before the trial.
