import express from 'express'
import cors from 'cors'
import { makeRequireAuth } from './middleware/requireAuth.js'

export function makeApp(supabaseClient) {
  const app = express()
  const origins = process.env.WEB_ORIGIN?.split(',') ?? ['http://localhost:5173']
  app.use(cors({ origin: origins }))
  app.use(express.json())

  app.get('/health', (_req, res) => res.json({ ok: true }))

  const requireAuth = makeRequireAuth(supabaseClient)
  app.get('/api/me', requireAuth, (req, res) => {
    res.json({ id: req.user.id, email: req.user.email })
  })

  return app
}
