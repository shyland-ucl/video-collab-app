import { Router } from 'express'
import { makeRequireAuth } from '../middleware/requireAuth.js'
import { processVideo } from '../services/processVideo.js'
import { makeGeminiModel, answerQuestion } from '../services/descriptions.js'

export function makeVideoRoutes(supabase, deps = {}) {
  const {
    process = processVideo,
    getModel = makeGeminiModel,
    vqa = answerQuestion,
  } = deps

  const router = Router()
  const requireAuth = makeRequireAuth(supabase)

  async function loadVideoForMember(videoId, userId) {
    const { data: video } = await supabase
      .from('videos')
      .select('id, project_id, status, storage_path')
      .eq('id', videoId)
      .single()
    if (!video) return { status: 404, error: 'video_not_found' }

    const { data: member } = await supabase
      .from('project_members')
      .select('user_id')
      .eq('project_id', video.project_id)
      .eq('user_id', userId)
      .maybeSingle()
    if (!member) return { status: 403, error: 'not_a_member' }

    return { video }
  }

  router.post('/api/videos/:id/process', requireAuth, async (req, res) => {
    const found = await loadVideoForMember(req.params.id, req.user.id)
    if (found.error) return res.status(found.status).json({ error: found.error })

    // atomic claim: of two concurrent calls, exactly one flips the status
    const { data: claimed, error: claimErr } = await supabase
      .from('videos')
      .update({ status: 'processing', error: null })
      .eq('id', found.video.id)
      .neq('status', 'processing')
      .select('id')
    if (claimErr) return res.status(500).json({ error: 'claim_failed' })
    if (!claimed?.length) return res.status(409).json({ error: 'already_processing' })

    // construct the model BEFORE answering: a missing GEMINI_API_KEY must
    // surface as a 5xx, not strand the video after a 202
    let model
    try {
      model = getModel()
    } catch (err) {
      await supabase.from('videos')
        .update({ status: 'failed', error: `server_misconfigured: ${err.message}` })
        .eq('id', found.video.id)
      return res.status(500).json({ error: 'server_misconfigured' })
    }

    res.status(202).json({ ok: true })
    try {
      await process({ supabase, model, videoId: found.video.id, log: console.log })
    } catch (err) {
      // status already set to 'failed' by processVideo; log for Railway logs
      console.error(`processing failed for ${found.video.id}:`, err)
    }
  })

  router.post('/api/segments/:id/vqa', requireAuth, async (req, res) => {
    const question = String(req.body?.question ?? '').trim()
    if (!question || question.length > 500) {
      return res.status(400).json({ error: 'bad_question' })
    }

    const { data: segment } = await supabase
      .from('segments')
      .select('id, video_id, keyframe_path')
      .eq('id', req.params.id)
      .single()
    if (!segment) return res.status(404).json({ error: 'segment_not_found' })

    const found = await loadVideoForMember(segment.video_id, req.user.id)
    if (found.error) return res.status(found.status).json({ error: found.error })

    const { data: blob, error: dlErr } = await supabase.storage
      .from('videos')
      .download(segment.keyframe_path)
    if (dlErr || !blob) return res.status(500).json({ error: 'keyframe_unavailable' })

    try {
      const base64 = Buffer.from(await blob.arrayBuffer()).toString('base64')
      const answer = await vqa(getModel(), base64, question)
      res.json({ answer })
    } catch (err) {
      console.error(`vqa failed for segment ${segment.id}:`, err)
      res.status(502).json({ error: 'vqa_failed' })
    }
  })

  return router
}
