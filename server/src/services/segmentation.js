import path from 'node:path'
import { runFfmpeg, runFfmpegTo, x264ThreadArgs } from './ffmpegRun.js'

// ffprobe reports the CONTAINER duration, which routinely runs past the last
// decodable video frame (phone videos commonly end with a sliver of audio-only
// tail). Math.ceil would plan a segment inside that gap; it decodes to ZERO
// frames, and ffmpeg then exits 0 while writing no keyframe at all — the
// failure only surfaced downstream as "ENOENT ... seg_NNN_kf.jpg". Fold a tail
// that short into the previous segment, mirroring what boundariesToScenes
// already does via minLen. 1s is comfortably above any container/stream gap
// and well below a scene worth describing.
const MIN_TAIL_SECONDS = 1

export function planSegments(totalDuration, segmentLength) {
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) throw new Error('bad_duration')
  if (!Number.isFinite(segmentLength) || segmentLength <= 0) throw new Error('bad_segment_length')

  let count = Math.ceil(totalDuration / segmentLength)
  // count > 1 guard: a video shorter than MIN_TAIL_SECONDS is still one scene.
  if (count > 1 && totalDuration - (count - 1) * segmentLength < MIN_TAIL_SECONDS) count -= 1

  return Array.from({ length: count }, (_, i) => {
    const start = i * segmentLength
    // The absorbing last segment runs to the end, so it may exceed segmentLength.
    const end = i === count - 1 ? totalDuration : (i + 1) * segmentLength
    return {
      id: `seg_${String(i + 1).padStart(3, '0')}`,
      idx: i + 1,
      start_seconds: start,
      end_seconds: end,
      label: `Scene ${i + 1}`,
      midpoint: start + (end - start) / 2,
    }
  })
}

// Re-encode (not stream-copy) so segment boundaries are frame-accurate:
// phone videos often have keyframes 5-10s apart. x264ThreadArgs() caps the
// thread pool so a real HD source can't OOM-kill the encode on a small
// container (the 320x240 test clip never surfaced this).
export function buildSegmentArgs(sourceFile, segFile, plan) {
  return [
    '-y', '-ss', String(plan.start_seconds), '-to', String(plan.end_seconds),
    '-i', sourceFile,
    '-c:v', 'libx264', '-c:a', 'aac', '-preset', 'fast', ...x264ThreadArgs(),
    segFile,
  ]
}

// Single-frame extract: mjpeg, no x264 threading, so no thread cap needed.
export function buildKeyframeArgs(sourceFile, kfFile, plan) {
  return [
    '-y', '-ss', String(plan.midpoint),
    '-i', sourceFile,
    '-frames:v', '1', '-q:v', '2',
    kfFile,
  ]
}

// Downscaled (480p, mono-audio) copy of the scene used as the MODEL INPUT for
// descriptions. Gemini samples video ~1 fps so higher res buys nothing, and the
// small size keeps the inline request well under the 20 MB limit. Audio is kept
// (the point is motion + speech). Thread-capped like the other encodes.
export function buildModelClipArgs(sourceFile, clipFile, plan) {
  return [
    '-y', '-ss', String(plan.start_seconds), '-to', String(plan.end_seconds),
    '-i', sourceFile,
    '-vf', 'scale=-2:480',
    '-c:v', 'libx264', '-preset', 'fast', ...x264ThreadArgs(),
    '-c:a', 'aac', '-ac', '1',
    clipFile,
  ]
}

// ============================================================================
// Auto scene detection (2026-08-18 design): one decode-only ffmpeg pass with
// the scdet filter finds content cuts; pure post-processing turns them into
// the same plan shape planSegments emits, so everything downstream (segment
// encode, keyframe, Gemini clip, DB rows, EDL) is unchanged. Fixed windows
// remain the fallback at every failure point, and AUTO_SCENES=0 reverts
// entirely (same convention as DESCRIBE_FROM_CLIP).
// ============================================================================

const envNum = (v, dflt) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

// scdet's score is 0-100 (mean-absolute-frame-difference based) and ffmpeg
// only logs cuts scoring >= threshold. 10 is the filter's own default: high
// enough to ignore hand-held wobble, low enough for real phone-video cuts.
// Env-tunable so a trial pilot can adjust without a code change.
export const sceneEnv = () => ({
  threshold: envNum(process.env.SCENE_THRESHOLD, 10),
  minLen: envNum(process.env.MIN_SCENE_SECONDS, 3),
  maxScenes: Math.floor(envNum(process.env.MAX_SCENES, 30)),
})

// Decode-only + downscale: no x264 encode, so no OOM exposure and no thread
// cap needed; 320px wide is plenty for frame-difference scoring and far
// cheaper than full-res on phone HD.
export function buildSceneDetectArgs(sourceFile, threshold) {
  return ['-i', sourceFile, '-vf', `scale=320:-2,scdet=threshold=${threshold}`, '-an', '-f', 'null', '-']
}

// stderr lines look like (captured from the bundled ffmpeg-static build):
//   [scdet @ 000000000...] lavfi.scd.score: 15.625, lavfi.scd.time: 3
export function parseScdetStderr(stderr) {
  const cuts = []
  const re = /lavfi\.scd\.score:\s*([0-9.]+),\s*lavfi\.scd\.time:\s*([0-9.]+)/g
  for (const m of String(stderr ?? '').matchAll(re)) {
    const score = Number(m[1])
    const time = Number(m[2])
    if (Number.isFinite(score) && Number.isFinite(time)) cuts.push({ time, score })
  }
  return cuts
}

