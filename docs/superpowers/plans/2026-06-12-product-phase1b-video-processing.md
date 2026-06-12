# Phase 1b — Video Upload & Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A creator uploads a phone video; it lands in Supabase Storage via resumable upload, the Express server segments it with FFmpeg, generates 3-level Gemini descriptions per segment, and both members watch the processing status and read the results in the app.

**Architecture:** The browser uploads the original MP4 directly to a private Supabase Storage bucket using the TUS resumable protocol (client inserts the `videos` row first, then calls the server's `process` endpoint when the upload finishes). The Express server (service role) downloads the original to a temp dir, runs ffprobe/ffmpeg (bundled static binaries), uploads segment clips + midpoint keyframes back to Storage, writes `segments`/`descriptions` rows, and tracks status on the `videos` row (`uploading → processing → ready → failed`). The web app reads everything through RLS-guarded tables and signed URLs; it polls while a video is in flight. A VQA proxy endpoint answers questions about a segment's keyframe (server-side Gemini — no API key in the browser). UI port of the full editor is Phase 1c.

**Tech Stack:** Existing monorepo (Vite + React 19 + Tailwind 4 + Vitest in `web/`; Express 5 + Vitest/Supertest in `server/`; Supabase CLI migrations). New deps: `tus-js-client` (web); `ffmpeg-static`, `ffprobe-static`, `@google/generative-ai` (server). Gemini model: `gemini-2.5-flash`.

**Spec:** `docs/superpowers/specs/2026-06-10-product-phase1-backend-design.md` (copied into this repo by Task 1; auth/invite sections superseded by the 2026-06-12 specs).

**Deviations from spec (deliberate):** (1) "Resumable per segment" description generation is simplified to full reprocess on retry — at ≤20 segments per pilot video, re-running the whole pipeline is cheap and far simpler; the spec's intent (recover from failure via a retry action) is met. (2) Free-tier Supabase caps uploads at 50 MB per file — acceptable for pilot testing; the spec already names storage as the first paid upgrade.

**Operational reminders:** `npx supabase db push` applies migrations to the LIVE linked project immediately; web deploys via Vercel from origin/main, so push DB before pushing web code that depends on it. Backend verification is `node --env-file=server/.env scripts/e2e-smoke.mjs`. Do NOT commit `scripts/diag-smtp.mjs` (long-standing local modification, leave alone).

---

## File Structure

```
video-collab-app/
  docs/superpowers/specs/2026-06-10-product-phase1-backend-design.md   # copied from probe repo (Task 1)
  supabase/migrations/
    0006_videos_segments_descriptions.sql   # tables + RLS (Task 2)
    0007_videos_storage.sql                 # private bucket + storage RLS (Task 3)
  scripts/
    e2e-smoke.mjs                           # extended: outsider user, steps 14–15 (Task 4)
    diag-gemini.mjs                         # one-shot live Gemini check (Task 5)
  server/
    .env / .env.example                     # + GEMINI_API_KEY, GEMINI_MODEL (Task 5)
    src/
      prompts/
        _shared_style.txt                   # copied from probe (Task 1)
        description_generation.txt          # copied from probe (Task 1)
        vqa.txt                             # new (Task 1)
      services/
        videoMeta.js        (+ .test.js)    # ffprobe metadata (Task 6)
        segmentation.js     (+ .test.js)    # planSegments + cutSegment (Task 7)
        descriptions.js     (+ .test.js)    # Gemini client, prompt, parse, VQA (Task 8)
        processVideo.js     (+ .test.js)    # orchestrator + status transitions (Task 9)
      routes/
        videos.js           (+ .test.js)    # POST process, POST vqa (Task 10)
      app.js                                # mounts video routes (Task 10)
  web/src/
    lib/
      uploadVideo.js        (+ .test.js)    # TUS upload helper (Task 11)
      serverApi.js          (+ .test.js)    # authed fetch to Express server (Task 11)
    components/
      VideosSection.jsx     (+ .test.jsx)   # upload + status list on ProjectPage (Task 12)
    pages/
      ProjectPage.jsx                       # renders VideosSection (Task 12)
      VideoPage.jsx         (+ .test.jsx)   # segments + descriptions viewer (Task 13)
    App.jsx                                 # /projects/:projectId/videos/:videoId route (Task 13)
```

**Storage layout (bucket `videos`, private):** `{project_id}/{video_id}/original.mp4`, `{project_id}/{video_id}/segments/seg_001.mp4`, `{project_id}/{video_id}/keyframes/seg_001_kf.jpg`. The first path component is the project id — storage RLS gates on it via `is_project_member`.

---

### Task 1: Port the spec and prompt files into this repo

The spec and the Gemini prompts live only in the probe repo today. Copy what 1b needs so this repo is self-contained. Only the two prompts 1b uses are copied (`description_review.txt` and the suggestion prompts are Phase 3 material).

**Files:**
- Create: `docs/superpowers/specs/2026-06-10-product-phase1-backend-design.md` (copy + superseded note)
- Create: `server/src/prompts/_shared_style.txt` (copy)
- Create: `server/src/prompts/description_generation.txt` (copy)
- Create: `server/src/prompts/vqa.txt` (new)

- [ ] **Step 1: Copy the files from the probe repo**

```powershell
New-Item -ItemType Directory "server\src\prompts" -Force
Copy-Item "..\video-collab-probe\pipeline\prompts\_shared_style.txt" "server\src\prompts\_shared_style.txt"
Copy-Item "..\video-collab-probe\pipeline\prompts\description_generation.txt" "server\src\prompts\description_generation.txt"
Copy-Item "..\video-collab-probe\docs\superpowers\specs\2026-06-10-product-phase1-backend-design.md" "docs\superpowers\specs\2026-06-10-product-phase1-backend-design.md"
```

- [ ] **Step 2: Prepend a superseded note to the copied spec.** Add this block immediately after the `# Product Phase 1 — Backend Foundation Design` heading line (keep everything else unchanged):

```markdown
> **Copied 2026-06-12 from the probe repo** (`video-collab-probe/docs/superpowers/specs/`), where the original is kept frozen.
> **Superseded sections:** §2 "Auth: email magic-link" and §4 "Auth & Invite Flow" — replaced by allowlist + password sign-in (`2026-06-12-allowlist-password-auth-design.md`) and 4-digit join codes (`2026-06-12-join-code-design.md`).
```

- [ ] **Step 3: Read both copied prompt files end-to-end.** Confirm `description_generation.txt` instructs the model to return JSON with keys `level_1`, `level_2`, `level_3` and `_shared_style.txt` contains no probe-specific references (researcher, condition, wizard). If either mentions probe-only machinery, strip those lines.

- [ ] **Step 4: Write `server/src/prompts/vqa.txt`**

```
You answer questions from a blind or low-vision video creator about a single frame from their footage.

Rules:
- Answer in 1-3 short sentences, directly and factually.
- Describe only what is visible in this frame. If the answer is not visible, say so plainly (for example: "I can't tell from this frame.").
- Use concrete, spatial language (left/right, foreground/background, near/far).
- Do not start with "The image shows" or similar prefaces. Answer the question itself.
- Do not guess about things outside the frame, about intentions, or about what happens before or after this moment.
```

- [ ] **Step 5: Commit**

```powershell
git add docs/superpowers/specs server/src/prompts
git commit -m "docs: import Phase 1 spec and Gemini prompts from probe repo; add VQA prompt"
```

---

### Task 2: Migration 0006 — videos, segments, descriptions tables + RLS

Clients may SELECT (members only) and INSERT `videos` rows (member + self as uploader). All UPDATEs/DELETEs and all `segments`/`descriptions` writes happen server-side with the service role — deliberately no client policies for those. The client generates the video UUID itself so `storage_path` can be set at insert time (there is no UPDATE policy to fix it later).

**Files:**
- Create: `supabase/migrations/0006_videos_segments_descriptions.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Videos, segments, 3-level descriptions + RLS (Phase 1b)

create table public.videos (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  uploaded_by uuid not null references auth.users (id) on delete cascade,
  original_name text not null check (char_length(original_name) between 1 and 300),
  storage_path text not null,
  status text not null default 'uploading'
    check (status in ('uploading', 'processing', 'ready', 'failed')),
  error text,
  duration_seconds numeric,
  width integer,
  height integer,
  fps numeric,
  size_bytes bigint,
  segment_length_seconds integer not null default 5
    check (segment_length_seconds between 2 and 60),
  created_at timestamptz not null default now()
);

create index videos_project_id_idx on public.videos (project_id);

create table public.segments (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos (id) on delete cascade,
  idx integer not null check (idx >= 1),
  start_seconds numeric not null check (start_seconds >= 0),
  end_seconds numeric not null,
  label text not null,
  storage_path text not null,
  keyframe_path text not null,
  created_at timestamptz not null default now(),
  unique (video_id, idx),
  check (end_seconds > start_seconds)
);

create index segments_video_id_idx on public.segments (video_id);

create table public.descriptions (
  id uuid primary key default gen_random_uuid(),
  segment_id uuid not null references public.segments (id) on delete cascade,
  level integer not null check (level between 1 and 3),
  text text not null,
  source text not null default 'ai' check (source in ('ai', 'edited')),
  model text,
  generated_at timestamptz not null default now(),
  unique (segment_id, level)
);

create index descriptions_segment_id_idx on public.descriptions (segment_id);

alter table public.videos enable row level security;
alter table public.segments enable row level security;
alter table public.descriptions enable row level security;

create policy "members read videos" on public.videos
  for select using (public.is_project_member(project_id));

create policy "members add videos" on public.videos
  for insert with check (
    public.is_project_member(project_id) and uploaded_by = auth.uid()
  );

create policy "members read segments" on public.segments
  for select using (
    exists (
      select 1 from public.videos v
      where v.id = video_id and public.is_project_member(v.project_id)
    )
  );

create policy "members read descriptions" on public.descriptions
  for select using (
    exists (
      select 1 from public.segments s
      join public.videos v on v.id = s.video_id
      where s.id = segment_id and public.is_project_member(v.project_id)
    )
  );
```

- [ ] **Step 2: Apply to the hosted database** (this hits the LIVE project)

```powershell
npx supabase db push
```
Expected: `Applying migration 0006_videos_segments_descriptions.sql... Finished supabase db push.`

- [ ] **Step 3: Verify** — `npx supabase migration list` shows 0006 with matching Local and Remote. In the dashboard Table Editor, `videos`, `segments`, `descriptions` exist with the RLS badge.

- [ ] **Step 4: Commit**

```powershell
git add supabase/migrations
git commit -m "feat(db): videos/segments/descriptions schema with member-read RLS"
```

---

### Task 3: Migration 0007 — private storage bucket + storage RLS + 0006 review fixes

TUS uploads from the browser run as the signed-in user, so `storage.objects` needs member-gated select/insert/update policies. The server's service role bypasses RLS but NOT bucket-level mime/size limits, so `image/jpeg` must be allowed (keyframes live in the same bucket).

This migration also carries two fixes from the 0006 database review: (a) `videos.storage_path` gets a format check constraint so a member cannot point their row at another project's storage object (the service-role server would otherwise download it during processing); (b) `is_project_member` hoists `auth.uid()` into a scalar subquery so RLS policies don't re-evaluate it per row (standard Supabase pattern; fixes all policies from 0001 and 0006 at once).

**Files:**
- Create: `supabase/migrations/0007_videos_storage.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Review fixes for 0006:
-- (a) lock videos.storage_path to the canonical object path so a client row
--     can never point the processing server at another project's object
alter table public.videos
  add constraint videos_storage_path_format
  check (storage_path = project_id::text || '/' || id::text || '/original.mp4');

-- (b) hoist auth.uid() into an initplan so RLS policies evaluate it once per
--     query instead of once per row (applies to all policies using this helper)
create or replace function public.is_project_member(p_project_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from project_members
    where project_id = p_project_id and user_id = (select auth.uid())
  );
$$;

-- Private bucket for original videos, segment clips, and keyframes (Phase 1b).
-- Object names are '{project_id}/{video_id}/...' — the first path part gates access.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('videos', 'videos', false, 52428800, array['video/mp4', 'image/jpeg'])
on conflict (id) do nothing;

create policy "members read video objects" on storage.objects
  for select using (
    bucket_id = 'videos'
    and public.is_project_member(((string_to_array(name, '/'))[1])::uuid)
  );

create policy "members insert video objects" on storage.objects
  for insert with check (
    bucket_id = 'videos'
    and public.is_project_member(((string_to_array(name, '/'))[1])::uuid)
  );

-- TUS resumes/overwrites need update on the in-progress object row
create policy "members update video objects" on storage.objects
  for update using (
    bucket_id = 'videos'
    and public.is_project_member(((string_to_array(name, '/'))[1])::uuid)
  );
```

- [ ] **Step 2: Apply**

```powershell
npx supabase db push
```
Expected: applies cleanly. **Known failure mode:** if it errors with `must be owner of table objects`, the policies can't be created via migration on this project — move the three `create policy` statements into the dashboard SQL editor (run them there verbatim), keep only the bucket insert in the migration file, re-push, and note this in the commit message.

- [ ] **Step 3: Verify** — dashboard → Storage shows a private `videos` bucket; Storage → Policies lists the three policies (or they exist after the SQL-editor fallback).

- [ ] **Step 4: Commit**

```powershell
git add supabase/migrations
git commit -m "feat(db): private videos storage bucket with member-gated object RLS"
```

---

### Task 4: Extend the live E2E smoke with videos + storage RLS steps

Adds a third throwaway user ("outsider": allowlisted, signed in, never a member) so post-join negatives are real. New step 14 covers table RLS, step 15 covers storage RLS. Run order matters: these steps go AFTER step 13 (helper is already a member by then, which is what step 14c needs).

**Files:**
- Modify: `scripts/e2e-smoke.mjs`

- [ ] **Step 1: Add outsider + video state.** Near the existing declarations (`const creatorEmail = ...` block, around lines 104–114), add:

```js
const outsiderEmail = `e2e-outsider-${ts}@example.com`;
```
and alongside `let helperClient = null;`:
```js
let outsiderId = null;
let outsiderClient = null;
let videoId = null;
let videoStoragePath = null;
```

- [ ] **Step 2: Allowlist the outsider.** In Step 0, change the insert to three rows:

```js
const { error } = await adminClient
  .from('allowed_emails')
  .insert([{ email: creatorEmail }, { email: helperEmail }, { email: outsiderEmail }]);
assert(!error, '0: allowlist throwaway emails', `${creatorEmail}, ${helperEmail}, ${outsiderEmail}`, error?.message);
```

- [ ] **Step 3: Create + sign in the outsider.** Append to Step 1 (after the helper createUser block):

```js
const { data: ou, error: oe } = await adminClient.auth.admin.createUser({
  email: outsiderEmail,
  password,
  email_confirm: true,
});
assert(!oe, '1c: admin create outsider', `id=${ou?.user?.id}`, oe?.message);
outsiderId = ou.user.id;
```

Append to Step 2 (after the helper signIn block):

```js
outsiderClient = makeAnonClient();
const { data: os, error: ose } = await outsiderClient.auth.signInWithPassword({
  email: outsiderEmail,
  password,
});
assert(!ose && os?.user?.id === outsiderId, '2c: outsider signIn', `uid=${os?.user?.id}`, ose?.message ?? 'uid mismatch');
```

- [ ] **Step 4: Add Step 14 (videos/segments/descriptions RLS) after Step 13's closing brace, inside `runTests()`:**

```js
// -------------------------------------------------------------------------
// Step 14 — videos/segments/descriptions: member access, outsider blocked
// -------------------------------------------------------------------------
{
  videoId = crypto.randomUUID();
  videoStoragePath = `${projectId}/${videoId}/original.mp4`;
  const { error: insErr } = await creatorClient.from('videos').insert({
    id: videoId,
    project_id: projectId,
    uploaded_by: creatorId,
    original_name: 'smoke.mp4',
    storage_path: videoStoragePath,
  });
  assert(!insErr, '14a: member inserts videos row', `video=${videoId}`, insErr?.message);

  const { error: outErr } = await outsiderClient.from('videos').insert({
    project_id: projectId,
    uploaded_by: outsiderId,
    original_name: 'evil.mp4',
    storage_path: `${projectId}/${crypto.randomUUID()}/original.mp4`,
  });
  assert(outErr !== null, '14b: outsider videos insert blocked (RLS)', `code=${outErr?.code}`, 'expected RLS error but insert succeeded');

  const { data: helperRead, error: hrErr } = await helperClient
    .from('videos').select('id, status').eq('id', videoId);
  assert(!hrErr && helperRead?.length === 1, '14c: fellow member reads videos row', `status=${helperRead?.[0]?.status}`, hrErr?.message ?? `rows=${helperRead?.length}`);

  const { data: outsiderRead } = await outsiderClient
    .from('videos').select('id').eq('id', videoId);
  assert(outsiderRead?.length === 0, '14d: outsider sees 0 videos rows', 'RLS hides video', `expected 0 rows, got ${outsiderRead?.length}`);

  const { data: updated } = await creatorClient
    .from('videos').update({ status: 'ready' }).eq('id', videoId).select();
  assert(updated?.length === 0, '14e: client cannot update videos.status (no policy)', '0 rows updated', `unexpectedly updated ${updated?.length} row(s)`);

  const { data: segRow, error: segErr } = await adminClient.from('segments').insert({
    video_id: videoId,
    idx: 1,
    start_seconds: 0,
    end_seconds: 5,
    label: 'Scene 1',
    storage_path: `${projectId}/${videoId}/segments/seg_001.mp4`,
    keyframe_path: `${projectId}/${videoId}/keyframes/seg_001_kf.jpg`,
  }).select().single();
  assert(!segErr && segRow?.id, '14f: service role inserts segment', `segment=${segRow?.id}`, segErr?.message);

  const { error: descErr } = await adminClient.from('descriptions').insert([
    { segment_id: segRow.id, level: 1, text: 'smoke level 1', model: 'smoke' },
    { segment_id: segRow.id, level: 2, text: 'smoke level 2', model: 'smoke' },
    { segment_id: segRow.id, level: 3, text: 'smoke level 3', model: 'smoke' },
  ]);
  assert(!descErr, '14g: service role inserts 3 descriptions', '3 rows', descErr?.message);

  const { data: helperSegs, error: hsErr } = await helperClient
    .from('segments')
    .select('id, idx, descriptions ( level, text )')
    .eq('video_id', videoId);
  assert(
    !hsErr && helperSegs?.length === 1 && helperSegs[0].descriptions?.length === 3,
    '14h: member reads segment with nested descriptions',
    `descriptions=${helperSegs?.[0]?.descriptions?.length}`,
    hsErr?.message ?? `unexpected ${JSON.stringify(helperSegs)}`
  );

  const { data: outsiderSegs } = await outsiderClient
    .from('segments').select('id').eq('video_id', videoId);
  assert(outsiderSegs?.length === 0, '14i: outsider sees 0 segments', 'RLS hides segments', `expected 0 rows, got ${outsiderSegs?.length}`);
}
```

- [ ] **Step 5: Add Step 15 (storage RLS) immediately after Step 14:**

```js
// -------------------------------------------------------------------------
// Step 15 — storage bucket 'videos': member upload/download, outsider blocked
// -------------------------------------------------------------------------
{
  const bytes = new Blob([new Uint8Array(16)], { type: 'video/mp4' });

  const { error: upErr } = await creatorClient.storage
    .from('videos')
    .upload(videoStoragePath, bytes, { contentType: 'video/mp4', upsert: true });
  assert(!upErr, '15a: member uploads object to own project prefix', videoStoragePath, upErr?.message);

  const { error: outUpErr } = await outsiderClient.storage
    .from('videos')
    .upload(`${projectId}/${crypto.randomUUID()}/original.mp4`, bytes, { contentType: 'video/mp4' });
  assert(outUpErr !== null, '15b: outsider upload blocked (storage RLS)', `error=${outUpErr?.message}`, 'expected storage RLS error but upload succeeded');

  const { data: dl, error: dlErr } = await helperClient.storage
    .from('videos')
    .download(videoStoragePath);
  assert(!dlErr && dl, '15c: fellow member downloads object', `size=${dl?.size}`, dlErr?.message);

  const { data: outDl, error: outDlErr } = await outsiderClient.storage
    .from('videos')
    .download(videoStoragePath);
  assert(outDlErr !== null && !outDl, '15d: outsider download blocked', `error=${outDlErr?.message}`, 'expected storage RLS error but download succeeded');
}
```

- [ ] **Step 6: Extend cleanup.** In `cleanup()`: change C0's `.in('email', ...)` list to `[creatorEmail, helperEmail, outsiderEmail]`. Then add, immediately before the existing Step C3 (project delete) block:

```js
// Step C2b: remove smoke storage objects (project delete does not clear storage)
if (videoStoragePath) {
  const { error } = await adminClient.storage.from('videos').remove([videoStoragePath]);
  if (error) console.error(`  WARN  cleanup: storage object removal failed — ${error.message}`);
  else console.log('  OK    removed smoke storage object');
}
```

and after the existing C4 (creator delete) block:

```js
// Step C4b: Delete outsider user
if (outsiderId) {
  const { error } = await adminClient.auth.admin.deleteUser(outsiderId);
  if (error) console.error(`  WARN  cleanup: delete outsider user failed — ${error.message}`);
  else console.log(`  OK    deleted outsider user ${outsiderId}`);
}
```

(The `videos`/`segments`/`descriptions` rows are removed by the existing C3 project delete via `on delete cascade`.)

- [ ] **Step 7: Run the full smoke against the live backend**

```powershell
node --env-file=server/.env scripts/e2e-smoke.mjs
```
Expected: all previous steps still pass, plus 14a–14i and 15a–15d. 0 failed.

- [ ] **Step 8: Commit (only the smoke script — never `scripts/diag-smtp.mjs`)**

```powershell
git add scripts/e2e-smoke.mjs
git commit -m "test: E2E smoke covers videos/segments/descriptions RLS and storage policies"
```

---

### Task 5: Server deps, Gemini env wiring, live Gemini diagnostic

**Files:**
- Modify: `server/package.json` (via npm install)
- Modify: `server/.env.example`, `server/.env`
- Create: `scripts/diag-gemini.mjs`

- [ ] **Step 1: Install server deps**

```powershell
npm install -w server ffmpeg-static ffprobe-static @google/generative-ai
```
Expected: `server/package.json` gains `ffmpeg-static` (^5.x), `ffprobe-static` (^3.x), `@google/generative-ai` (^0.24.x).

- [ ] **Step 2: Add Gemini keys to `server/.env.example`** (append):

```
GEMINI_API_KEY=YOUR-GEMINI-API-KEY
GEMINI_MODEL=gemini-2.5-flash
```

- [ ] **Step 3: Wire the real key into `server/.env`.** The working key lives in the probe repo's gitignored root `.env` as `VITE_GEMINI_API_KEY` (file: `..\video-collab-probe\.env`). Read it from there and append to `server/.env` (gitignored):

```
GEMINI_API_KEY=<value of VITE_GEMINI_API_KEY from ../video-collab-probe/.env>
GEMINI_MODEL=gemini-2.5-flash
```
Verify with `git status` that `server/.env` does not appear.

- [ ] **Step 4: Write `scripts/diag-gemini.mjs`**

```js
/**
 * One-shot live Gemini check.
 * Run from repo root:  node --env-file=server/.env scripts/diag-gemini.mjs
 */
import { GoogleGenerativeAI } from '@google/generative-ai';

const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error('GEMINI_API_KEY is not set (server/.env).');
  process.exit(1);
}
const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const model = new GoogleGenerativeAI(key).getGenerativeModel({ model: modelName });

try {
  const result = await model.generateContent('Reply with the single word: ok');
  console.log(`OK    ${modelName} responded: ${result.response.text().trim()}`);
} catch (err) {
  console.error(`FAIL  ${modelName}: ${err.message}`);
  process.exit(1);
}
```

- [ ] **Step 5: Run it**

```powershell
node --env-file=server/.env scripts/diag-gemini.mjs
```
Expected: `OK    gemini-2.5-flash responded: ok` (any short reply counts — we are testing the key/model, not the text). **If this fails with an auth/quota error, STOP and tell the user (Lan)** — the key may need regenerating at https://aistudio.google.com/apikey; everything Gemini-dependent in Tasks 8–10 needs a working key only at runtime, but catching a dead key now is the point of this task.

- [ ] **Step 6: Commit**

```powershell
git add server/package.json package-lock.json server/.env.example scripts/diag-gemini.mjs
git commit -m "chore(server): ffmpeg/ffprobe/gemini deps, env wiring, gemini diagnostic"
```

---

### Task 6: Server service — video metadata via ffprobe

Test strategy for ffmpeg/ffprobe tasks: synthesize a tiny real clip with the bundled ffmpeg in `beforeAll` (no fixture files in git, no network). `testsrc` has no audio stream — that's fine and also what some phone clips look like.

**Files:**
- Create: `server/src/services/videoMeta.js`
- Test: `server/src/services/videoMeta.test.js`

- [ ] **Step 1: Write the failing test** — `server/src/services/videoMeta.test.js`

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { getVideoMeta } from './videoMeta.js'

const execFileAsync = promisify(execFile)

let workDir
let clipPath

beforeAll(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videometa-test-'))
  clipPath = path.join(workDir, 'clip.mp4')
  await execFileAsync(ffmpegPath, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=24',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clipPath,
  ])
}, 60000)

