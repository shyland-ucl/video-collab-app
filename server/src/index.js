import { createClient } from '@supabase/supabase-js'
import { makeApp } from './app.js'
import { recoverInterrupted } from './services/processVideo.js'

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabaseAdmin = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const port = process.env.PORT || 3001
await recoverInterrupted(supabaseAdmin)
makeApp(supabaseAdmin).listen(port, () => {
  console.log(`server listening on :${port}`)
})
