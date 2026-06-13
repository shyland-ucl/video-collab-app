/**
 * Playwright globalTeardown (Phase 1c Task 12).
 *
 * Reads e2e/.state.json and removes everything globalSetup provisioned, in the
 * same order and with the same fall-backs as scripts/e2e-pipeline.mjs cleanup:
 *   storage objects -> project (cascades videos/segments/descriptions/
 *   project_state/tasks/project_members) -> allowlist rows -> both users ->
 *   verify no storage objects remain -> remove .state.json.
 *
 * Failures here are logged as WARN, never thrown — a teardown error must not
 * mask the test result.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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
    result[trimmed.slice(0, eqIdx).trim()] =
      trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
  }
  return result
}

export default async function globalTeardown() {
  if (!existsSync(STATE_PATH)) {
    console.log('[e2e globalTeardown] no .state.json — nothing to clean')
    return
  }
  const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'))

  const serverEnv = parseEnvFile(join(repoRoot, 'server', '.env'))
  const SUPABASE_URL = process.env.SUPABASE_URL || serverEnv.SUPABASE_URL || state.supabaseUrl
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || serverEnv.SUPABASE_SERVICE_ROLE_KEY
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error('[e2e globalTeardown] WARN missing service-role creds; leaving test data')
    return
  }
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  console.log('\n[e2e globalTeardown] cleaning up…')
  const { projectId, videoId, videoStoragePath, creatorId, helperId, creatorEmail, helperEmail } = state

  // C1: storage objects (original + segments + keyframes). Prefer DB-recorded
  // paths; fall back to conventional names so a partial run still cleans up.
  if (projectId && videoId) {
    let segPaths = []
    const { data } = await admin.from('segments')
      .select('storage_path, keyframe_path').eq('video_id', videoId)
    segPaths = (data ?? []).flatMap((s) => [s.storage_path, s.keyframe_path])
    if (segPaths.length === 0) {
      const prefix = `${projectId}/${videoId}`
      for (let i = 1; i <= 3; i++) {
        const id = `seg_${String(i).padStart(3, '0')}`
        segPaths.push(`${prefix}/segments/${id}.mp4`, `${prefix}/keyframes/${id}_kf.jpg`)
      }
    }
    const allPaths = [videoStoragePath, ...segPaths].filter(Boolean)
    const { error } = await admin.storage.from('videos').remove(allPaths)
    if (error) console.error(`  WARN storage removal: ${error.message}`)
    else console.log(`  OK removed ${allPaths.length} storage object(s)`)
  }

  // C2: delete the project — cascades videos/segments/descriptions/
  // project_state/tasks/project_members.
  if (projectId) {
    const { error } = await admin.from('projects').delete().eq('id', projectId)
    if (error) console.error(`  WARN project delete: ${error.message}`)
    else console.log(`  OK deleted project ${projectId} (cascades all children)`)
  }

  // C3: allowlist rows.
  for (const email of [creatorEmail, helperEmail].filter(Boolean)) {
    const { error } = await admin.from('allowed_emails').delete().eq('email', email)
    if (error) console.error(`  WARN allowlist ${email}: ${error.message}`)
  }
  console.log('  OK removed allowlist rows')

  // C4: delete both users.
  for (const uid of [creatorId, helperId].filter(Boolean)) {
    const { error } = await admin.auth.admin.deleteUser(uid)
    if (error) console.error(`  WARN delete user ${uid}: ${error.message}`)
  }
  console.log('  OK deleted users')

  // C5: verify no storage objects remain under the project prefix.
  if (projectId && videoId) {
    const prefixes = [
      `${projectId}/${videoId}`,
      `${projectId}/${videoId}/segments`,
      `${projectId}/${videoId}/keyframes`,
    ]
    let leftover = 0
    for (const p of prefixes) {
      const { data, error } = await admin.storage.from('videos').list(p)
      if (error) continue
      leftover += (data ?? []).filter((entry) => entry.id !== null).length
    }
    if (leftover === 0) console.log('  OK no storage objects remain under the project prefix')
    else console.error(`  WARN ${leftover} storage object(s) still under ${projectId}/`)
  }

  // C6: remove the local state file.
  try { rmSync(STATE_PATH, { force: true }) } catch { /* ignore */ }
  console.log('[e2e globalTeardown] done\n')
}
