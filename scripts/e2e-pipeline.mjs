/**
 * Full-pipeline E2E test for video-collab-app (Phase 1b).
 *
 * Proves the whole flow against the LIVE Supabase project + LIVE Gemini API
 * + a LOCAL server instance:
 *   throwaway user -> project -> videos row -> real storage upload
 *   -> POST /api/videos/:id/process (user JWT) -> ffmpeg segmentation
 *   -> Gemini descriptions -> segments/descriptions rows -> status 'ready'
 *   -> signed URLs -> VQA endpoint. Then cleans everything up.
 *
 * Prereq: the server must be running locally (npm run dev:server).
 *
 * Run from repo root:
 *   node --env-file=server/.env scripts/e2e-pipeline.mjs
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (+ PORT) in server/.env.
 * Reads VITE_SUPABASE_ANON_KEY from web/.env.local automatically.
 */

import { createClient } from '@supabase/supabase-js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';
import ffmpegPath from 'ffmpeg-static';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dir, '..');

/** Parse a .env file into a plain object (handles KEY=VALUE, ignores comments). */
function parseEnvFile(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const result = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    result[key] = val;
  }
  return result;
}

const webEnv = parseEnvFile(join(repoRoot, 'web', '.env.local'));
const ANON_KEY = webEnv['VITE_SUPABASE_ANON_KEY'];

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SERVER_URL = `http://localhost:${process.env.PORT || 3001}`;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (server/.env).');
  process.exit(1);
}
if (!ANON_KEY) {
  console.error('VITE_SUPABASE_ANON_KEY not found in web/.env.local.');
  process.exit(1);
}

// Result tracking
const results = [];
let failureCount = 0;

function pass(step, detail = '') {
  const msg = `  PASS  [${step}]${detail ? ' — ' + detail : ''}`;
  console.log(msg);
  results.push({ step, status: 'PASS', detail });
}

function fail(step, detail) {
  const msg = `  FAIL  [${step}] — ${detail}`;
  console.error(msg);
  results.push({ step, status: 'FAIL', detail });
  failureCount++;
}