afterAll(async () => {
  await fs.rm(workDir, { recursive: true, force: true })
})

describe('getVideoMeta', () => {
  it('reads duration, dimensions, fps, and size from a real clip', async () => {
    const meta = await getVideoMeta(clipPath)
    expect(meta.duration_seconds).toBeGreaterThan(3.5)
    expect(meta.duration_seconds).toBeLessThan(4.5)
    expect(meta.width).toBe(320)
    expect(meta.height).toBe(240)
    expect(meta.fps).toBeCloseTo(24, 0)
    expect(meta.size_bytes).toBeGreaterThan(0)
  }, 30000)

  it('rejects a file with no video stream', async () => {
    const textPath = path.join(workDir, 'not-a-video.mp4')
    await fs.writeFile(textPath, 'plain text pretending to be video')
    await expect(getVideoMeta(textPath)).rejects.toThrow()
  }, 30000)
})
```

- [ ] **Step 2: Run to verify it fails**

```powershell
npm run test -w server
```
Expected: FAIL — `Cannot find module './videoMeta.js'`

- [ ] **Step 3: Write `server/src/services/videoMeta.js`**

```js
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ffprobeStatic from 'ffprobe-static'

const execFileAsync = promisify(execFile)

export async function getVideoMeta(filePath) {
  const { stdout } = await execFileAsync(
    ffprobeStatic.path,
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { maxBuffer: 10 * 1024 * 1024 }
  )
  const info = JSON.parse(stdout)
  const stream = (info.streams ?? []).find((s) => s.codec_type === 'video')
  if (!stream) throw new Error('no_video_stream')

  const duration = Number(info.format?.duration)
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('bad_duration')

  let fps = null
  const [num, den] = String(stream.r_frame_rate ?? '').split('/').map(Number)
  if (Number.isFinite(num) && Number.isFinite(den) && den > 0) fps = num / den

  return {
    duration_seconds: duration,
    width: stream.width ?? null,
    height: stream.height ?? null,
    fps,
    size_bytes: Number(info.format?.size) || null,
  }
}
```

(If the "no video stream" test fails because ffprobe exits non-zero on garbage input instead of returning empty JSON, that still rejects — the test passes either way by design.)

- [ ] **Step 4: Run to verify it passes**

```powershell
npm run test -w server
```
Expected: both new tests PASS (plus the 6 existing server tests).

- [ ] **Step 5: Commit**

```powershell
git add server/src/services/videoMeta.js server/src/services/videoMeta.test.js
git commit -m "feat(server): ffprobe video metadata service"
```

---

### Task 7: Server service — segmentation (boundary planning + ffmpeg cutting)

Port of the probe's `pipeline/services/segmentation.js`: fixed-length segments, re-encode for frame accuracy (`libx264`/`aac`, preset fast), midpoint keyframe JPEG (`-frames:v 1 -q:v 2`). `planSegments` is pure (unit-tested exhaustively); `cutSegment` is the ffmpeg wrapper (integration-tested once on a synthesized clip).

**Files:**
- Create: `server/src/services/segmentation.js`
- Test: `server/src/services/segmentation.test.js`

- [ ] **Step 1: Write the failing test** — `server/src/services/segmentation.test.js`

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { planSegments, cutSegment } from './segmentation.js'

const execFileAsync = promisify(execFile)

describe('planSegments', () => {
  it('splits an exact multiple into equal segments', () => {
    const plans = planSegments(10, 5)
    expect(plans).toHaveLength(2)
    expect(plans[0]).toMatchObject({
      id: 'seg_001', idx: 1, start_seconds: 0, end_seconds: 5, label: 'Scene 1', midpoint: 2.5,
    })
    expect(plans[1]).toMatchObject({
      id: 'seg_002', idx: 2, start_seconds: 5, end_seconds: 10, midpoint: 7.5,
    })
  })

  it('clamps the final segment to the video duration', () => {
    const plans = planSegments(7, 5)
    expect(plans).toHaveLength(2)
    expect(plans[1].start_seconds).toBe(5)
    expect(plans[1].end_seconds).toBe(7)
    expect(plans[1].midpoint).toBe(6)
  })

  it('handles a video shorter than one segment', () => {
    const plans = planSegments(2.4, 5)
    expect(plans).toHaveLength(1)
    expect(plans[0].end_seconds).toBe(2.4)
  })

  it('zero-pads ids past 9', () => {
    const plans = planSegments(55, 5)
    expect(plans[10].id).toBe('seg_011')
  })

  it('rejects nonsense inputs', () => {
    expect(() => planSegments(0, 5)).toThrow()
    expect(() => planSegments(10, 0)).toThrow()
    expect(() => planSegments(NaN, 5)).toThrow()
  })
})

describe('cutSegment', () => {
  let workDir
  let clipPath

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'segmentation-test-'))
    clipPath = path.join(workDir, 'clip.mp4')
    await execFileAsync(ffmpegPath, [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=24',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clipPath,
    ])
  }, 60000)

  afterAll(async () => {
    await fs.rm(workDir, { recursive: true, force: true })
  })

  it('produces a playable segment file and a keyframe jpeg', async () => {
    const [plan] = planSegments(6, 3)
    const { segFile, kfFile } = await cutSegment(clipPath, workDir, plan)

    const segStat = await fs.stat(segFile)
    expect(segStat.size).toBeGreaterThan(0)
    expect(segFile.endsWith('seg_001.mp4')).toBe(true)

    const kfBytes = await fs.readFile(kfFile)
    expect(kfBytes.length).toBeGreaterThan(0)
    // JPEG magic bytes
    expect(kfBytes[0]).toBe(0xff)
    expect(kfBytes[1]).toBe(0xd8)
  }, 60000)
})
```

