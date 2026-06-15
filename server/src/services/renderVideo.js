import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildRenderPlan, clipFfmpegArgs } from './renderPlan.js'
import { runFfmpeg as defaultRunFfmpeg, formatExecError } from './ffmpegRun.js'
import { loadLatestState } from './stateStore.js'
import { loadProjectSources } from './renderData.js'

/**
 * Render a project's EDL into one MP4 and upload it. Mirrors processVideo.js:
 * a fire-and-forget worker that records its own status on the `renders` row and
 * always cleans its tmp dir. All IO is injectable so the orchestration is
 * unit-testable without spawning ffmpeg or touching disk/network.
 *
 * On any failure the render row is set status='failed' + error, and the error
 * is rethrown so the route can log it.
 */
export async function renderVideo(opts) {
  const {
    supabase,
    projectId,
    renderId,
    runFfmpeg = defaultRunFfmpeg,
    loadState = loadLatestState,
    loadSources = loadProjectSources,
    workdir,
    writeFile = fs.writeFile,
    readFile = fs.readFile,
    rm = fs.rm,
    log = () => {},
  } = opts

  const dir = workdir ?? (await fs.mkdtemp(path.join(os.tmpdir(), `vca-render-${renderId}-`)))
  const setRender = (patch) => supabase.from('renders').update(patch).eq('id', renderId)

  try {
    const latest = await loadState(supabase, projectId)
    const sources = await loadSources(supabase, projectId)
    const plan = buildRenderPlan(latest?.state ?? {}, sources) // throws nothing_to_render

    // download each DISTINCT source original once
    const localBySource = new Map()
    for (const e of plan) {
      if (localBySource.has(e.sourceId)) continue
      const { data: blob, error } = await supabase.storage.from('videos').download(e.sourcePath)
      if (error || !blob) throw new Error(`source_download_failed: ${e.sourceId}`)
      const file = path.join(dir, `src_${localBySource.size}.mp4`)
      await writeFile(file, Buffer.from(await blob.arrayBuffer()))
      localBySource.set(e.sourceId, file)
    }

    // render each clip to an intermediate normalised mp4 (identical params)
    const clipFiles = []
    for (const [i, e] of plan.entries()) {
      const outFile = path.join(dir, `clip_${String(i).padStart(3, '0')}.mp4`)
      await runFfmpeg(clipFfmpegArgs({ ...e, sourcePath: localBySource.get(e.sourceId) }, outFile))
      clipFiles.push(outFile)
      log(`rendered clip ${i + 1}/${plan.length}`)
    }

    // concat (stream copy — every clip shares codec/size/fps)
    const listFile = path.join(dir, 'concat.txt')
    await writeFile(listFile, clipFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'))
    const outFile = path.join(dir, 'out.mp4')
    await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outFile])

    const outputPath = `${projectId}/renders/${renderId}.mp4`
    const bytes = await readFile(outFile)
    const up = await supabase.storage.from('videos').upload(outputPath, bytes, { contentType: 'video/mp4', upsert: true })
    if (up.error) throw new Error(`upload_failed: ${up.error.message}`)

    await setRender({ status: 'ready', output_path: outputPath })
    log(`render ${renderId} ready at ${outputPath}`)
  } catch (err) {
    await setRender({ status: 'failed', error: formatExecError(err) })
    throw err
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
