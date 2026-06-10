import express from 'express'
import cors from 'cors'
import { makeRequireAuth } from './middleware/requireAuth.js'

export function makeApp(supabaseClient) {
  const app = express()
  app.use(cors({ origin: process.env.WEB_ORIGIN?.split(',') ?? true }))
  app.use(express.json())

  app.get('/health', (_req, res) => res.json({ ok: true }))

  const requireAuth = makeRequireAuth(supabaseClient)
  app.get('/api/me', requireAuth, (req, res) => {
    res.json({ id: req.user.id, email: req.user.email })
  })

  return app
}
