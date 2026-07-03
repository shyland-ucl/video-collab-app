/**
 * Demo b-roll globalSetup — a fork of e2e/setup/globalSetup.mjs that provisions
 * the SAME live two-person editable project, but uploads the real cleared clip
 * `demo/sample.mp4` instead of a synthesized test pattern, so the editor shows a
 * real scene with a real Gemini description for the demo video.
 *
 * Kept separate (not an edit to the e2e setup) to honour the "no changes to
 * e2e tests" constraint. Writes demo/app/out/demo-state.json; demo-teardown.mjs
 * reads it and removes everything.
 *
 * Env (read from server/.env + web/.env.local): SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, VITE_SUPABASE_ANON_KEY, optional PORT.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import crypto from 'node:crypto'

const __dir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dir, '..', '..')
const OUT_DIR = join(__dir, 'out')
const STATE_PATH = join(OUT_DIR, 'demo-state.json')
const SAMPLE = join(__dir, '..', 'sample.mp4')

function parseEnvFile(filePath) {
  const text = readFileSync(filePath, 'utf8')
  const result = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    result[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
  }
  return result
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const WORDS = ['mango', 'river', 'cedar', 'amber', 'pebble', 'lumen', 'orbit', 'willow', 'marble', 'cobalt']
const wordPassword = () => {
  const pick = () => WORDS[crypto.randomInt(WORDS.length)]
  return `${pick()}-${pick()}-${crypto.randomInt(10, 99)}`
}

export default async function demoSetup() {
  const serverEnv = parseEnvFile(join(repoRoot, 'server', '.env'))
  const webEnv = parseEnvFile(join(repoRoot, 'web', '.env.local'))

  const SUPABASE_URL = process.env.SUPABASE_URL || serverEnv.SUPABASE_URL
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || serverEnv.SUPABASE_SERVICE_ROLE_KEY
  const ANON_KEY = webEnv.VITE_SUPABASE_ANON_KEY
  const PORT = process.env.PORT || serverEnv.PORT || '3001'
  const SERVER_URL = process.env.E2E_SERVER_URL || `http://localhost:${PORT}`

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (server/.env).')
  if (!ANON_KEY) throw new Error('VITE_SUPABASE_ANON_KEY not found in web/.env.local.')

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const makeAnon = () => createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })

  const ts = Date.now()
  const creatorEmail = `demo-creator-${ts}@example.com`
  const helperEmail = `demo-helper-${ts}@example.com`
  const password = wordPassword()

  mkdirSync(OUT_DIR, { recursive: true })
  const state = {
    creatorEmail, helperEmail, password,
    projectId: null, videoId: null, videoStoragePath: null,
    creatorId: null, helperId: null, supabaseUrl: SUPABASE_URL,
  }
  const persist = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
  persist()

  console.log('\n[demo-setup] provisioning live project with demo/sample.mp4…')
  console.log(`  Supabase : ${SUPABASE_URL}`)
  console.log(`  Server   : ${SERVER_URL}`)

  let serverUp = false
  for (let i = 0; i < 30 && !serverUp; i++) {
    const health = await fetch(`${SERVER_URL}/health`).then((r) => r.json()).catch(() => null)
    serverUp = health?.ok === true
    if (!serverUp) await sleep(1000)
  }
  if (!serverUp) throw new Error(`Server not reachable at ${SERVER_URL}/health`)

  for (const email of [creatorEmail, helperEmail]) {
    const { error } = await admin.from('allowed_emails').insert({ email })
    if (error) throw new Error(`allowlist ${email}: ${error.message}`)
  }

  const { data: cu, error: ce } = await admin.auth.admin.createUser({ email: creatorEmail, password, email_confirm: true })
  if (ce) throw new Error(`createUser creator: ${ce.message}`)
  state.creatorId = cu.user.id; persist()

  const { data: hu, error: he } = await admin.auth.admin.createUser({ email: helperEmail, password, email_confirm: true })
  if (he) throw new Error(`createUser helper: ${he.message}`)
  state.helperId = hu.user.id; persist()

  const creatorClient = makeAnon()
  const { data: signIn, error: se } = await creatorClient.auth.signInWithPassword({ email: creatorEmail, password })
  if (se || !signIn?.session?.access_token) throw new Error(`creator sign-in: ${se?.message ?? 'no session'}`)
  const creatorToken = signIn.session.access_token

  const { data: proj, error: pe } = await creatorClient
    .from('projects').insert({ title: `Demo ${ts}`, owner_id: state.creatorId }).select('id').single()
  if (pe || !proj?.id) throw new Error(`insert project: ${pe?.message}`)
  state.projectId = proj.id; persist()

  const { error: me } = await admin.from('project_members').insert({
    project_id: state.projectId, user_id: state.helperId, role: 'helper',
  })
  if (me) throw new Error(`insert helper membership: ${me.message}`)

  // Real cleared clip (demo/sample.mp4) instead of a synthesized pattern.
  const clipBytes = await fs.readFile(SAMPLE)
  if (clipBytes.length < 10_000) throw new Error(`sample.mp4 too small (${clipBytes.length} bytes)`)

  state.videoId = crypto.randomUUID()
  state.videoStoragePath = `${state.projectId}/${state.videoId}/original.mp4`
  persist()
  const { error: ve } = await creatorClient.from('videos').insert({
    id: state.videoId, project_id: state.projectId, uploaded_by: state.creatorId,
    original_name: 'sample.mp4', storage_path: state.videoStoragePath,
  })
  if (ve) throw new Error(`insert videos row: ${ve.message}`)

  const { error: ue } = await creatorClient.storage
    .from('videos').upload(state.videoStoragePath, clipBytes, { contentType: 'video/mp4', upsert: true })
  if (ue) throw new Error(`upload clip: ${ue.message}`)

  const res = await fetch(`${SERVER_URL}/api/videos/${state.videoId}/process`, {
    method: 'POST', headers: { Authorization: `Bearer ${creatorToken}` },
  })
  if (res.status !== 202) {
    const body = await res.text().catch(() => '')
    throw new Error(`process endpoint: status=${res.status} body=${body}`)
  }

  console.log('  processing (ffmpeg + Gemini)…')
  const deadline = Date.now() + 4 * 60 * 1000
  let status = null, rowError = null
  while (Date.now() < deadline) {
    const { data, error } = await creatorClient.from('videos').select('status, error').eq('id', state.videoId).single()
    if (error) { rowError = `poll failed: ${error.message}`; break }
    status = data.status; rowError = data.error
    if (status === 'ready' || status === 'failed') break
    await sleep(3000)
  }
  if (status !== 'ready') throw new Error(`video did not reach ready (status=${status}${rowError ? `, error=${rowError}` : ''})`)

  persist()
  console.log('[demo-setup] ready. project=' + state.projectId + '\n')
}
