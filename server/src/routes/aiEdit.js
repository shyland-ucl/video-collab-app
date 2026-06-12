import { Router } from 'express'
import { makeRequireAuth } from '../middleware/requireAuth.js'
import { makeGeminiModel } from '../services/descriptions.js'
import { proposeEdit } from '../services/aiEdit.js'
import { rootSegmentIds, loadLevel1Descriptions } from '../services/aiEditData.js'

export function makeAiEditRoutes(supabase, deps = {}) {
  const { propose = proposeEdit, getModel = makeGeminiModel } = deps
  const router = Router()
  const requireAuth = makeRequireAuth(supabase)

  router.post('/api/projects/:id/ai-edit', requireAuth, async (req, res) => {
    const { data: project } = await supabase
      .from('projects').select('id, title').eq('id', req.params.id).single()
    if (!project) return res.status(404).json({ error: 'project_not_found' })

    const { data: member } = await supabase
      .from('project_members').select('user_id')
      .eq('project_id', project.id).eq('user_id', req.user.id).maybeSingle()
    if (!member) return res.status(403).json({ error: 'not_a_member' })

    const request = String(req.body?.request ?? '').trim()
    const clips = Array.isArray(req.body?.clips) ? req.body.clips : null
    if (!request || request.length > 500 || !clips?.length || clips.length > 200) {
      return res.status(400).json({ error: 'bad_request_body' })
    }
    const cleanClips = clips.map((c) => ({
      id: String(c?.id ?? '').slice(0, 200),
      name: String(c?.name ?? '').slice(0, 200),
      duration_seconds: Math.min(Math.max(Number(c?.duration_seconds) || 0, 0), 86400),
    })).filter((c) => c.id && c.name)
    if (!cleanClips.length) return res.status(400).json({ error: 'bad_request_body' })

    let model
    try {
      model = getModel()
    } catch {
      return res.status(500).json({ error: 'server_misconfigured' })
    }

    const descriptions = await loadLevel1Descriptions(supabase, project.id, rootSegmentIds(cleanClips))
    const proposal = await propose(model, request, cleanClips, descriptions)
    res.json(proposal)
  })

  return router
}
