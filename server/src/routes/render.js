import { Router } from 'express'
import { makeRequireAuth } from '../middleware/requireAuth.js'
import { renderVideo } from '../services/renderVideo.js'
import { loadLatestState } from '../services/stateStore.js'
import { loadProjectSources } from '../services/renderData.js'
import { buildRenderPlan } from '../services/renderPlan.js'

export function makeRenderRoutes(supabase, deps = {}) {
  const { render = renderVideo, loadState = loadLatestState, loadSources = loadProjectSources } = deps
  const router = Router()
  const requireAuth = makeRequireAuth(supabase)

  router.post('/api/projects/:id/render', requireAuth, async (req, res) => {
    const { data: project } = await supabase.from('projects').select('id').eq('id', req.params.id).single()
    if (!project) return res.status(404).json({ error: 'project_not_found' })

    const { data: member } = await supabase.from('project_members').select('user_id')
      .eq('project_id', project.id).eq('user_id', req.user.id).maybeSingle()
    if (!member) return res.status(403).json({ error: 'not_a_member' })

    // single-flight: reject if a render is already in progress for this project
    const { data: inflight } = await supabase.from('renders').select('id')
      .eq('project_id', project.id).eq('status', 'rendering').limit(1)
    if (inflight?.length) return res.status(409).json({ error: 'already_rendering' })

    // validate the EDL is renderable BEFORE creating a job row
    let edlVersion = null
    try {
      const latest = await loadState(supabase, project.id)
      const sources = await loadSources(supabase, project.id)
      buildRenderPlan(latest?.state ?? {}, sources) // throws nothing_to_render
      edlVersion = latest?.version ?? null
    } catch (err) {
      if (err.code === 'nothing_to_render' || err.code === 'too_many_clips') {
        return res.status(400).json({ error: err.code })
      }
      return res.status(500).json({ error: 'server_error' })
    }

    const { data: row, error } = await supabase.from('renders')
      .insert({ project_id: project.id, status: 'rendering', edl_version: edlVersion, created_by: req.user.id })
      .select('id').single()
    // 23505 = the partial unique index (renders_one_active_per_project) rejected
    // a second concurrent 'rendering' row — the single-flight loser. Same 409 the
    // inflight SELECT returns, so the race and the guard are indistinguishable to
    // the client.
    if (error?.code === '23505') return res.status(409).json({ error: 'already_rendering' })
    if (error || !row) return res.status(500).json({ error: 'render_create_failed' })

    res.status(202).json({ renderId: row.id })
    try {
      await render({ supabase, projectId: project.id, renderId: row.id, loadState, loadSources, log: console.log })
    } catch (err) {
      // status already set to 'failed' by renderVideo; log for Railway logs
      console.error(`render failed for project ${project.id}:`, err)
    }
  })

  return router
}