- [ ] **Step 2: Run to verify it fails**

```powershell
npm run test -w server
```
Expected: FAIL — `Cannot find module './segmentation.js'`

- [ ] **Step 3: Write `server/src/services/segmentation.js`**

```js
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'

const execFileAsync = promisify(execFile)
const EXEC_OPTS = { maxBuffer: 10 * 1024 * 1024 }

export function planSegments(totalDuration, segmentLength) {
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) throw new Error('bad_duration')
  if (!Number.isFinite(segmentLength) || segmentLength <= 0) throw new Error('bad_segment_length')

  const count = Math.ceil(totalDuration / segmentLength)
  return Array.from({ length: count }, (_, i) => {
    const start = i * segmentLength
    const end = Math.min((i + 1) * segmentLength, totalDuration)
    return {
      id: `seg_${String(i + 1).padStart(3, '0')}`,
      idx: i + 1,
      start_seconds: start,
      end_seconds: end,
      label: `Scene ${i + 1}`,
      midpoint: start + (end - start) / 2,
    }
  })
}

// Re-encode (not stream-copy) so segment boundaries are frame-accurate:
// phone videos often have keyframes 5-10s apart.
export async function cutSegment(sourceFile, outDir, plan) {
  const segFile = path.join(outDir, `${plan.id}.mp4`)
  const kfFile = path.join(outDir, `${plan.id}_kf.jpg`)

  await execFileAsync(ffmpegPath, [
    '-y', '-ss', String(plan.start_seconds), '-to', String(plan.end_seconds),
    '-i', sourceFile,
    '-c:v', 'libx264', '-c:a', 'aac', '-preset', 'fast',
    segFile,
  ], EXEC_OPTS)

  await execFileAsync(ffmpegPath, [
    '-y', '-ss', String(plan.midpoint),
    '-i', sourceFile,
    '-frames:v', '1', '-q:v', '2',
    kfFile,
  ], EXEC_OPTS)

  return { segFile, kfFile }
}
```

- [ ] **Step 4: Run to verify it passes**

```powershell
npm run test -w server
```
Expected: all segmentation tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add server/src/services/segmentation.js server/src/services/segmentation.test.js
git commit -m "feat(server): fixed-length segmentation with midpoint keyframes (ported from probe)"
```

---

### Task 8: Server service — Gemini descriptions + VQA

Port of the probe's `geminiDescriptions.js`: keyframe JPEG (base64) + prompt template → JSON `{level_1, level_2, level_3}`; one retry with an explicit JSON reminder on parse failure. The model object is injected everywhere so tests never touch the network.

**Files:**
- Create: `server/src/services/descriptions.js`
- Test: `server/src/services/descriptions.test.js`

- [ ] **Step 1: Write the failing test** — `server/src/services/descriptions.test.js`

```js
import { describe, it, expect, vi } from 'vitest'
import {
  parseLevels,
  describeKeyframe,
  answerQuestion,
  loadDescriptionPrompt,
} from './descriptions.js'

const GOOD_JSON = JSON.stringify({
  level_1: 'A person walks down a hallway.',
  level_2: 'A person in a red coat walks down a narrow hallway with white walls.',
  level_3: 'Handheld shot, slight motion blur, warm indoor lighting, subject centered.',
})

