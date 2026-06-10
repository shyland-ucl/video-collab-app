import { createClient } from '@supabase/supabase-js'
import { makeApp } from './app.js'

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const port = process.env.PORT || 3001
makeApp(supabaseAdmin).listen(port, () => {
  console.log(`server listening on :${port}`)
})
