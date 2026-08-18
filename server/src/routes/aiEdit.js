import { Router } from 'express'
import { makeRequireAuth } from '../middleware/requireAuth.js'
import { makeGeminiModel } from '../services/descriptions.js'
import { proposeEdit, MAX_CLARIFY_ROUNDS } from '../services/aiEdit.js'
import { rootSegmentIds, loadLevel1Descriptions } from '../services/aiEditData.js'
import { logServerEvent } from '../services/events.js'

// Sanitize the client-sent clarification transcript: keep only well-formed
// { request, clarification } rounds, coerce+bound each string, and keep the
// most recent MAX_CLARIFY_ROUNDS (bounds prompt size and drives the final-round
// "stop asking" instruction). Never trust the body — this feeds the LLM prompt.
function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return []
  const clean = raw
    .filter((h) => h && typeof h.request === 'string' && typeof h.clarification === 'string')
    .map((h) => ({ request: h.request.slice(0, 500), clarification: h.clarification.slice(0, 500) }))
  return clean.slice(-MAX_CLARIFY_ROUNDS)
}

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

    // The scene the request came from — only honour it if it's one of the
    // submitted clips (so a deictic "make it brighter" resolves to that scene
    // instead of looping on "which scene?"). Untrusted ids are dropped.
    const focusRaw = String(req.body?.focused_clip_id ?? '')
    const focusedClipId = cleanClips.some((c) => c.id === focusRaw) ? focusRaw : null
    const history = sanitizeHistory(req.body?.history)

    let model
    try {
      model = getModel()
    } catch {
      return res.status(500).json({ error: 'server_misconfigured' })
    }

    const descriptions = await loadLevel1Descriptions(supabase, project.id, rootSegmentIds(cleanClips))
    const proposal = await propose(model, request, cleanClips, descriptions, {
      focusedClipId,
      history,
      log: console.warn,
    })
    // Request text is core study data (consented — design 2026-08-18); the
    // outcome discriminates clarification loops from real proposals.
    logServerEvent(supabase, {
      userId: req.user.id, projectId: project.id,
      type: 'ai_edit_request',
      payload: {
        request,
        focusedClipId,
        historyRounds: history.length,
        outcome: proposal?.clarification ? 'clarification' : (proposal?.op ?? 'unknown'),
      },
    })
    res.json(proposal)
  })

  return router
}
