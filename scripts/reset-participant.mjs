/**
 * Reset a trial participant's password to a fresh word-password (design
 * 2026-08-18) — for the unsupervised-trial "I forgot my password" call.
 * Researcher-only (service role).
 *
 * Run from repo root:
 *   node --env-file=server/.env scripts/reset-participant.mjs --email person@example.com
 */
import { createClient } from '@supabase/supabase-js'
import { wordPassword } from './lib/passwords.mjs'

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (server/.env).')
  process.exit(1)
}

const i = process.argv.indexOf('--email')
const email = (i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '').toLowerCase()
if (!email) {
  console.error('usage: node --env-file=server/.env scripts/reset-participant.mjs --email person@example.com')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

let user = null
for (let page = 1; !user; page++) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
  if (error) { console.error(`listUsers failed: ${error.message}`); process.exit(1) }
  user = data.users.find((u) => u.email?.toLowerCase() === email) ?? null
  if (!user && data.users.length < 200) break
}
if (!user) {
  console.error(`No account found for ${email}.`)
  process.exit(1)
}

const password = wordPassword()
const { error } = await admin.auth.admin.updateUserById(user.id, { password })
if (error) { console.error(`password update failed: ${error.message}`); process.exit(1) }

console.log(`Password reset for ${email}:`)
console.log(`  New password : ${password}`)
console.log('Tell the participant; it is not stored anywhere else.')
