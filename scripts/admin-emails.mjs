/**
 * Manage who counts as a researcher admin (migration 0015). An admin can READ
 * every trial project through /admin in the web app; they can never write to
 * one, because the admin grants cover SELECT only.
 *
 * Run from repo root:
 *   node --env-file=server/.env scripts/admin-emails.mjs list
 *   node --env-file=server/.env scripts/admin-emails.mjs add    me@example.com
 *   node --env-file=server/.env scripts/admin-emails.mjs remove me@example.com
 *
 * Researcher-only: needs the service-role key, because admin_emails has RLS on
 * with no policies and is invisible to every app role by design.
 *
 * Adding an email here does NOT create an account, and it does NOT put the
 * address on the sign-up allowlist -- those are separate gates. To make a
 * brand-new admin account, allowlist the address and create the user first
 * (Supabase dashboard, or scripts/provision-pair.mjs for participants), then
 * run `add` here.
 */
import { createClient } from '@supabase/supabase-js'

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (server/.env).')
  process.exit(1)
}

const [command, rawEmail] = process.argv.slice(2)
const email = rawEmail?.trim().toLowerCase()

function usage() {
  console.error('usage: node --env-file=server/.env scripts/admin-emails.mjs <list|add|remove> [email]')
  process.exit(1)
}
if (!['list', 'add', 'remove'].includes(command)) usage()
if (command !== 'list' && !email) usage()

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

async function findUserByEmail(target) {
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(`listUsers failed: ${error.message}`)
    const hit = data.users.find((u) => u.email?.toLowerCase() === target)
    if (hit) return hit
    if (data.users.length < 200) return null
  }
}

try {
  if (command === 'list') {
    const { data, error } = await admin.from('admin_emails').select('email').order('email')
    if (error) throw new Error(error.message)
    if (!data.length) {
      console.log('No admins configured. Nobody can open /admin.')
    } else {
      console.log(`${data.length} admin${data.length === 1 ? '' : 's'}:`)
      for (const row of data) console.log(`  ${row.email}`)
    }
  }

  if (command === 'add') {
    const { error } = await admin.from('admin_emails').upsert({ email }, { onConflict: 'email' })
    if (error) throw new Error(error.message)
    console.log(`${email} is now a researcher admin.`)
    // An admin row with no matching account is inert rather than broken --
    // is_app_admin() joins on auth.users and simply finds nothing. Say so
    // plainly instead of letting it look like it worked and then silently not.
    const user = await findUserByEmail(email)
    if (!user) {
      console.log('')
      console.log('NOTE: there is no account with that email yet, so nothing is admin yet.')
      console.log('Allowlist the address and create the account, then sign in — no need to re-run this.')
    }
  }

  if (command === 'remove') {
    const { error } = await admin.from('admin_emails').delete().eq('email', email)
    if (error) throw new Error(error.message)
    console.log(`${email} is no longer a researcher admin.`)
    console.log('Takes effect on their next request — is_app_admin() reads the table, not the token.')
  }
} catch (err) {
  console.error(`FAILED: ${err.message}`)
  process.exit(1)
}
