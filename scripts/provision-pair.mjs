/**
 * Trial pair provisioning (design 2026-08-18). Creates ONE trial unit in a
 * single run: two accounts (creator + helper) with word-based passwords, one
 * shared project, both memberships — then prints a credentials sheet per
 * participant ready for a large-print handout. Researcher-only (service role).
 *
 * Run from repo root:
 *   node --env-file=server/.env scripts/provision-pair.mjs \
 *     --pair P01 --creator-email cr@example.com --helper-email he@example.com \
 *     [--title "Our family videos"] [--url https://app.example.com]
 *
 * Safety: if EITHER email already has an account the script aborts before
 * creating anything — it never overwrites a live participant. If a later step
 * fails partway it prints exactly what was created so cleanup is manual and
 * obvious (Supabase dashboard), rather than guessing at auto-rollback.
 */
import { createClient } from '@supabase/supabase-js'
import { wordPassword } from './lib/passwords.mjs'

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WEB_ORIGIN } = process.env
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (server/.env).')
  process.exit(1)
}

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const pair = arg('pair', 'P??')
const creatorEmail = arg('creator-email')?.toLowerCase()
const helperEmail = arg('helper-email')?.toLowerCase()
const title = arg('title', `Our videos (${pair})`)
const url = arg('url', (WEB_ORIGIN ?? '').split(',')[0].trim() || '<web app URL>')

if (!creatorEmail || !helperEmail || creatorEmail === helperEmail) {
  console.error('usage: node --env-file=server/.env scripts/provision-pair.mjs --pair P01 --creator-email a@x --helper-email b@y [--title "..."] [--url https://...]')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const created = [] // for the manual-cleanup note on partial failure

async function findUserByEmail(email) {
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(`listUsers failed: ${error.message}`)
    const hit = data.users.find((u) => u.email?.toLowerCase() === email)
    if (hit) return hit
    if (data.users.length < 200) return null
  }
}

try {
  // 0. Abort BEFORE creating anything if either account already exists.
  for (const email of [creatorEmail, helperEmail]) {
    if (await findUserByEmail(email)) {
      console.error(`ABORT: ${email} already has an account — nothing was created.`)
      console.error('Use scripts/reset-participant.mjs to reset a password instead.')
      process.exit(1)
    }
  }

  // 1. Allowlist both emails (the auth.users trigger enforces this even for
  //    admin-created accounts).
  const { error: alErr } = await admin.from('allowed_emails')
    .upsert([{ email: creatorEmail }, { email: helperEmail }], { onConflict: 'email' })
  if (alErr) throw new Error(`allowlist upsert failed: ${alErr.message}`)
  created.push('allowed_emails rows')

  // 2. Create both accounts with word-passwords, pre-confirmed.
  const participants = []
  for (const [role, email] of [['creator', creatorEmail], ['helper', helperEmail]]) {
    const password = wordPassword()
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (error) throw new Error(`createUser(${email}) failed: ${error.message}`)
    created.push(`auth user ${email} (${data.user.id})`)
    participants.push({ role, email, password, id: data.user.id })
  }
  const creator = participants[0]
  const helper = participants[1]

  // 3. Shared project owned by the creator.
  const { data: project, error: prErr } = await admin.from('projects')
    .insert({ title, owner_id: creator.id })
    .select('id, title').single()
  if (prErr) throw new Error(`project insert failed: ${prErr.message}`)
  created.push(`project ${project.id}`)

  // 4. Both memberships with their roles.
  const { error: pmErr } = await admin.from('project_members').insert([
    { project_id: project.id, user_id: creator.id, role: 'creator' },
    { project_id: project.id, user_id: helper.id, role: 'helper' },
  ])
  if (pmErr) throw new Error(`membership insert failed: ${pmErr.message}`)

  // 5. Credentials sheet.
  console.log(`\nPair ${pair} provisioned — project "${project.title}" (${project.id})\n`)
  for (const p of participants) {
    console.log('='.repeat(46))
    console.log(`  ${pair} — ${p.role.toUpperCase()}`)
    console.log('='.repeat(46))
    console.log(`  Sign-in page : ${url}/signin`)
    console.log(`  Email        : ${p.email}`)
    console.log(`  Password     : ${p.password}`)
    console.log('')
  }
  console.log('Keep this sheet safe; passwords are not stored anywhere else.')
} catch (err) {
  console.error(`\nFAILED: ${err.message}`)
  if (created.length) {
    console.error('Created before the failure (clean up in the Supabase dashboard):')
    for (const c of created) console.error(`  - ${c}`)
  }
  process.exit(1)
}