function assert(condition, step, successDetail, failDetail) {
  if (condition) {
    pass(step, successDetail);
  } else {
    fail(step, failDetail);
    throw new Error(`Assertion failed at step: ${step} — ${failDetail}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function makeAnonClient() {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const ts = Date.now();
const userEmail = `e2e-pipeline-${ts}@example.com`;
const password = `Pipe!${crypto.randomBytes(8).toString('hex')}`;

let userId = null;
let userClient = null;
let accessToken = null;
let projectId = null;
let videoId = null;
let videoStoragePath = null;
let workDir = null;
let segments = []; // rows from DB after processing
let firstSegmentId = null;
let processingMs = null;

console.log('\n=== video-collab-app full-pipeline E2E ===\n');
console.log(`  Supabase URL : ${SUPABASE_URL}`);
console.log(`  Server URL   : ${SERVER_URL}`);
console.log(`  User email   : ${userEmail}`);
console.log('');

// ---------------------------------------------------------------------------
// Main test run
// ---------------------------------------------------------------------------

async function runTests() {
  // -------------------------------------------------------------------------
  // P0 — Allowlist the throwaway email (signup trigger blocks others)
  // -------------------------------------------------------------------------
  {
    const { error } = await adminClient.from('allowed_emails').insert({ email: userEmail });
    assert(!error, 'P0: allowlist throwaway email', userEmail, error?.message);
  }

  // -------------------------------------------------------------------------
  // P1 — Admin creates the user; sign in with an anon client
  // -------------------------------------------------------------------------
  {
    const { data: cu, error: ce } = await adminClient.auth.admin.createUser({
      email: userEmail,
      password,
      email_confirm: true,
    });
    assert(!ce, 'P1a: admin createUser', `id=${cu?.user?.id}`, ce?.message);
    userId = cu.user.id;

    userClient = makeAnonClient();
    const { data: signIn, error: se } = await userClient.auth.signInWithPassword({
      email: userEmail,
      password,
    });
    assert(
      !se && signIn?.user?.id === userId && signIn?.session?.access_token,
      'P1b: signInWithPassword yields session',
      `uid=${signIn?.user?.id}`,
      se?.message ?? 'no session/uid mismatch'
    );
    accessToken = signIn.session.access_token;
  }

  // -------------------------------------------------------------------------
  // P2 — Creator inserts a project
  // -------------------------------------------------------------------------
  {
    const { data, error } = await userClient
      .from('projects')
      .insert({ title: 'E2E pipeline project', owner_id: userId })
      .select('id')
      .single();
    assert(!error && data?.id, 'P2: insert project', `project_id=${data?.id}`, error?.message);
    projectId = data.id;
  }

  // -------------------------------------------------------------------------
  // P3 — Synthesize a ~12s test clip with ffmpeg (12s / 5s segments -> 3)
  // -------------------------------------------------------------------------
  let clipBytes = null;
  {
    workDir = await fs.mkdtemp(join(os.tmpdir(), 'vca-e2e-'));
    const clipFile = join(workDir, 'testclip.mp4');
    await execFileAsync(ffmpegPath, [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=12:size=320x240:rate=30',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'fast',
      clipFile,
    ], { maxBuffer: 10 * 1024 * 1024 });
    clipBytes = await fs.readFile(clipFile);
    assert(
      clipBytes.length > 10_000,
      'P3: synthesize 12s test clip',
      `${clipBytes.length} bytes`,
      `clip too small (${clipBytes.length} bytes)`
    );
  }

  // -------------------------------------------------------------------------
  // P4 — Client-side insert of the videos row (status defaults to 'uploading')
  // -------------------------------------------------------------------------
  {
    videoId = crypto.randomUUID();
    videoStoragePath = `${projectId}/${videoId}/original.mp4`;
    const { data, error } = await userClient
      .from('videos')
      .insert({
        id: videoId,
        project_id: projectId,
        uploaded_by: userId,
        original_name: 'e2e-pipeline.mp4',
        storage_path: videoStoragePath,
      })
      .select('id, status')
      .single();
    assert(
      !error && data?.id === videoId && data?.status === 'uploading',
      'P4: insert videos row',
      `video=${videoId}, status=${data?.status}`,
      error?.message ?? `unexpected ${JSON.stringify(data)}`
    );
  }

  // -------------------------------------------------------------------------
  // P5 — Upload the clip bytes to storage (anon client, storage RLS)
  // -------------------------------------------------------------------------
  {
    const { error } = await userClient.storage
      .from('videos')
      .upload(videoStoragePath, clipBytes, { contentType: 'video/mp4', upsert: true });
    assert(!error, 'P5: upload clip to storage', `${videoStoragePath} (${clipBytes.length} bytes)`, error?.message);
  }

  // -------------------------------------------------------------------------
  // P6 — POST /api/videos/:id/process with the user's JWT -> 202 {ok:true}
  // -------------------------------------------------------------------------
  let processingStart = null;
  {
    const res = await fetch(`${SERVER_URL}/api/videos/${videoId}/process`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = await res.json().catch(() => null);
    assert(
      res.status === 202 && body?.ok === true,
      'P6: process endpoint accepts (202)',
      `status=${res.status}`,
      `status=${res.status}, body=${JSON.stringify(body)}`
    );
    processingStart = Date.now();
  }

  // -------------------------------------------------------------------------
  // P7 — Poll the videos row every 3s up to 4 minutes until status 'ready'
  // -------------------------------------------------------------------------
  {
    const deadline = Date.now() + 4 * 60 * 1000;
    let status = null;
    let rowError = null;
    while (Date.now() < deadline) {
      const { data, error } = await userClient
        .from('videos')
        .select('status, error')
        .eq('id', videoId)
        .single();
      if (error) {
        rowError = `poll query failed: ${error.message}`;
        break;
      }
      status = data.status;
      rowError = data.error;
      if (status === 'ready' || status === 'failed') break;
      await sleep(3000);
    }
    processingMs = Date.now() - processingStart;
    assert(
      status === 'ready',
      'P7: video reaches status ready',
      `took ${(processingMs / 1000).toFixed(1)}s`,
      `status=${status} after ${(processingMs / 1000).toFixed(1)}s${rowError ? `, error=${rowError}` : ''}`
    );
  }

  // -------------------------------------------------------------------------
  // P8 — Assert segments (3 rows, idx 1..3, paths under prefix) and
  //      descriptions (9 rows, 3 per segment, non-empty text, model recorded)
  // -------------------------------------------------------------------------
  {
    const { data: segs, error: segErr } = await userClient
      .from('segments')
      .select('id, idx, storage_path, keyframe_path, descriptions ( id, level, text, model )')
      .eq('video_id', videoId)
      .order('idx', { ascending: true });
    assert(!segErr, 'P8a: read segments with nested descriptions', `rows=${segs?.length}`, segErr?.message);
    segments = segs ?? [];

    const idxOk = segments.length === 3 && segments.every((s, i) => s.idx === i + 1);
    assert(
      idxOk,
      'P8b: exactly 3 segments ordered idx 1..3',
      `idx=[${segments.map((s) => s.idx).join(',')}]`,
      `got ${segments.length} segments, idx=[${segments.map((s) => s.idx).join(',')}]`
    );
    firstSegmentId = segments[0].id;

    const prefix = `${projectId}/${videoId}/`;
    const pathsOk = segments.every(
      (s) =>
        s.storage_path.startsWith(`${prefix}segments/`) &&
        s.keyframe_path.startsWith(`${prefix}keyframes/`)
    );
    assert(
      pathsOk,
      'P8c: segment + keyframe paths under video prefix',
      prefix,
      `unexpected paths: ${JSON.stringify(segments.map((s) => [s.storage_path, s.keyframe_path]))}`
    );

    const allDescs = segments.flatMap((s) => s.descriptions ?? []);
    const perSegmentOk = segments.every((s) => (s.descriptions ?? []).length === 3);
    assert(
      allDescs.length === 9 && perSegmentOk,
      'P8d: 9 descriptions, 3 per segment',
      `total=${allDescs.length}`,
      `total=${allDescs.length}, per-segment=[${segments.map((s) => s.descriptions?.length).join(',')}]`
    );
    const textOk = allDescs.every((d) => typeof d.text === 'string' && d.text.trim().length > 0);
    const modelOk = allDescs.every((d) => typeof d.model === 'string' && d.model.trim().length > 0);
    assert(
      textOk && modelOk,
      'P8e: descriptions have non-empty text and model recorded',
      `model=${allDescs[0]?.model}`,
      `textOk=${textOk}, modelOk=${modelOk}`
    );
  }

  // -------------------------------------------------------------------------
  // P9 — Signed URLs for original + all keyframes; fetch one keyframe
  // -------------------------------------------------------------------------
  {
    const paths = [videoStoragePath, ...segments.map((s) => s.keyframe_path)];
    const { data: signed, error: signErr } = await userClient.storage
      .from('videos')
      .createSignedUrls(paths, 120);
    const allSigned =
      !signErr && signed?.length === paths.length && signed.every((s) => !s.error && s.signedUrl);
    assert(
      allSigned,
      'P9a: createSignedUrls for original + 3 keyframes',
      `${paths.length} URLs signed`,
      signErr?.message ?? `entries=${JSON.stringify(signed?.map((s) => s.error))}`
    );

    const kfUrl = signed[1].signedUrl; // first keyframe
    const res = await fetch(kfUrl);
    const buf = Buffer.from(await res.arrayBuffer());
    const isJpeg = buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    assert(
      res.status === 200 && buf.length > 0 && isJpeg,
      'P9b: fetched keyframe signed URL is a real JPEG',
      `status=${res.status}, bytes=${buf.length}`,
      `status=${res.status}, bytes=${buf.length}, jpegMagic=${isJpeg}`
    );
  }

  // -------------------------------------------------------------------------
  // P10 — VQA on the first segment
  // -------------------------------------------------------------------------
  {
    const res = await fetch(`${SERVER_URL}/api/segments/${firstSegmentId}/vqa`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ question: 'What colours are in this frame?' }),
    });
    const body = await res.json().catch(() => null);
    const answer = body?.answer;
    assert(
      res.status === 200 && typeof answer === 'string' && answer.trim().length > 0,
      'P10: VQA returns a non-empty answer',
      `answer="${answer}"`,
      `status=${res.status}, body=${JSON.stringify(body)}`
    );
    console.log(`\n  VQA answer: ${answer}\n`);
  }

  // -------------------------------------------------------------------------
  // P11 — Negatives: process with no auth -> 401; VQA missing question -> 400
  // -------------------------------------------------------------------------
  {
    const noAuth = await fetch(`${SERVER_URL}/api/videos/${videoId}/process`, { method: 'POST' });
    assert(
      noAuth.status === 401,
      'P11a: process without auth header is 401',
      `status=${noAuth.status}`,
      `expected 401, got ${noAuth.status}`
    );

    const badVqa = await fetch(`${SERVER_URL}/api/segments/${firstSegmentId}/vqa`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert(
      badVqa.status === 400,
      'P11b: VQA with missing question is 400',
      `status=${badVqa.status}`,
      `expected 400, got ${badVqa.status}`
    );
  }
}

// ---------------------------------------------------------------------------
// Cleanup (always runs)
// ---------------------------------------------------------------------------

async function cleanup() {
  console.log('\n--- cleanup ---');

  // C1: remove storage objects (original + segments + keyframes)
  if (projectId && videoId) {
    // Prefer paths recorded in DB; fall back to the conventional names so a
    // partial run still cleans whatever processing managed to upload.
    let segPaths = segments.flatMap((s) => [s.storage_path, s.keyframe_path]);
    if (segPaths.length === 0) {
      const { data } = await adminClient
        .from('segments')
        .select('storage_path, keyframe_path')
        .eq('video_id', videoId);
      segPaths = (data ?? []).flatMap((s) => [s.storage_path, s.keyframe_path]);
    }
    if (segPaths.length === 0) {
      const prefix = `${projectId}/${videoId}`;
      for (let i = 1; i <= 3; i++) {
        const id = `seg_${String(i).padStart(3, '0')}`;
        segPaths.push(`${prefix}/segments/${id}.mp4`, `${prefix}/keyframes/${id}_kf.jpg`);
      }
    }
    const allPaths = [videoStoragePath, ...segPaths].filter(Boolean);
    const { error } = await adminClient.storage.from('videos').remove(allPaths);
    if (error) console.error(`  WARN  cleanup: storage removal failed — ${error.message}`);
    else console.log(`  OK    removed ${allPaths.length} storage object(s)`);
  }

  // C2: delete the project (cascades videos/segments/descriptions)
  if (projectId) {
    const { error } = await adminClient.from('projects').delete().eq('id', projectId);
    if (error) console.error(`  WARN  cleanup: project delete failed — ${error.message}`);
    else console.log(`  OK    deleted project ${projectId} (cascades videos/segments/descriptions)`);
  }

  // C3: remove allowlist row
  {
    const { error } = await adminClient.from('allowed_emails').delete().eq('email', userEmail);
    if (error) console.error(`  WARN  cleanup: allowlist removal failed — ${error.message}`);
    else console.log('  OK    removed throwaway email from allowlist');
  }

  // C4: delete the user
  if (userId) {
    const { error } = await adminClient.auth.admin.deleteUser(userId);
    if (error) console.error(`  WARN  cleanup: delete user failed — ${error.message}`);
    else console.log(`  OK    deleted user ${userId}`);
  }

  // C5: verify no objects remain under the project prefix
  if (projectId && videoId) {
    const prefixes = [
      `${projectId}/${videoId}`,
      `${projectId}/${videoId}/segments`,
      `${projectId}/${videoId}/keyframes`,
    ];
    let leftover = 0;
    for (const p of prefixes) {
      const { data, error } = await adminClient.storage.from('videos').list(p);
      if (error) {
        console.error(`  WARN  cleanup: list ${p} failed — ${error.message}`);
        continue;
      }
      leftover += (data ?? []).filter((entry) => entry.id !== null).length;
    }
    if (leftover === 0) console.log('  OK    no storage objects remain under the project prefix');
    else console.error(`  WARN  ${leftover} storage object(s) still present under ${projectId}/`);
  }

  // C6: remove local temp dir
  if (workDir) {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    console.log('  OK    removed local temp dir');
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

try {
  // Sanity: the local server must be up before we burn through setup steps.
  const health = await fetch(`${SERVER_URL}/health`).then((r) => r.json()).catch(() => null);
  if (health?.ok !== true) {
    console.error(`Server not reachable at ${SERVER_URL}/health — start it with: npm run dev:server`);
    process.exit(1);
  }

  await runTests();
} catch (err) {
  // Non-assertion errors (unexpected throws)
  if (!results.some((r) => r.status === 'FAIL')) {
    fail('unexpected', err.message);
  }
  // Continue to cleanup
} finally {
  await cleanup();
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n=== SUMMARY ===\n');
for (const r of results) {
  console.log(`  ${r.status}  [${r.step}]${r.detail ? ' — ' + r.detail : ''}`);
}
if (processingMs !== null) {
  console.log(`\n  processing time: ${(processingMs / 1000).toFixed(1)}s`);
}
console.log(`\n  ${results.filter((r) => r.status === 'PASS').length} passed, ${failureCount} failed.\n`);

process.exit(failureCount > 0 ? 1 : 0);
