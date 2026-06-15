import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getVideoMeta } from './videoMeta.js'
import { planSegments, cutSegment } from './segmentation.js'
import { formatExecError } from './ffmpegRun.js'
import { describeKeyframe, loadDescriptionPrompt, DESCRIPTION_MODEL } from './descriptions.js'

export async function processVideo({ supabase, model, videoId, log = () => {} }, deps = {}) {
  const {
    getMeta = getVideoMeta,
    cut = cutSegment,
    describe = describeKeyframe,
    loadPrompt = loadDescriptionPrompt,
  } = deps

  const { data: video, error: videoErr } = await supabase
    .from('videos').select('*').eq('id', videoId).single()
  if (videoErr || !video) throw new Error('video_not_found')

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `vca-${videoId}-`))
  try {
    const claim = await supabase.from('videos').update({ status: 'processing', error: null }).eq('id', videoId)
    if (claim.error) throw new Error(`status_update_failed: ${claim.error.message}`)
    // Fresh start on every (re)run: descriptions cascade with their segments.
    const cleared = await supabase.from('segments').delete().eq('video_id', videoId)
    if (cleared.error) throw new Error(`segment_clear_failed: ${cleared.error.message}`)

    const { data: blob, error: dlErr } = await supabase.storage
      .from('videos').download(video.storage_path)
    if (dlErr || !blob) throw new Error(`download_failed: ${dlErr?.message ?? 'no data'}`)
    const sourceFile = path.join(workDir, 'original.mp4')
    await fs.writeFile(sourceFile, Buffer.from(await blob.arrayBuffer()))

    const meta = await getMeta(sourceFile)
    const metaUpd = await supabase.from('videos').update(meta).eq('id', videoId)
    if (metaUpd.error) throw new Error(`meta_update_failed: ${metaUpd.error.message}`)

    const prefix = `${video.project_id}/${video.id}`
    // round to 2dp: ffprobe durations carry sub-ms rounding that would
    // otherwise plan a 1-frame "ghost" segment at the tail
    const planDuration = Math.round(meta.duration_seconds * 100) / 100
    const plans = planSegments(planDuration, video.segment_length_seconds)
    const prompt = await loadPrompt()

    for (const plan of plans) {
      const { segFile, kfFile } = await cut(sourceFile, workDir, plan)
      const segmentPath = `${prefix}/segments/${plan.id}.mp4`
      const keyframePath = `${prefix}/keyframes/${plan.id}_kf.jpg`

      const segBytes = await fs.readFile(segFile)
      const kfBytes = await fs.readFile(kfFile)
      const segUp = await supabase.storage.from('videos')
        .upload(segmentPath, segBytes, { contentType: 'video/mp4', upsert: true })
      if (segUp.error) throw new Error(`upload_failed: ${segUp.error.message}`)
      const kfUp = await supabase.storage.from('videos')
        .upload(keyframePath, kfBytes, { contentType: 'image/jpeg', upsert: true })
      if (kfUp.error) throw new Error(`upload_failed: ${kfUp.error.message}`)

      const { data: segRow, error: segErr } = await supabase.from('segments').insert({
        video_id: videoId,
        idx: plan.idx,
        start_seconds: plan.start_seconds,
        end_seconds: plan.end_seconds,
        label: plan.label,
        storage_path: segmentPath,
        keyframe_path: keyframePath,
      }).select().single()
      if (segErr) throw new Error(`segment_insert_failed: ${segErr.message}`)

      const levels = await describe(model, prompt, kfBytes.toString('base64'))
      const { error: descErr } = await supabase.from('descriptions').insert(
        [1, 2, 3].map((level) => ({
          segment_id: segRow.id,
          level,
          text: levels[`level_${level}`],
          source: 'ai',
          model: DESCRIPTION_MODEL,
        }))
      )
      if (descErr) throw new Error(`description_insert_failed: ${descErr.message}`)

      log(`processed ${plan.id} (${plan.idx}/${plans.length})`)
    }

    const done = await supabase.from('videos').update({ status: 'ready' }).eq('id', videoId)
    if (done.error) throw new Error(`status_update_failed: ${done.error.message}`)
  } catch (err) {
    // formatExecError preserves err.signal/err.code/err.killed so a killed
    // ffmpeg (e.g. container OOM = signal SIGKILL) is diagnosable from the row,
    // not masked as a bare "Command failed".
    const failed = await supabase.from('videos')
      .update({ status: 'failed', error: formatExecError(err) })
      .eq('id', videoId)
    if (failed.error) log(`could not record failure for ${videoId}: ${failed.error.message}`)
    throw err
  } finally {
    await fs.rm(workDir, { recursive: true, force: true })
  }
}

// Railway redeploys kill in-flight processing; without this sweep those rows
// would stay 'processing' forever (blocking the 409-guarded retry). Called
// once at server boot — safe because the service runs as a single instance.
export async function recoverInterrupted(supabase, log = console.log) {
  const { data, error } = await supabase
    .from('videos')
    .update({ status: 'failed', error: 'interrupted_by_restart' })
    .eq('status', 'processing')
    .select('id')
  if (error) log(`stale-processing sweep failed: ${error.message}`)
  else if (data?.length) log(`marked ${data.length} interrupted video(s) failed`)

  // Same single-instance guarantee for interrupted render jobs (Phase 4): a
  // restart mid-render would otherwise strand the 'rendering' row + 409-block
  // the next render.
  const { data: r, error: rErr } = await supabase
    .from('renders')
    .update({ status: 'failed', error: 'interrupted_by_restart' })
    .eq('status', 'rendering')
    .select('id')
  if (rErr) log(`stale-render sweep failed: ${rErr.message}`)
  else if (r?.length) log(`marked ${r.length} interrupted render(s) failed`)
}