function fakeModel(responses) {
  let call = 0
  return {
    calls: [],
    generateContent: vi.fn(async function (parts) {
      this.calls.push(parts)
      const text = responses[Math.min(call, responses.length - 1)]
      call += 1
      return { response: { text: () => text } }
    }),
  }
}

describe('parseLevels', () => {
  it('parses a plain JSON response', () => {
    const levels = parseLevels(GOOD_JSON)
    expect(levels.level_1).toMatch(/hallway/)
    expect(levels.level_3).toMatch(/Handheld/)
  })

  it('strips markdown fences', () => {
    const levels = parseLevels('```json\n' + GOOD_JSON + '\n```')
    expect(levels.level_2).toMatch(/red coat/)
  })

  it('rejects responses missing a level', () => {
    expect(() => parseLevels(JSON.stringify({ level_1: 'a', level_2: 'b' }))).toThrow()
  })

  it('rejects non-JSON', () => {
    expect(() => parseLevels('I cannot describe this image.')).toThrow()
  })
})

describe('describeKeyframe', () => {
  it('returns levels on a clean first response', async () => {
    const model = fakeModel([GOOD_JSON])
    const levels = await describeKeyframe(model, 'PROMPT', 'base64data')
    expect(levels.level_1).toMatch(/hallway/)
    expect(model.generateContent).toHaveBeenCalledTimes(1)
    const parts = model.calls[0]
    expect(parts[0].inlineData).toMatchObject({ mimeType: 'image/jpeg', data: 'base64data' })
    expect(parts[1].text).toBe('PROMPT')
  })

  it('retries once with a JSON reminder when the first response is junk', async () => {
    const model = fakeModel(['Sure! Here is your description...', GOOD_JSON])
    const levels = await describeKeyframe(model, 'PROMPT', 'base64data')
    expect(levels.level_2).toMatch(/red coat/)
    expect(model.generateContent).toHaveBeenCalledTimes(2)
    const retryParts = model.calls[1]
    expect(retryParts[retryParts.length - 1].text).toMatch(/only valid JSON/i)
  })

  it('throws when both attempts fail to parse', async () => {
    const model = fakeModel(['junk', 'more junk'])
    await expect(describeKeyframe(model, 'PROMPT', 'b64')).rejects.toThrow()
  })
})

describe('answerQuestion', () => {
  it('sends the keyframe and question, returns trimmed answer', async () => {
    const model = fakeModel(['  The mug is on the left side of the table. '])
    const answer = await answerQuestion(model, 'b64', 'Where is the mug?')
    expect(answer).toBe('The mug is on the left side of the table.')
    const parts = model.calls[0]
    expect(parts[0].inlineData.data).toBe('b64')
    expect(parts[1].text).toMatch(/Where is the mug\?/)
  })
})

describe('loadDescriptionPrompt', () => {
  it('concatenates shared style + description prompt from disk', async () => {
    const prompt = await loadDescriptionPrompt()
    expect(prompt).toMatch(/level_1/)
    expect(prompt.length).toBeGreaterThan(500)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```powershell
npm run test -w server
```
Expected: FAIL — `Cannot find module './descriptions.js'`

- [ ] **Step 3: Write `server/src/services/descriptions.js`**

```js
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GoogleGenerativeAI } from '@google/generative-ai'

const promptsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts')

export const DESCRIPTION_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash'

export function makeGeminiModel() {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY is not set')
  return new GoogleGenerativeAI(key).getGenerativeModel({ model: DESCRIPTION_MODEL })
}

export async function loadDescriptionPrompt() {
  const [style, desc] = await Promise.all([
    fs.readFile(path.join(promptsDir, '_shared_style.txt'), 'utf-8'),
    fs.readFile(path.join(promptsDir, 'description_generation.txt'), 'utf-8'),
  ])
  return `${style.trim()}\n\n${desc.trim()}\n`
}

export function parseLevels(responseText) {
  const cleaned = responseText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
  const parsed = JSON.parse(cleaned)
  for (const key of ['level_1', 'level_2', 'level_3']) {
    if (typeof parsed[key] !== 'string' || !parsed[key].trim()) {
      throw new Error(`missing_${key}`)
    }
  }
  return { level_1: parsed.level_1, level_2: parsed.level_2, level_3: parsed.level_3 }
}

export async function describeKeyframe(model, promptTemplate, jpegBase64) {
  const parts = [
    { inlineData: { mimeType: 'image/jpeg', data: jpegBase64 } },
    { text: promptTemplate },
  ]
  const first = await model.generateContent(parts)
  try {
    return parseLevels(first.response.text())
  } catch {
    const retry = await model.generateContent([
      ...parts,
      { text: '\n\nIMPORTANT: Return only valid JSON. No markdown, no explanation.' },
    ])
    return parseLevels(retry.response.text())
  }
}

export async function answerQuestion(model, jpegBase64, question) {
  const vqaPrompt = await fs.readFile(path.join(promptsDir, 'vqa.txt'), 'utf-8')
  const result = await model.generateContent([
    { inlineData: { mimeType: 'image/jpeg', data: jpegBase64 } },
    { text: `${vqaPrompt.trim()}\n\nQuestion: ${question}\n` },
  ])
  return result.response.text().trim()
}
```

- [ ] **Step 4: Run to verify it passes**

```powershell
npm run test -w server
```
Expected: all descriptions tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add server/src/services/descriptions.js server/src/services/descriptions.test.js
git commit -m "feat(server): gemini description + VQA service (ported from probe, model injected)"
```

---

### Task 9: Server service — processVideo orchestrator

Owns the status lifecycle. Every (re)run starts fresh: delete the video's `segments` rows (descriptions cascade), re-cut, re-describe — this is what makes the failed-state "Retry" button safe. Heavy deps (`getVideoMeta`, `cutSegment`, `describeKeyframe`, `loadDescriptionPrompt`) are injectable for tests; defaults are the real services.

**Files:**
- Create: `server/src/services/processVideo.js`
- Test: `server/src/services/processVideo.test.js`

- [ ] **Step 1: Write the failing test** — `server/src/services/processVideo.test.js`

```js
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { processVideo } from './processVideo.js'

const VIDEO = {
  id: 'vid-1',
  project_id: 'proj-1',
  storage_path: 'proj-1/vid-1/original.mp4',
  segment_length_seconds: 5,
  status: 'uploading',
}

function makeFakeSupabase({ video = VIDEO } = {}) {
  const updates = []
  const inserted = { segments: [], descriptions: [] }
  const uploads = []
  const deletes = []
  return {
    updates, inserted, uploads, deletes,
    from(table) {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: video, error: null }),
          }),
        }),
        update: (patch) => ({
          eq: async () => { updates.push({ table, patch }); return { error: null } },
        }),
        delete: () => ({
          eq: async (col, val) => { deletes.push({ table, col, val }); return { error: null } },
        }),
        insert: (rows) => {
          if (table === 'segments') {
            const row = { id: `segrow-${inserted.segments.length + 1}`, ...rows }
            inserted.segments.push(row)
            return { select: () => ({ single: async () => ({ data: row, error: null }) }) }
          }
          inserted.descriptions.push(...rows)
          return Promise.resolve({ error: null })
        },
      }
    },
    storage: {
      from: () => ({
        download: async () => ({ data: new Blob(['fake-mp4-bytes']), error: null }),
        upload: async (objectPath) => { uploads.push(objectPath); return { data: {}, error: null } },
      }),
    },
  }
}

function makeDeps({ describeFails = false } = {}) {
  return {
    getMeta: vi.fn(async () => ({
      duration_seconds: 7, width: 320, height: 240, fps: 24, size_bytes: 1000,
    })),
    cut: vi.fn(async (_src, outDir, plan) => {
      const segFile = path.join(outDir, `${plan.id}.mp4`)
      const kfFile = path.join(outDir, `${plan.id}_kf.jpg`)
      await fs.writeFile(segFile, 'seg-bytes')
      await fs.writeFile(kfFile, 'kf-bytes')
      return { segFile, kfFile }
    }),
    describe: vi.fn(async () => {
      if (describeFails) throw new Error('gemini_down')
      return { level_1: 'one', level_2: 'two', level_3: 'three' }
    }),
    loadPrompt: vi.fn(async () => 'PROMPT'),
  }
}

describe('processVideo', () => {
  it('downloads, segments, describes, and marks the video ready', async () => {
    const supabase = makeFakeSupabase()
    const deps = makeDeps()
    await processVideo({ supabase, model: {}, videoId: 'vid-1' }, deps)

    // 7s at 5s/segment -> 2 segments, 6 description rows
    expect(deps.cut).toHaveBeenCalledTimes(2)
    expect(supabase.inserted.segments).toHaveLength(2)
    expect(supabase.inserted.descriptions).toHaveLength(6)

    // segment + keyframe per segment uploaded under the video prefix
    expect(supabase.uploads).toContain('proj-1/vid-1/segments/seg_001.mp4')
    expect(supabase.uploads).toContain('proj-1/vid-1/keyframes/seg_002_kf.jpg')

    // previous segments cleared for idempotent reruns
    expect(supabase.deletes).toContainEqual({ table: 'segments', col: 'video_id', val: 'vid-1' })

    const statuses = supabase.updates
      .filter((u) => u.table === 'videos' && u.patch.status)
      .map((u) => u.patch.status)
    expect(statuses[0]).toBe('processing')
    expect(statuses[statuses.length - 1]).toBe('ready')

    // metadata written
    expect(supabase.updates.some((u) => u.patch.duration_seconds === 7)).toBe(true)
  })

  it('marks the video failed (with the error) and rethrows when a step blows up', async () => {
    const supabase = makeFakeSupabase()
    const deps = makeDeps({ describeFails: true })

    await expect(
      processVideo({ supabase, model: {}, videoId: 'vid-1' }, deps)
    ).rejects.toThrow('gemini_down')

    const last = supabase.updates[supabase.updates.length - 1]
    expect(last.patch.status).toBe('failed')
    expect(last.patch.error).toMatch(/gemini_down/)
  })
})

describe('recoverInterrupted', () => {
  it('marks stale processing rows failed at boot', async () => {
    const calls = []
    const supabase = {
      from: () => ({
        update: (patch) => ({
          eq: (col, val) => ({
            select: async () => {
              calls.push({ patch, col, val })
              return { data: [{ id: 'v1' }], error: null }
            },
          }),
        }),
      }),
    }
    await recoverInterrupted(supabase, () => {})
    expect(calls).toEqual([
      {
        patch: { status: 'failed', error: 'interrupted_by_restart' },
        col: 'status',
        val: 'processing',
      },
    ])
  })
})
```

(The test file's first import line becomes `import { processVideo, recoverInterrupted } from './processVideo.js'`.)

- [ ] **Step 2: Run to verify it fails**

```powershell
npm run test -w server
```
Expected: FAIL — `Cannot find module './processVideo.js'`

- [ ] **Step 3: Write `server/src/services/processVideo.js`**

```js
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getVideoMeta } from './videoMeta.js'
import { planSegments, cutSegment } from './segmentation.js'
import { describeKeyframe, loadDescriptionPrompt, DESCRIPTION_MODEL } from './descriptions.js'

