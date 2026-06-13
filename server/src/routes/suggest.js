import { Router } from 'express'
import { makeRequireAuth } from '../middleware/requireAuth.js'
import { makeGeminiModel } from '../services/descriptions.js'
import { proposeSuggestions } from '../services/suggestions.js'
import { loadVideoForSuggestions } from '../services/suggestionsData.js'

const LOADER_ERROR_STATUS = {
  video_not_found: 404,
  video_not_ready: 400,
  no_segments: 400,
  segments_query_failed: 500,
  descriptions_query_failed: 500,
}

export function makeSuggestRoutes(supabase, deps = {}) {
  const { propose = proposeSuggestions, getModel = makeGeminiModel, loadVideo = loadVideoForSuggestions } = deps
  const router = Router()
  const requireAuth = makeRequireAuth(supabase)

  router.post('/api/projects/:id/suggest', requireAuth, async (req, res) => {
    const { data: project } = await supabase
      .from('projects').select('id, title').eq('id', req.params.id).single()
    if (!project) return res.status(404).json({ error: 'project_not_found' })

    const { data: member } = await supabase
      .from('project_members').select('user_id')
      .eq('project_id', project.id).eq('user_id', req.user.id).maybeSingle()
    if (!member) return res.status(403).json({ error: 'not_a_member' })

    const videoId = String(req.body?.videoId ?? '').trim()
    if (!videoId || videoId.length > 200) return res.status(400).json({ error: 'bad_request_body' })

    let model
    try { model = getModel() } catch { return res.status(500).json({ error: 'server_misconfigured' }) }

    const loaded = await loadVideo(supabase, project.id, videoId)
    if (loaded.error) {
      const status = LOADER_ERROR_STATUS[loaded.error] ?? 500
      // Don't echo internal DB-failure codes back to the client on a 5xx.
      return res.status(status).json({ error: status >= 500 ? 'server_error' : loaded.error })
    }

    const proposal = await propose(model, loaded.scenes, loaded.keyframes)
    res.json({ suggestions: proposal.suggestions ?? [] })
  })

  return router
}
