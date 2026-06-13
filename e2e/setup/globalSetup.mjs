/**
 * Playwright globalSetup (Phase 1c Task 12).
 *
 * Provisions, against the LIVE Supabase project + the LOCAL server, a complete
 * two-person editable project:
 *   - allowlist a throwaway creator email AND a throwaway helper email
 *   - admin-create both users (shared word-based password, email_confirm)
 *   - creator inserts a project; service-role inserts the helper's
 *     project_members row (role 'helper') directly (RLS bypassed)
 *   - synthesize a ~12s clip with ffmpeg-static (12s / 5s segments -> 3 scenes)
 *   - insert the videos row, upload the clip to storage
 *   - POST the local server /api/videos/:id/process with the creator's JWT
 *   - poll until the video reaches status 'ready' (segments + descriptions)
 *
 * Writes credentials + ids + storage paths to e2e/.state.json (gitignored).
 * globalTeardown.mjs reads that file and removes everything (mirrors the
 * scripts/e2e-pipeline.mjs cleanup exactly).
 *
 * Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (+ optional PORT) from
 * server/.env; VITE_SUPABASE_ANON_KEY from web/.env.local — both read here so
 * `npm run e2e` needs no extra flags.
 */

import { createClient } from '@supabase/supabase-js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import crypto from 'node:crypto'
import ffmpegPath from 'ffmpeg-static'

const execFileAsync = promisify(execFile)
const __dir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dir, '..', '..')
const STATE_PATH = join(__dir, '..', '.state.json')

function parseEnvFile(filePath) {
  const text = readFileSync(filePath, 'utf8')
  const result = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
    result[key] = val
  }
  return result
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Typeable word-based password (project convention — never mixed-case gibberish).
const WORDS = ['mango', 'river', 'cedar', 'amber', 'pebble', 'lumen', 'orbit', 'willow', 'marble', 'cobalt']
function wordPassword() {
  const pick = () => WORDS[crypto.randomInt(WORDS.length)]
  return `${pick()}-${pick()}-${crypto.randomInt(10, 99)}`
}