export async function processVideo({ supabase, model, videoId, log = () => {} }, deps = {}) {
  const {
    getMeta = getVideoMeta,
    cut = cutSegment,
    describe = describeKeyframe,
    loadPrompt = loadDescriptionPrompt,
  } = deps

  const { data: video, error: videoErr } = await supabase
    .from('videos').select('*').eq('id', videoId).single()
  if (videoErr || !video) throw new Error('video_not_found')

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `vca-${videoId}-`))
  try {
    const claim = await supabase.from('videos').update({ status: 'processing', error: null }).eq('id', videoId)
    if (claim.error) throw new Error(`status_update_failed: ${claim.error.message}`)
    // Fresh start on every (re)run: descriptions cascade with their segments.
    const cleared = await supabase.from('segments').delete().eq('video_id', videoId)
    if (cleared.error) throw new Error(`segment_clear_failed: ${cleared.error.message}`)

    const { data: blob, error: dlErr } = await supabase.storage
      .from('videos').download(video.storage_path)
    if (dlErr || !blob) throw new Error(`download_failed: ${dlErr?.message ?? 'no data'}`)
    const sourceFile = path.join(workDir, 'original.mp4')
    await fs.writeFile(sourceFile, Buffer.from(await blob.arrayBuffer()))

    const meta = await getMeta(sourceFile)
    const metaUpd = await supabase.from('videos').update(meta).eq('id', videoId)
    if (metaUpd.error) throw new Error(`meta_update_failed: ${metaUpd.error.message}`)

    const prefix = `${video.project_id}/${video.id}`
    // round to 2dp: ffprobe durations carry sub-ms rounding that would
    // otherwise plan a 1-frame "ghost" segment at the tail
    const planDuration = Math.round(meta.duration_seconds * 100) / 100
    const plans = planSegments(planDuration, video.segment_length_seconds)
    const prompt = await loadPrompt()

    for (const plan of plans) {
      const { segFile, kfFile } = await cut(sourceFile, workDir, plan)
      const segmentPath = `${prefix}/segments/${plan.id}.mp4`
      const keyframePath = `${prefix}/keyframes/${plan.id}_kf.jpg`

      const segBytes = await fs.readFile(segFile)
      const kfBytes = await fs.readFile(kfFile)
      const segUp = await supabase.storage.from('videos')
        .upload(segmentPath, segBytes, { contentType: 'video/mp4', upsert: true })
      if (segUp.error) throw new Error(`upload_failed: ${segUp.error.message}`)
      const kfUp = await supabase.storage.from('videos')
        .upload(keyframePath, kfBytes, { contentType: 'image/jpeg', upsert: true })
      if (kfUp.error) throw new Error(`upload_failed: ${kfUp.error.message}`)

      const { data: segRow, error: segErr } = await supabase.from('segments').insert({
        video_id: videoId,
        idx: plan.idx,
        start_seconds: plan.start_seconds,
        end_seconds: plan.end_seconds,
        label: plan.label,
        storage_path: segmentPath,
        keyframe_path: keyframePath,
      }).select().single()
      if (segErr) throw new Error(`segment_insert_failed: ${segErr.message}`)

      const levels = await describe(model, prompt, kfBytes.toString('base64'))
      const { error: descErr } = await supabase.from('descriptions').insert(
        [1, 2, 3].map((level) => ({
          segment_id: segRow.id,
          level,
          text: levels[`level_${level}`],
          source: 'ai',
          model: DESCRIPTION_MODEL,
        }))
      )
      if (descErr) throw new Error(`description_insert_failed: ${descErr.message}`)

      log(`processed ${plan.id} (${plan.idx}/${plans.length})`)
    }

    const done = await supabase.from('videos').update({ status: 'ready' }).eq('id', videoId)
    if (done.error) throw new Error(`status_update_failed: ${done.error.message}`)
  } catch (err) {
    const failed = await supabase.from('videos')
      .update({ status: 'failed', error: String(err?.message ?? err) })
      .eq('id', videoId)
    if (failed.error) log(`could not record failure for ${videoId}: ${failed.error.message}`)
    throw err
  } finally {
    await fs.rm(workDir, { recursive: true, force: true })
  }
}

// Railway redeploys kill in-flight processing; without this sweep those rows
// would stay 'processing' forever (blocking the 409-guarded retry). Called
// once at server boot — safe because the service runs as a single instance.
export async function recoverInterrupted(supabase, log = console.log) {
  const { data, error } = await supabase
    .from('videos')
    .update({ status: 'failed', error: 'interrupted_by_restart' })
    .eq('status', 'processing')
    .select('id')
  if (error) log(`stale-processing sweep failed: ${error.message}`)
  else if (data?.length) log(`marked ${data.length} interrupted video(s) failed`)
}
```

- [ ] **Step 4: Run to verify it passes**

```powershell
npm run test -w server
```
Expected: both processVideo tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add server/src/services/processVideo.js server/src/services/processVideo.test.js
git commit -m "feat(server): processVideo orchestrator with status lifecycle and idempotent reruns"
```

---

### Task 10: Server routes — POST process + POST vqa, wired into app.js

`POST /api/videos/:id/process` checks membership, answers `202` immediately, then runs processing in-process (no queue — single Railway instance, pilot scale). `POST /api/segments/:id/vqa` is synchronous. Both reuse `requireAuth`. `makeApp` gains an optional `videoDeps` parameter so tests inject fakes; production `index.js` needs no changes.

**Files:**
- Create: `server/src/routes/videos.js`
- Test: `server/src/routes/videos.test.js`
- Modify: `server/src/app.js`

- [ ] **Step 1: Write the failing test** — `server/src/routes/videos.test.js`

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { makeApp } from '../app.js'

const user = { id: 'user-1', email: 'a@b.c' }

function makeFakeSupabase({ video, member, segment, keyframe } = {}) {
  const claims = []
  const releases = []
  return {
    claims,
    releases,
    auth: {
      getUser: vi.fn(async (token) =>
        token === 'good'
          ? { data: { user }, error: null }
          : { data: { user: null }, error: { message: 'bad' } }
      ),
    },
    from: (table) => ({
      select: () => ({
        eq: () => ({
          single: async () => {
            if (table === 'videos') return video ? { data: video, error: null } : { data: null, error: { message: 'not found' } }
            if (table === 'segments') return segment ? { data: segment, error: null } : { data: null, error: { message: 'not found' } }
            return { data: null, error: { message: 'unexpected table' } }
          },
          eq: () => ({
            maybeSingle: async () => ({ data: member ?? null, error: null }),
          }),
        }),
      }),
      // .update().eq() is awaited directly by the misconfig release (thenable),
      // and chained .neq().select() by the atomic claim
      update: (patch) => ({
        eq: (col, val) => ({
          neq: () => ({
            select: async () => {
              claims.push({ table, patch, col, val })
              return video && video.status === 'processing'
                ? { data: [], error: null }
                : { data: [{ id: val }], error: null }
            },
          }),
          then: (resolve) => {
            releases.push({ table, patch })
            resolve({ error: null })
          },
        }),
      }),
    }),
    storage: {
      from: () => ({
        download: async () =>
          keyframe ? { data: new Blob(['jpeg-bytes']), error: null } : { data: null, error: { message: 'missing' } },
      }),
    },
  }
}

const VIDEO = { id: 'vid-1', project_id: 'proj-1', status: 'uploading', storage_path: 'proj-1/vid-1/original.mp4' }
const MEMBER = { user_id: 'user-1' }

let processSpy
let vqaSpy

function appWith(supabase) {
  processSpy = vi.fn(async () => {})
  vqaSpy = vi.fn(async () => 'On the left.')
  return makeApp(supabase, {
    process: processSpy,
    getModel: () => ({}),
    vqa: vqaSpy,
  })
}

beforeEach(() => vi.clearAllMocks())

describe('POST /api/videos/:id/process', () => {
  it('requires auth', async () => {
    const res = await request(appWith(makeFakeSupabase({ video: VIDEO, member: MEMBER }))).post('/api/videos/vid-1/process')
    expect(res.status).toBe(401)
  })

  it('404s when the video does not exist', async () => {
    const res = await request(appWith(makeFakeSupabase({ member: MEMBER })))
      .post('/api/videos/vid-1/process').set('Authorization', 'Bearer good')
    expect(res.status).toBe(404)
  })

  it('403s when the caller is not a project member', async () => {
    const res = await request(appWith(makeFakeSupabase({ video: VIDEO })))
      .post('/api/videos/vid-1/process').set('Authorization', 'Bearer good')
    expect(res.status).toBe(403)
    expect(processSpy).not.toHaveBeenCalled()
  })

  it('409s when already processing (atomic claim returns no rows)', async () => {
    const res = await request(appWith(makeFakeSupabase({ video: { ...VIDEO, status: 'processing' }, member: MEMBER })))
      .post('/api/videos/vid-1/process').set('Authorization', 'Bearer good')
    expect(res.status).toBe(409)
    expect(processSpy).not.toHaveBeenCalled()
  })

  it('202s and kicks off processing for a member', async () => {
    const res = await request(appWith(makeFakeSupabase({ video: VIDEO, member: MEMBER })))
      .post('/api/videos/vid-1/process').set('Authorization', 'Bearer good')
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ ok: true })
    expect(processSpy).toHaveBeenCalledWith(expect.objectContaining({ videoId: 'vid-1' }))
  })

  it('202s for a failed video (retry claims it again)', async () => {
    const res = await request(appWith(makeFakeSupabase({ video: { ...VIDEO, status: 'failed' }, member: MEMBER })))
      .post('/api/videos/vid-1/process').set('Authorization', 'Bearer good')
    expect(res.status).toBe(202)
    expect(processSpy).toHaveBeenCalled()
  })

  it('500s and marks the video failed when the model cannot be constructed', async () => {
    const supabase = makeFakeSupabase({ video: VIDEO, member: MEMBER })
    const spy = vi.fn(async () => {})
    const app = makeApp(supabase, {
      process: spy,
      getModel: () => { throw new Error('GEMINI_API_KEY is not set') },
      vqa: vi.fn(),
    })
    const res = await request(app).post('/api/videos/vid-1/process').set('Authorization', 'Bearer good')
    expect(res.status).toBe(500)
    expect(spy).not.toHaveBeenCalled()
    expect(supabase.releases.some((r) => r.patch.status === 'failed')).toBe(true)
  })
})

