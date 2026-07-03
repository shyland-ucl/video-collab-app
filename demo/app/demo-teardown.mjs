/**
 * Demo b-roll globalTeardown — fork of e2e/setup/globalTeardown.mjs that reads
 * demo/app/out/demo-state.json (written by demo-setup.mjs) and removes the
 * throwaway project, users, allowlist rows and storage objects. Failures are
 * logged as WARN, never thrown.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dir, '..', '..')
const STATE_PATH = join(__dir, 'out', 'demo-state.json')

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

export default async function demoTeardown() {
  if (!existsSync(STATE_PATH)) {
    console.log('[demo-teardown] no demo-state.json — nothing to clean')
    return
  }
  const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
  const serverEnv = parseEnvFile(join(repoRoot, 'server', '.env'))
  const SUPABASE_URL = process.env.SUPABASE_URL || serverEnv.SUPABASE_URL || state.supabaseUrl
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || serverEnv.SUPABASE_SERVICE_ROLE_KEY
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error('[demo-teardown] WARN missing service-role creds; leaving test data')
    return
  }
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })

  console.log('\n[demo-teardown] cleaning up…')
  const { projectId, videoId, videoStoragePath, creatorId, helperId, creatorEmail, helperEmail } = state

  if (projectId && videoId) {
    let segPaths = []
    const { data } = await admin.from('segments').select('storage_path, keyframe_path').eq('video_id', videoId)
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

  if (projectId) {
    const { error } = await admin.from('projects').delete().eq('id', projectId)
    if (error) console.error(`  WARN project delete: ${error.message}`)
    else console.log(`  OK deleted project ${projectId}`)
  }

  for (const email of [creatorEmail, helperEmail].filter(Boolean)) {
    const { error } = await admin.from('allowed_emails').delete().eq('email', email)
    if (error) console.error(`  WARN allowlist ${email}: ${error.message}`)
  }

  for (const uid of [creatorId, helperId].filter(Boolean)) {
    const { error } = await admin.auth.admin.deleteUser(uid)
    if (error) console.error(`  WARN delete user ${uid}: ${error.message}`)
  }

  try { rmSync(STATE_PATH, { force: true }) } catch { /* ignore */ }
  console.log('[demo-teardown] done\n')
}