export default async function globalSetup() {
  const serverEnv = parseEnvFile(join(repoRoot, 'server', '.env'))
  const webEnv = parseEnvFile(join(repoRoot, 'web', '.env.local'))

  const SUPABASE_URL = process.env.SUPABASE_URL || serverEnv.SUPABASE_URL
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || serverEnv.SUPABASE_SERVICE_ROLE_KEY
  const ANON_KEY = webEnv.VITE_SUPABASE_ANON_KEY
  const PORT = process.env.PORT || serverEnv.PORT || '3001'
  const SERVER_URL = process.env.E2E_SERVER_URL || `http://localhost:${PORT}`

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (server/.env).')
  }
  if (!ANON_KEY) throw new Error('VITE_SUPABASE_ANON_KEY not found in web/.env.local.')

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const makeAnon = () =>
    createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })

  const ts = Date.now()
  const creatorEmail = `e2e-creator-${ts}@example.com`
  const helperEmail = `e2e-helper-${ts}@example.com`
  const password = wordPassword()

  // Partial state written incrementally so teardown can clean up even if setup
  // throws midway. Keep this object and the file in sync as we provision.
  const state = {
    creatorEmail,
    helperEmail,
    password,
    projectId: null,
    videoId: null,
    videoStoragePath: null,
    creatorId: null,
    helperId: null,
    supabaseUrl: SUPABASE_URL,
  }
  const persist = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
  persist()

  console.log('\n[e2e globalSetup] provisioning live project…')
  console.log(`  Supabase : ${SUPABASE_URL}`)
  console.log(`  Server   : ${SERVER_URL}`)
  console.log(`  Creator  : ${creatorEmail}`)
  console.log(`  Helper   : ${helperEmail}`)

  // The local server must be up (Playwright's webServer starts it, but
  // reuseExistingServer means it may already be running — either way verify).
  let serverUp = false
  for (let i = 0; i < 30 && !serverUp; i++) {
    const health = await fetch(`${SERVER_URL}/health`).then((r) => r.json()).catch(() => null)
    serverUp = health?.ok === true
    if (!serverUp) await sleep(1000)
  }
  if (!serverUp) throw new Error(`Server not reachable at ${SERVER_URL}/health`)

  // 1. Allowlist BOTH throwaway emails (signup trigger blocks others).
  for (const email of [creatorEmail, helperEmail]) {
    const { error } = await admin.from('allowed_emails').insert({ email })
    if (error) throw new Error(`allowlist ${email}: ${error.message}`)
  }

  // 2. Admin-create creator + helper; sign the creator in for its JWT.
  const { data: cu, error: ce } = await admin.auth.admin.createUser({
    email: creatorEmail, password, email_confirm: true,
  })
  if (ce) throw new Error(`createUser creator: ${ce.message}`)
  state.creatorId = cu.user.id
  persist()

  const { data: hu, error: he } = await admin.auth.admin.createUser({
    email: helperEmail, password, email_confirm: true,
  })
  if (he) throw new Error(`createUser helper: ${he.message}`)
  state.helperId = hu.user.id
  persist()

  const creatorClient = makeAnon()
  const { data: signIn, error: se } = await creatorClient.auth.signInWithPassword({
    email: creatorEmail, password,
  })
  if (se || !signIn?.session?.access_token) throw new Error(`creator sign-in: ${se?.message ?? 'no session'}`)
  const creatorToken = signIn.session.access_token

  // 3. Creator inserts a project. (A trigger adds the owner as a 'creator'
  //    member; we add the helper membership with the service role.)
  const { data: proj, error: pe } = await creatorClient
    .from('projects')
    .insert({ title: `E2E collab ${ts}`, owner_id: state.creatorId })
    .select('id')
    .single()
  if (pe || !proj?.id) throw new Error(`insert project: ${pe?.message}`)
  state.projectId = proj.id
  persist()

  // 4. Helper membership row (service role bypasses RLS).
  const { error: me } = await admin.from('project_members').insert({
    project_id: state.projectId, user_id: state.helperId, role: 'helper',
  })
  if (me) throw new Error(`insert helper membership: ${me.message}`)

  // 5. Synthesize a ~12s clip (12s @ 5s segments -> 3 scenes).
  const workDir = await fs.mkdtemp(join(os.tmpdir(), 'vca-e2e-'))
  const clipFile = join(workDir, 'testclip.mp4')
  await execFileAsync(ffmpegPath, [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=12:size=320x240:rate=30',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'fast',
    clipFile,
  ], { maxBuffer: 10 * 1024 * 1024 })
  const clipBytes = await fs.readFile(clipFile)
  if (clipBytes.length < 10_000) throw new Error(`synthesized clip too small (${clipBytes.length} bytes)`)

  // 6. videos row + storage upload (creator client, storage RLS).
  state.videoId = crypto.randomUUID()
  state.videoStoragePath = `${state.projectId}/${state.videoId}/original.mp4`
  persist()
  const { error: ve } = await creatorClient.from('videos').insert({
    id: state.videoId,
    project_id: state.projectId,
    uploaded_by: state.creatorId,
    original_name: 'e2e-collab.mp4',
    storage_path: state.videoStoragePath,
  })
  if (ve) throw new Error(`insert videos row: ${ve.message}`)

  const { error: ue } = await creatorClient.storage
    .from('videos')
    .upload(state.videoStoragePath, clipBytes, { contentType: 'video/mp4', upsert: true })
  if (ue) throw new Error(`upload clip: ${ue.message}`)

  // 7. Kick off processing with the creator's JWT.
  const res = await fetch(`${SERVER_URL}/api/videos/${state.videoId}/process`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creatorToken}` },
  })
  if (res.status !== 202) {
    const body = await res.text().catch(() => '')
    throw new Error(`process endpoint: status=${res.status} body=${body}`)
  }

  // 8. Poll until 'ready' (Gemini descriptions take ~30-60s).
  console.log('  processing (ffmpeg + Gemini)…')
  const deadline = Date.now() + 4 * 60 * 1000
  let status = null
  let rowError = null
  while (Date.now() < deadline) {
    const { data, error } = await creatorClient
      .from('videos').select('status, error').eq('id', state.videoId).single()
    if (error) { rowError = `poll failed: ${error.message}`; break }
    status = data.status
    rowError = data.error
    if (status === 'ready' || status === 'failed') break
    await sleep(3000)
  }
  if (status !== 'ready') {
    throw new Error(`video did not reach ready (status=${status}${rowError ? `, error=${rowError}` : ''})`)
  }

  // 9. Done — finalize the temp dir cleanup; keep .state.json for the spec/teardown.
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
  persist()
  console.log('[e2e globalSetup] ready. project=' + state.projectId + '\n')
}