describe('POST /api/segments/:id/vqa', () => {
  const SEGMENT = { id: 'seg-row-1', video_id: 'vid-1', keyframe_path: 'proj-1/vid-1/keyframes/seg_001_kf.jpg' }

  it('404s on an unknown segment', async () => {
    const res = await request(appWith(makeFakeSupabase({ video: VIDEO, member: MEMBER, keyframe: true })))
      .post('/api/segments/seg-row-1/vqa').set('Authorization', 'Bearer good')
      .send({ question: 'Where is the mug?' })
    expect(res.status).toBe(404)
  })

  it('400s on a missing question', async () => {
    const res = await request(appWith(makeFakeSupabase({ video: VIDEO, member: MEMBER, segment: SEGMENT, keyframe: true })))
      .post('/api/segments/seg-row-1/vqa').set('Authorization', 'Bearer good').send({})
    expect(res.status).toBe(400)
  })

  it('403s for non-members', async () => {
    const res = await request(appWith(makeFakeSupabase({ video: VIDEO, segment: SEGMENT, keyframe: true })))
      .post('/api/segments/seg-row-1/vqa').set('Authorization', 'Bearer good')
      .send({ question: 'Where is the mug?' })
    expect(res.status).toBe(403)
    expect(vqaSpy).not.toHaveBeenCalled()
  })

  it('answers for a member', async () => {
    const res = await request(appWith(makeFakeSupabase({ video: VIDEO, member: MEMBER, segment: SEGMENT, keyframe: true })))
      .post('/api/segments/seg-row-1/vqa').set('Authorization', 'Bearer good')
      .send({ question: 'Where is the mug?' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ answer: 'On the left.' })
    expect(vqaSpy).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'Where is the mug?')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```powershell
npm run test -w server
```
Expected: FAIL (makeApp doesn't accept videoDeps / routes module missing).

- [ ] **Step 3: Write `server/src/routes/videos.js`**

```js
import { Router } from 'express'
import { makeRequireAuth } from '../middleware/requireAuth.js'
import { processVideo } from '../services/processVideo.js'
import { makeGeminiModel, answerQuestion } from '../services/descriptions.js'

export function makeVideoRoutes(supabase, deps = {}) {
  const {
    process = processVideo,
    getModel = makeGeminiModel,
    vqa = answerQuestion,
  } = deps

  const router = Router()
  const requireAuth = makeRequireAuth(supabase)

  async function loadVideoForMember(videoId, userId) {
    const { data: video } = await supabase
      .from('videos')
      .select('id, project_id, status, storage_path')
      .eq('id', videoId)
      .single()
    if (!video) return { status: 404, error: 'video_not_found' }

    const { data: member } = await supabase
      .from('project_members')
      .select('user_id')
      .eq('project_id', video.project_id)
      .eq('user_id', userId)
      .maybeSingle()
    if (!member) return { status: 403, error: 'not_a_member' }

    return { video }
  }

  router.post('/api/videos/:id/process', requireAuth, async (req, res) => {
    const found = await loadVideoForMember(req.params.id, req.user.id)
    if (found.error) return res.status(found.status).json({ error: found.error })

    // atomic claim: of two concurrent calls, exactly one flips the status
    const { data: claimed, error: claimErr } = await supabase
      .from('videos')
      .update({ status: 'processing', error: null })
      .eq('id', found.video.id)
      .neq('status', 'processing')
      .select('id')
    if (claimErr) return res.status(500).json({ error: 'claim_failed' })
    if (!claimed?.length) return res.status(409).json({ error: 'already_processing' })

    // construct the model BEFORE answering: a missing GEMINI_API_KEY must
    // surface as a 5xx, not strand the video after a 202
    let model
    try {
      model = getModel()
    } catch (err) {
      await supabase.from('videos')
        .update({ status: 'failed', error: `server_misconfigured: ${err.message}` })
        .eq('id', found.video.id)
      return res.status(500).json({ error: 'server_misconfigured' })
    }

    res.status(202).json({ ok: true })
    try {
      await process({ supabase, model, videoId: found.video.id, log: console.log })
    } catch (err) {
      // status already set to 'failed' by processVideo; log for Railway logs
      console.error(`processing failed for ${found.video.id}:`, err)
    }
  })

  router.post('/api/segments/:id/vqa', requireAuth, async (req, res) => {
    const question = String(req.body?.question ?? '').trim()
    if (!question || question.length > 500) {
      return res.status(400).json({ error: 'bad_question' })
    }

    const { data: segment } = await supabase
      .from('segments')
      .select('id, video_id, keyframe_path')
      .eq('id', req.params.id)
      .single()
    if (!segment) return res.status(404).json({ error: 'segment_not_found' })

    const found = await loadVideoForMember(segment.video_id, req.user.id)
    if (found.error) return res.status(found.status).json({ error: found.error })

    const { data: blob, error: dlErr } = await supabase.storage
      .from('videos')
      .download(segment.keyframe_path)
    if (dlErr || !blob) return res.status(500).json({ error: 'keyframe_unavailable' })

    try {
      const base64 = Buffer.from(await blob.arrayBuffer()).toString('base64')
      const answer = await vqa(getModel(), base64, question)
      res.json({ answer })
    } catch (err) {
      console.error(`vqa failed for segment ${segment.id}:`, err)
      res.status(502).json({ error: 'vqa_failed' })
    }
  })

  return router
}
```

- [ ] **Step 4: Modify `server/src/app.js`** — full new contents:

```js
import express from 'express'
import cors from 'cors'
import { makeRequireAuth } from './middleware/requireAuth.js'
import { makeVideoRoutes } from './routes/videos.js'

export function makeApp(supabaseClient, videoDeps = {}) {
  const app = express()
  app.use(cors({ origin: process.env.WEB_ORIGIN?.split(',') ?? true }))
  app.use(express.json())

  app.get('/health', (_req, res) => res.json({ ok: true }))

  const requireAuth = makeRequireAuth(supabaseClient)
  app.get('/api/me', requireAuth, (req, res) => {
    res.json({ id: req.user.id, email: req.user.email })
  })

  app.use(makeVideoRoutes(supabaseClient, videoDeps))

  return app
}
```

(If the current `app.js` differs cosmetically from this, preserve its existing lines and only ADD the import and the `app.use(makeVideoRoutes(...))` line plus the `videoDeps` parameter.)

- [ ] **Step 4b: Modify `server/src/index.js`** — sweep videos stranded in 'processing' by a mid-run restart (Railway redeploys kill in-flight processing) before the server starts listening. Add the import and one call:

```js
import { recoverInterrupted } from './services/processVideo.js'
```

and immediately before the `makeApp(supabaseAdmin).listen(...)` line:

```js
await recoverInterrupted(supabaseAdmin)
```

(`server/` is ESM — top-level await is fine.)

- [ ] **Step 5: Run all server tests**

```powershell
npm run test -w server
```
Expected: all PASS (existing app/middleware tests + new route tests).

- [ ] **Step 6: Commit**

```powershell
git add server/src/routes server/src/app.js
git commit -m "feat(server): video process + segment VQA endpoints with membership checks"
```

---

### Task 11: Web libs — TUS upload helper + server API client

Supabase Storage's resumable endpoint is `{SUPABASE_URL}/storage/v1/upload/resumable` and **requires exactly 6 MiB chunks**. Both helpers take everything as parameters (no hidden imports of env) so tests are trivial.

**Files:**
- Create: `web/src/lib/uploadVideo.js`, `web/src/lib/serverApi.js`
- Test: `web/src/lib/uploadVideo.test.js`, `web/src/lib/serverApi.test.js`

- [ ] **Step 1: Install tus-js-client**

```powershell
npm install -w web tus-js-client
```

- [ ] **Step 2: Write the failing uploadVideo test** — `web/src/lib/uploadVideo.test.js`

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

const created = []
vi.mock('tus-js-client', () => {
  class FakeUpload {
    constructor(file, options) {
      this.file = file
      this.options = options
      created.push(this)
    }
    findPreviousUploads() { return Promise.resolve([]) }
    resumeFromPreviousUpload() {}
    start() {
      this.options.onProgress?.(3 * 1024 * 1024, 6 * 1024 * 1024)
      this.options.onSuccess?.()
    }
  }
  return { Upload: FakeUpload }
})

import { uploadVideo } from './uploadVideo'

beforeEach(() => { created.length = 0 })

describe('uploadVideo', () => {
  it('uploads via the supabase resumable endpoint with 6MB chunks and reports progress', async () => {
    const file = new File(['x'], 'clip.mp4', { type: 'video/mp4' })
    const onProgress = vi.fn()

    await uploadVideo({
      supabaseUrl: 'https://ref.supabase.co',
      accessToken: 'tok-123',
      objectName: 'proj-1/vid-1/original.mp4',
      file,
      onProgress,
    })

    const upload = created[0]
    expect(upload.options.endpoint).toBe('https://ref.supabase.co/storage/v1/upload/resumable')
    expect(upload.options.chunkSize).toBe(6 * 1024 * 1024)
    expect(upload.options.headers.authorization).toBe('Bearer tok-123')
    expect(upload.options.metadata).toMatchObject({
      bucketName: 'videos',
      objectName: 'proj-1/vid-1/original.mp4',
      contentType: 'video/mp4',
    })
    expect(onProgress).toHaveBeenCalledWith(50)
  })

  it('rejects when the upload errors', async () => {
    const file = new File(['x'], 'clip.mp4', { type: 'video/mp4' })
    // make the fake fail this time
    const { Upload } = await import('tus-js-client')
    Upload.prototype.start = function () { this.options.onError?.(new Error('network gone')) }

    await expect(
      uploadVideo({
        supabaseUrl: 'https://ref.supabase.co',
        accessToken: 't',
        objectName: 'p/v/original.mp4',
        file,
      })
    ).rejects.toThrow('network gone')
  })
})
```

- [ ] **Step 3: Run to verify it fails**

```powershell
npm run test -w web -- --run
```
Expected: FAIL — cannot resolve `./uploadVideo`

- [ ] **Step 4: Write `web/src/lib/uploadVideo.js`**

```js
import * as tus from 'tus-js-client'

// Supabase Storage resumable uploads require exactly 6MiB chunks.
const CHUNK_SIZE = 6 * 1024 * 1024

export function uploadVideo({ supabaseUrl, accessToken, objectName, file, onProgress }) {
  return new Promise((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: `${supabaseUrl}/storage/v1/upload/resumable`,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: {
        authorization: `Bearer ${accessToken}`,
        'x-upsert': 'true',
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      chunkSize: CHUNK_SIZE,
      metadata: {
        bucketName: 'videos',
        objectName,
        contentType: file.type || 'video/mp4',
        cacheControl: '3600',
      },
      onError: reject,
      onProgress: (sent, total) => {
        if (total > 0) onProgress?.(Math.round((sent / total) * 100))
      },
      onSuccess: () => resolve(),
    })

    upload.findPreviousUploads().then((previous) => {
      if (previous.length > 0) upload.resumeFromPreviousUpload(previous[0])
      upload.start()
    })
  })
}
```

- [ ] **Step 5: Write the failing serverApi test** — `web/src/lib/serverApi.test.js`

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetSession } = vi.hoisted(() => ({ mockGetSession: vi.fn() }))
vi.mock('./supabaseClient', () => ({
  supabase: { auth: { getSession: mockGetSession } },
}))

import { serverPost } from './serverApi'

beforeEach(() => {
  vi.unstubAllGlobals()
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'tok-1' } } })
})

describe('serverPost', () => {
  it('POSTs with the bearer token and parses JSON', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await serverPost('/api/videos/v1/process')
    expect(result).toEqual({ ok: true })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/videos\/v1\/process$/)
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer tok-1')
  })

  it('throws the server error code on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'not_a_member' }), { status: 403 })))
    await expect(serverPost('/api/videos/v1/process')).rejects.toThrow('not_a_member')
  })

  it('throws when signed out', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } })
    await expect(serverPost('/x')).rejects.toThrow('not_signed_in')
  })
})
```

- [ ] **Step 6: Run to verify it fails**

```powershell
npm run test -w web -- --run
```
Expected: FAIL — cannot resolve `./serverApi`

- [ ] **Step 7: Write `web/src/lib/serverApi.js`**

```js
import { supabase } from './supabaseClient'

export async function serverPost(pathname, body) {
  const { data } = await supabase.auth.getSession()
  const token = data?.session?.access_token
  if (!token) throw new Error('not_signed_in')

  const res = await fetch(`${import.meta.env.VITE_SERVER_URL}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.json())?.error ?? ''
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail || `server_error_${res.status}`)
  }
  return res.status === 204 ? null : res.json()
}
```

- [ ] **Step 8: Run to verify everything passes**

```powershell
npm run test -w web -- --run
```
Expected: all web tests PASS.

- [ ] **Step 9: Commit**

```powershell
git add web/package.json package-lock.json web/src/lib/uploadVideo.js web/src/lib/uploadVideo.test.js web/src/lib/serverApi.js web/src/lib/serverApi.test.js
git commit -m "feat(web): TUS resumable upload helper and authed server API client"
```

---

### Task 12: Web — VideosSection on the ProjectPage

Upload flow: generate the video UUID client-side → insert the `videos` row (path is `{projectId}/{videoId}/original.mp4`) → TUS upload → `POST /api/videos/:id/process` → poll the table every 4s while anything is uploading/processing. Status transitions to `ready`/`failed` are announced (failures assertively). Failed videos get a Retry button.

**Files:**
- Create: `web/src/components/VideosSection.jsx`
- Test: `web/src/components/VideosSection.test.jsx`
- Modify: `web/src/pages/ProjectPage.jsx`, `web/src/pages/ProjectPage.test.jsx`

- [ ] **Step 1: Write the failing test** — `web/src/components/VideosSection.test.jsx`

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

const { mockOrder, mockInsert, mockUpload, mockServerPost, mockAnnounce } = vi.hoisted(() => ({
  mockOrder: vi.fn(),
  mockInsert: vi.fn(),
  mockUpload: vi.fn(),
  mockServerPost: vi.fn(),
  mockAnnounce: vi.fn(),
}))

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ order: mockOrder })),
      })),
      insert: mockInsert,
    })),
  },
}))
vi.mock('../lib/uploadVideo', () => ({ uploadVideo: mockUpload }))
vi.mock('../lib/serverApi', () => ({ serverPost: mockServerPost }))
vi.mock('../utils/announcer', () => ({ announce: mockAnnounce }))
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ session: { access_token: 'tok', user: { id: 'u1' } }, user: { id: 'u1' } }),
}))

import VideosSection from './VideosSection'

function renderSection() {
  return render(
    <MemoryRouter>
      <VideosSection projectId="proj-1" />
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockOrder.mockResolvedValue({ data: [], error: null })
  mockInsert.mockResolvedValue({ error: null })
  mockUpload.mockResolvedValue()
  mockServerPost.mockResolvedValue({ ok: true })
})

describe('VideosSection', () => {
  it('shows an empty state when there are no videos', async () => {
    renderSection()
    expect(await screen.findByText(/no videos yet/i)).toBeInTheDocument()
  })

  it('lists videos with their status', async () => {
    mockOrder.mockResolvedValue({
      data: [
        { id: 'v1', original_name: 'kitchen.mp4', status: 'ready', error: null, created_at: '2026-06-12' },
        { id: 'v2', original_name: 'garden.mp4', status: 'processing', error: null, created_at: '2026-06-12' },
      ],
      error: null,
    })
    renderSection()
    expect(await screen.findByText('kitchen.mp4')).toBeInTheDocument()
    expect(screen.getByText(/ready/i)).toBeInTheDocument()
    expect(screen.getByText(/processing/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /open kitchen\.mp4/i })).toHaveAttribute(
      'href', '/projects/proj-1/videos/v1'
    )
  })

  it('uploads a chosen file: inserts row, runs TUS upload, triggers processing', async () => {
    renderSection()
    const input = await screen.findByLabelText(/upload a video/i)
    const file = new File(['vid'], 'myclip.mp4', { type: 'video/mp4' })
    await userEvent.upload(input, file)

    await waitFor(() => expect(mockServerPost).toHaveBeenCalled())

    const inserted = mockInsert.mock.calls[0][0]
    expect(inserted.project_id).toBe('proj-1')
    expect(inserted.uploaded_by).toBe('u1')
    expect(inserted.original_name).toBe('myclip.mp4')
    expect(inserted.storage_path).toBe(`proj-1/${inserted.id}/original.mp4`)

    expect(mockUpload).toHaveBeenCalledWith(
      expect.objectContaining({ objectName: inserted.storage_path, accessToken: 'tok' })
    )
    expect(mockServerPost).toHaveBeenCalledWith(`/api/videos/${inserted.id}/process`)
    expect(mockAnnounce).toHaveBeenCalledWith('Upload complete. Processing started.')
  })

  it('announces assertively and shows the error when the upload fails', async () => {
    mockUpload.mockRejectedValue(new Error('network gone'))
    renderSection()
    const input = await screen.findByLabelText(/upload a video/i)
    await userEvent.upload(input, new File(['v'], 'bad.mp4', { type: 'video/mp4' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/network gone/)
    expect(mockAnnounce).toHaveBeenCalledWith('Upload failed', { assertive: true })
    expect(mockServerPost).not.toHaveBeenCalled()
  })

  it('retries a failed video', async () => {
    mockOrder.mockResolvedValue({
      data: [{ id: 'v9', original_name: 'broken.mp4', status: 'failed', error: 'gemini_down', created_at: '2026-06-12' }],
      error: null,
    })
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: /retry broken\.mp4/i }))
    expect(mockServerPost).toHaveBeenCalledWith('/api/videos/v9/process')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```powershell
