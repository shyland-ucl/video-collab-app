// Temporary diagnostic: where does Supabase redirect a magic link that
// requests the production redirect_to? Reveals Site URL / allowlist state.
import { createClient } from '@supabase/supabase-js'

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const email = `diag-${Date.now()}@example.com`
const { data: created, error: createErr } = await admin.auth.admin.createUser({
  email,
  email_confirm: true,
})
if (createErr) {
  console.error('createUser failed:', createErr.message)
  process.exit(1)
}

try {
  const { data, error } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo: 'https://video-collab-app-web.vercel.app/' },
  })
  if (error) throw error
  const link = data.properties?.action_link ?? data.action_link
  console.log('requested redirect_to: https://video-collab-app-web.vercel.app/')
  const res = await fetch(link, { redirect: 'manual' })
  const location = res.headers.get('location') ?? '(none)'
  console.log('verify status:', res.status)
  console.log('actual redirect target:', location.split('#')[0])
} finally {
  await admin.auth.admin.deleteUser(created.user.id)
  console.log('cleanup: deleted', email)
}