const r2 = (n) => Math.round(n * 100) / 100

// Pure: detected cuts -> plan objects (identical shape to planSegments).
//  1. sanitize: in-range, time-sorted, near-duplicates (<0.1s) keep the
//     stronger score;
//  2. cost cap: keep only the strongest maxScenes-1 cuts — every scene costs
//     one Gemini description call. maxLen splitting below may still exceed
//     maxScenes; that mirrors what fixed windows already do on long videos;
//  3. merge scenes shorter than minLen into a neighbour (previous, or next
//     for the opening scene);
//  4. split scenes longer than maxLen into equal chunks <= maxLen — equal so
//     there is never a sub-minLen tail remainder.
export function boundariesToScenes(cuts, totalDuration, { minLen = 3, maxLen = 10, maxScenes = 30 } = {}) {
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) throw new Error('bad_duration')
  if (!Number.isFinite(maxLen) || maxLen <= 0) throw new Error('bad_segment_length')

  let clean = (cuts ?? [])
    .filter((c) => Number.isFinite(c?.time) && c.time > 0 && c.time < totalDuration)
    .map((c) => ({ time: r2(c.time), score: Number(c.score) || 0 }))
    .sort((a, b) => a.time - b.time)

  const deduped = []
  for (const c of clean) {
    const last = deduped[deduped.length - 1]
    if (last && c.time - last.time < 0.1) {
      if (c.score > last.score) deduped[deduped.length - 1] = c
    } else {
      deduped.push(c)
    }
  }
  clean = deduped

  if (clean.length > maxScenes - 1) {
    clean = [...clean]
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, maxScenes - 1))
      .sort((a, b) => a.time - b.time)
  }

  let spans = []
  let prev = 0
  for (const c of clean) {
    spans.push([prev, c.time])
    prev = c.time
  }
  spans.push([prev, totalDuration])

  const merged = []
  for (const span of spans) {
    if (merged.length > 0 && span[1] - span[0] < minLen) {
      merged[merged.length - 1][1] = span[1]
    } else {
      merged.push([...span])
    }
  }
  if (merged.length > 1 && merged[0][1] - merged[0][0] < minLen) {
    merged[1][0] = merged[0][0]
    merged.shift()
  }

  const finalSpans = []
  for (const [s, e] of merged) {
    const len = e - s
    if (len > maxLen + 0.01) {
      const k = Math.ceil(len / maxLen)
      for (let i = 0; i < k; i++) {
        finalSpans.push([
          i === 0 ? s : r2(s + (len * i) / k),
          i === k - 1 ? e : r2(s + (len * (i + 1)) / k),
        ])
      }
    } else {
      finalSpans.push([s, e])
    }
  }

  return finalSpans.map(([start, end], i) => ({
    id: `seg_${String(i + 1).padStart(3, '0')}`,
    idx: i + 1,
    start_seconds: start,
    end_seconds: end,
    label: `Scene ${i + 1}`,
    midpoint: start + (end - start) / 2,
  }))
}

export async function detectScenes(sourceFile, totalDuration, { maxLen, log = () => {}, run = runFfmpeg } = {}) {
  const { threshold, minLen, maxScenes } = sceneEnv()
  const { stderr } = await run(buildSceneDetectArgs(sourceFile, threshold))
  const cuts = parseScdetStderr(stderr)
  if (cuts.length === 0) {
    // Single-take phone video (no hard cuts) degrades to exactly the legacy
    // fixed windows, not equal chunks — behaviour parity with pre-detection.
    log('scene detection found no cuts — using fixed windows')
    return planSegments(totalDuration, maxLen)
  }
  const plans = boundariesToScenes(cuts, totalDuration, { minLen, maxLen, maxScenes })
  log(`scene detection: ${cuts.length} cut(s) -> ${plans.length} scene(s)`)
  return plans
}

// The planner processVideo actually calls. AUTO_SCENES=0 reverts to fixed
// windows without a redeploy; ANY detection failure falls back the same way —
// a cruder segmentation must never fail an upload.
export async function planScenesAuto(sourceFile, totalDuration, segmentLength, log = () => {}, deps = {}) {
  const { detect = detectScenes } = deps
  if (process.env.AUTO_SCENES === '0') return planSegments(totalDuration, segmentLength)
  try {
    return await detect(sourceFile, totalDuration, { maxLen: segmentLength, log })
  } catch (err) {
    log(`scene detection failed (${String(err?.message ?? err).slice(0, 200)}) — using fixed windows`)
    return planSegments(totalDuration, segmentLength)
  }
}

export async function cutSegment(sourceFile, outDir, plan) {
  const segFile = path.join(outDir, `${plan.id}.mp4`)
  const kfFile = path.join(outDir, `${plan.id}_kf.jpg`)
  const modelClipFile = path.join(outDir, `${plan.id}_model.mp4`)

  await runFfmpegTo(segFile, buildSegmentArgs(sourceFile, segFile, plan))
  await runFfmpegTo(kfFile, buildKeyframeArgs(sourceFile, kfFile, plan))
  await runFfmpegTo(modelClipFile, buildModelClipArgs(sourceFile, modelClipFile, plan))

  return { segFile, kfFile, modelClipFile }
}
