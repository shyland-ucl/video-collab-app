import express from 'express'
import cors from 'cors'
import { makeRequireAuth } from './middleware/requireAuth.js'
import { makeVideoRoutes } from './routes/videos.js'
import { makeAiEditRoutes } from './routes/aiEdit.js'
import { makeSuggestRoutes } from './routes/suggest.js'

export function makeApp(supabaseClient, videoDeps = {}) {
  const app = express()
  // WEB_ORIGIN is hand-pasted into hosting dashboards: strip whitespace
  // (space/tab/CR/LF), zero-width characters (U+200B..U+200D, U+FEFF), and
  // trailing slashes so an invisible paste artifact can't silently break the
  // exact-match CORS check
  const junkChars = String.fromCharCode(0x20, 0x09, 0x0d, 0x0a, 0x200b, 0x200c, 0x200d, 0xfeff)
  const stripJunk = new RegExp('[' + junkChars + ']', 'g')
  const origins = (process.env.WEB_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.replace(stripJunk, '').replace(/\/+$/, ''))
    .filter(Boolean)
  app.use(cors({ origin: origins }))
  app.use(express.json())

  app.get('/health', (_req, res) => res.json({ ok: true }))

  const requireAuth = makeRequireAuth(supabaseClient)
  app.get('/api/me', requireAuth, (req, res) => {
    res.json({ id: req.user.id, email: req.user.email })
  })

  app.use(makeVideoRoutes(supabaseClient, videoDeps))
  app.use(makeAiEditRoutes(supabaseClient, videoDeps))
  // No videoDeps: the suggest route's injectable `propose` would otherwise
  // collide with ai-edit's in the shared bag. Its tests mount it directly.
  app.use(makeSuggestRoutes(supabaseClient))

  return app
}