npm run test -w web -- --run
```
Expected: FAIL — cannot resolve `./VideosSection`

- [ ] **Step 3: Write `web/src/components/VideosSection.jsx`**

```jsx
import { useEffect, useRef, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../contexts/AuthContext'
import { uploadVideo } from '../lib/uploadVideo'
import { serverPost } from '../lib/serverApi'
import { announce } from '../utils/announcer'

const STATUS_LABELS = {
  uploading: 'Uploading',
  processing: 'Processing',
  ready: 'Ready',
  failed: 'Failed',
}

const POLL_MS = 4000

export default function VideosSection({ projectId }) {
  const { session, user } = useAuth()
  const [videos, setVideos] = useState(null) // null = loading
  const [progress, setProgress] = useState(null) // null | 0-100
  const [error, setError] = useState(null)
  const prevStatuses = useRef({})

  const loadVideos = useCallback(async () => {
    const { data, error: loadErr } = await supabase
      .from('videos')
      .select('id, original_name, status, error, created_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
    if (loadErr) {
      setError(loadErr.message)
      return
    }
    for (const v of data) {
      const prev = prevStatuses.current[v.id]
      if (prev && prev !== v.status) {
        if (v.status === 'ready') announce(`${v.original_name} is ready`)
        if (v.status === 'failed') announce(`Processing failed for ${v.original_name}`, { assertive: true })
      }
      prevStatuses.current[v.id] = v.status
    }
    setVideos(data)
  }, [projectId])

  useEffect(() => {
    loadVideos()
  }, [loadVideos])

  const hasActive = (videos ?? []).some((v) => v.status === 'uploading' || v.status === 'processing')
  useEffect(() => {
    if (!hasActive) return undefined
    const timer = setInterval(loadVideos, POLL_MS)
    return () => clearInterval(timer)
  }, [hasActive, loadVideos])

  async function handleFileChange(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)

    const videoId = crypto.randomUUID()
    const storagePath = `${projectId}/${videoId}/original.mp4`

    const { error: insertErr } = await supabase.from('videos').insert({
      id: videoId,
      project_id: projectId,
      uploaded_by: user.id,
      original_name: file.name,
      storage_path: storagePath,
    })
    if (insertErr) {
      setError(insertErr.message)
      announce('Upload could not start', { assertive: true })
      return
    }

    announce('Upload started')
    setProgress(0)
    loadVideos()
    try {
      await uploadVideo({
        supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
        accessToken: session.access_token,
        objectName: storagePath,
        file,
        onProgress: setProgress,
      })
      await serverPost(`/api/videos/${videoId}/process`)
      announce('Upload complete. Processing started.')
    } catch (err) {
      setError(String(err?.message ?? err))
      announce('Upload failed', { assertive: true })
    } finally {
      setProgress(null)
      loadVideos()
    }
  }

  async function handleRetry(video) {
    setError(null)
    try {
      await serverPost(`/api/videos/${video.id}/process`)
      announce(`Processing restarted for ${video.original_name}`)
      loadVideos()
    } catch (err) {
      setError(String(err?.message ?? err))
    }
  }

  return (
    <section aria-labelledby="videos-heading" className="mb-6">
      <h2 id="videos-heading" className="mb-2 text-xl font-semibold">
        Videos
      </h2>

      <label htmlFor="video-file" className="mb-2 block text-lg">
        Upload a video (MP4, up to 50 MB)
      </label>
      <input
        id="video-file"
        type="file"
        accept="video/mp4"
        disabled={progress !== null}
        onChange={handleFileChange}
        className="mb-3 block w-full rounded border border-gray-400 p-3"
      />

      {progress !== null && (
        <p role="status" className="mb-3 text-lg">
          Uploading… {progress}%
        </p>
      )}
      {error && (
        <p role="alert" className="mb-3 text-red-700">
          {error}
        </p>
      )}

      {videos === null ? (
        <p role="status">Loading videos…</p>
      ) : videos.length === 0 ? (
        <p>No videos yet. Upload one above to get started.</p>
      ) : (
        <ul className="space-y-2">
          {videos.map((v) => (
            <li key={v.id} className="rounded border border-gray-300 p-3">
              <p className="text-lg font-medium">{v.original_name}</p>
              <p>
                Status: {STATUS_LABELS[v.status] ?? v.status}
                {v.status === 'failed' && v.error ? ` — ${v.error}` : ''}
              </p>
              {v.status === 'ready' && (
                <Link
                  to={`/projects/${projectId}/videos/${v.id}`}
                  aria-label={`Open ${v.original_name}`}
                  className="mt-1 inline-block min-h-12 underline"
                >
                  View scenes and descriptions
                </Link>
              )}
              {v.status === 'failed' && (
                <button
                  onClick={() => handleRetry(v)}
                  aria-label={`Retry ${v.original_name}`}
                  className="mt-1 min-h-12 rounded border border-gray-400 px-3"
                >
                  Retry processing
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
```

- [ ] **Step 4: Run to verify the new tests pass**

```powershell
npm run test -w web -- --run
```
Expected: VideosSection tests PASS. (If `crypto.randomUUID` is undefined in jsdom, add `if (!globalThis.crypto?.randomUUID) globalThis.crypto = { ...globalThis.crypto, randomUUID: () => '00000000-0000-4000-8000-000000000000' }` to `web/src/test/setup.js` — Node ≥19 normally provides it.)

- [ ] **Step 5: Render it on the ProjectPage.** In `web/src/pages/ProjectPage.jsx`, add the import:

```jsx
import VideosSection from '../components/VideosSection'
```

and render `<VideosSection projectId={id} />` between the members `</section>` and the "Invite a helper" button.

- [ ] **Step 6: Stub it in the existing ProjectPage tests.** In `web/src/pages/ProjectPage.test.jsx`, add alongside the other `vi.mock` calls:

```jsx
vi.mock('../components/VideosSection', () => ({
  default: () => <section>videos section stub</section>,
}))
```

- [ ] **Step 7: Run the full web suite**

```powershell
npm run test -w web -- --run
```
Expected: all PASS (existing ProjectPage tests unaffected).

- [ ] **Step 8: Commit**

```powershell
git add web/src/components/VideosSection.jsx web/src/components/VideosSection.test.jsx web/src/pages/ProjectPage.jsx web/src/pages/ProjectPage.test.jsx
git commit -m "feat(web): video upload with progress, status list, retry, and SR announcements"
```

---

### Task 13: Web — VideoPage (segments + descriptions viewer) and route

Read-only viewer proving the pipeline end-to-end: original video playback (signed URL), a description-detail radio group (level 1/2/3), and the segment list with keyframe images. The full creator/helper editor port is Phase 1c.

**Files:**
- Create: `web/src/pages/VideoPage.jsx`
- Test: `web/src/pages/VideoPage.test.jsx`
- Modify: `web/src/App.jsx`

- [ ] **Step 1: Write the failing test** — `web/src/pages/VideoPage.test.jsx`

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { mockVideoSingle, mockSegmentsOrder, mockSignedUrls } = vi.hoisted(() => ({
  mockVideoSingle: vi.fn(),
  mockSegmentsOrder: vi.fn(),
  mockSignedUrls: vi.fn(),
}))

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    from: vi.fn((table) => {
      if (table === 'videos') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: mockVideoSingle })) })) }
      }
      if (table === 'segments') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ order: mockSegmentsOrder })) })) }
      }
      return {}
    }),
    storage: { from: vi.fn(() => ({ createSignedUrls: mockSignedUrls })) },
  },
}))

import VideoPage from './VideoPage'

const VIDEO = {
  id: 'v1',
  original_name: 'kitchen.mp4',
  status: 'ready',
  duration_seconds: 7,
  storage_path: 'p1/v1/original.mp4',
}

const SEGMENTS = [
  {
    id: 's1', idx: 1, label: 'Scene 1', start_seconds: 0, end_seconds: 5,
    keyframe_path: 'p1/v1/keyframes/seg_001_kf.jpg',
    descriptions: [
      { level: 1, text: 'Someone stirs a pot.' },
      { level: 2, text: 'A person in a blue apron stirs a steel pot on a gas hob.' },
      { level: 3, text: 'Static shot, slightly overexposed near the window.' },
    ],
  },
  {
    id: 's2', idx: 2, label: 'Scene 2', start_seconds: 5, end_seconds: 7,
    keyframe_path: 'p1/v1/keyframes/seg_002_kf.jpg',
    descriptions: [
      { level: 1, text: 'They taste the food.' },
      { level: 2, text: 'The person lifts a wooden spoon to taste.' },
      { level: 3, text: 'Close-up, shallow focus on the spoon.' },
    ],
  },
]

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/projects/p1/videos/v1']}>
      <Routes>
        <Route path="/projects/:projectId/videos/:videoId" element={<VideoPage />} />
      </Routes>
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockVideoSingle.mockResolvedValue({ data: VIDEO, error: null })
  mockSegmentsOrder.mockResolvedValue({ data: SEGMENTS, error: null })
  mockSignedUrls.mockResolvedValue({
    data: [
      { path: 'p1/v1/original.mp4', signedUrl: 'https://signed/original', error: null },
      { path: 'p1/v1/keyframes/seg_001_kf.jpg', signedUrl: 'https://signed/kf1', error: null },
      { path: 'p1/v1/keyframes/seg_002_kf.jpg', signedUrl: 'https://signed/kf2', error: null },
    ],
    error: null,
  })
})

describe('VideoPage', () => {
  it('shows the video title, player, and level-1 descriptions by default', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: 'kitchen.mp4' })).toBeInTheDocument()
    expect(await screen.findByText('Someone stirs a pot.')).toBeInTheDocument()
    expect(screen.getByText('They taste the food.')).toBeInTheDocument()
    expect(screen.queryByText(/blue apron/)).not.toBeInTheDocument()
  })

  it('switches description level with the radio group', async () => {
    renderPage()
    await screen.findByText('Someone stirs a pot.')
    await userEvent.click(screen.getByRole('radio', { name: /what's visible/i }))
    expect(screen.getByText(/blue apron/)).toBeInTheDocument()
    expect(screen.queryByText('Someone stirs a pot.')).not.toBeInTheDocument()
  })

  it('renders keyframes with the scene label as alt text', async () => {
    renderPage()
    const img = await screen.findByAltText(/keyframe for scene 1/i)
    expect(img).toHaveAttribute('src', 'https://signed/kf1')
  })

  it('shows an error when the video is not accessible', async () => {
    mockVideoSingle.mockResolvedValue({ data: null, error: { message: 'nope' } })
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent(/not found, or you are not a member/i)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```powershell
npm run test -w web -- --run
```
Expected: FAIL — cannot resolve `./VideoPage`

- [ ] **Step 3: Write `web/src/pages/VideoPage.jsx`**

```jsx
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'

const LEVELS = [
  { value: 1, label: "What's happening" },
  { value: 2, label: "What's visible" },
  { value: 3, label: 'How it looks' },
]

function formatTime(seconds) {
  const s = Math.round(Number(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function VideoPage() {
  const { projectId, videoId } = useParams()
  const [video, setVideo] = useState(null)
  const [segments, setSegments] = useState([])
  const [urls, setUrls] = useState({})
  const [level, setLevel] = useState(1)
  const [error, setError] = useState(null)

  useEffect(() => {
    async function load() {
      const { data: vid, error: vidErr } = await supabase
        .from('videos')
        .select('id, original_name, status, duration_seconds, storage_path')
        .eq('id', videoId)
        .single()
      if (vidErr || !vid) {
        setError('Video not found, or you are not a member of this project.')
        return
      }
      setVideo(vid)

      const { data: segs, error: segErr } = await supabase
        .from('segments')
        .select('id, idx, label, start_seconds, end_seconds, keyframe_path, descriptions ( level, text )')
        .eq('video_id', videoId)
        .order('idx')
      if (segErr) {
        setError(segErr.message)
        return
      }
      setSegments(segs ?? [])

      const paths = [vid.storage_path, ...(segs ?? []).map((s) => s.keyframe_path)]
      const { data: signed } = await supabase.storage.from('videos').createSignedUrls(paths, 3600)
      const map = {}
      for (const item of signed ?? []) {
        if (!item.error) map[item.path] = item.signedUrl
      }
      setUrls(map)
    }
    load()
  }, [videoId])

  if (error) {
    return (
      <main id="main" className="mx-auto max-w-lg p-4">
        <p role="alert">{error}</p>
        <Link to={`/projects/${projectId}`} className="underline">Back to project</Link>
      </main>
    )
  }
  if (!video) {
    return (
      <main id="main" className="p-4">
        <p role="status">Loading…</p>
      </main>
    )
  }

  return (
    <main id="main" className="mx-auto max-w-lg p-4">
      <Link to={`/projects/${projectId}`} className="mb-4 inline-block underline">
        ← Back to project
      </Link>
      <h1 className="mb-4 text-2xl font-bold">{video.original_name}</h1>

      {urls[video.storage_path] && (
        <video
          controls
          src={urls[video.storage_path]}
          className="mb-6 w-full rounded"
          aria-label={`Original video: ${video.original_name}`}
        />
      )}

      <fieldset className="mb-6">
        <legend className="mb-2 text-lg font-semibold">Description detail</legend>
        <div className="flex flex-col gap-2">
          {LEVELS.map((opt) => (
            <label key={opt.value} className="flex min-h-12 items-center gap-2 text-lg">
              <input
                type="radio"
                name="description-level"
                value={opt.value}
                checked={level === opt.value}
                onChange={() => setLevel(opt.value)}
              />
              {opt.label}
            </label>
          ))}
        </div>
      </fieldset>

      <section aria-labelledby="scenes-heading">
        <h2 id="scenes-heading" className="mb-2 text-xl font-semibold">
          Scenes ({segments.length})
        </h2>
        <ol className="space-y-3">
          {segments.map((seg) => {
            const description = seg.descriptions?.find((d) => d.level === level)
            return (
              <li key={seg.id} className="rounded border border-gray-300 p-3">
                {urls[seg.keyframe_path] && (
                  <img
                    src={urls[seg.keyframe_path]}
                    alt={`Keyframe for ${seg.label}`}
                    className="mb-2 w-full rounded"
                  />
                )}
                <p className="text-lg font-medium">
                  {seg.label} ({formatTime(seg.start_seconds)}–{formatTime(seg.end_seconds)})
                </p>
                <p>{description?.text ?? 'No description available.'}</p>
              </li>
            )
          })}
        </ol>
      </section>
    </main>
  )
}
```

- [ ] **Step 4: Wire the route.** In `web/src/App.jsx`, add the import:

```jsx
import VideoPage from './pages/VideoPage'
```

and add inside `<Routes>`, next to the existing `/projects/:id` route:

```jsx
<Route path="/projects/:projectId/videos/:videoId" element={<RequireAuth><VideoPage /></RequireAuth>} />
```

- [ ] **Step 5: Run the full test suite (web + server)**

```powershell
npm test
```
Expected: all PASS.

- [ ] **Step 6: Build check**

```powershell
npm run build
```
Expected: clean Vite production build.

- [ ] **Step 7: Commit**

```powershell
git add web/src/pages/VideoPage.jsx web/src/pages/VideoPage.test.jsx web/src/App.jsx
git commit -m "feat(web): video page with signed-url playback, keyframes, and 3-level descriptions"
```

---

### Task 14: Local end-to-end run, deploy, production smoke (HUMAN STEPS)

**Files:**
- None (config + verification)

- [ ] **Step 1: Local full-pipeline verification.** Run both dev processes:

```powershell
npm run dev:server   # terminal 1
npm run dev:web      # terminal 2
```

In a browser at http://localhost:5173: sign in, open a project, upload a short MP4 (≤50 MB — a 20–30s phone clip is ideal). Watch status go Uploading → Processing → Ready (poll cadence 4s), then open "View scenes and descriptions" and confirm: video plays, keyframes render, all 3 description levels read sensibly. Check the server terminal for `processed seg_NNN` logs and no errors.

- [ ] **Step 2: HUMAN STEP — Railway env.** Ask Lan to add to the Railway service variables: `GEMINI_API_KEY` (same value as `server/.env`) and `GEMINI_MODEL=gemini-2.5-flash`, and to confirm `WEB_ORIGIN=https://video-collab-app-web.vercel.app` is set. Railway redeploys on save.

- [ ] **Step 3: HUMAN STEP — Vercel env.** Ask Lan to set `VITE_SERVER_URL=https://server-production-25dd.up.railway.app` in the Vercel project's environment variables (it currently points at localhost), then trigger a redeploy (the Step 5 git push will do it).

- [ ] **Step 4: Re-run the live backend smoke**

```powershell
node --env-file=server/.env scripts/e2e-smoke.mjs
```
Expected: 0 failed.

- [ ] **Step 5: Push to deploy**

```powershell
git push origin main
```
Vercel deploys `web/`; Railway deploys `server/` (verify `GET https://server-production-25dd.up.railway.app/health` returns `{"ok":true}` after the deploy).

**Contingency:** `ffmpeg-static`/`ffprobe-static` download their binaries during `npm install`. If the Railway build fails on that download, switch the service to apt-installed ffmpeg instead: add a `nixpacks.toml` in `server/` with `[phases.setup] aptPkgs = ["ffmpeg"]`, and set Railway env vars the code can prefer (or patch the two services to use `process.env.FFMPEG_PATH` / `FFPROBE_PATH` when set).

- [ ] **Step 6: HUMAN STEP — production smoke on a phone.** On the production site (https://video-collab-app-web.vercel.app): sign in, upload a short phone video, watch it reach Ready, open the scenes view, switch description levels. Then as the second account (join via code), open the same project and confirm the helper sees the video and descriptions too. Confirm devtools/network shows no Gemini key and no service_role key anywhere in the browser.

- [ ] **Step 7: Tag the milestone**

```powershell
git tag phase-1b
git push --tags
```

---

## After this plan

- **Plan 1c — Collaboration & sync:** `project_state` table with versioned writes, Supabase Realtime channel (presence + postgres_changes), port of the creator/helper UI components and `usePlaybackEngine` from the probe repo, two-browser Playwright smoke. Written after 1b ships, against the code that exists.
- **Pre-Phase-3 de-risk spike:** 1-day Gemini prompt test against real participant footage for proactive-suggestion quality (spec §"Pre-Phase-1 de-risk task" — still outstanding, not blocking 1c).
