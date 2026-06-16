import path from 'node:path'
import { runFfmpeg, x264ThreadArgs } from './ffmpegRun.js'

export function planSegments(totalDuration, segmentLength) {
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) throw new Error('bad_duration')
  if (!Number.isFinite(segmentLength) || segmentLength <= 0) throw new Error('bad_segment_length')

  const count = Math.ceil(totalDuration / segmentLength)
  return Array.from({ length: count }, (_, i) => {
    const start = i * segmentLength
    const end = Math.min((i + 1) * segmentLength, totalDuration)
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

export async function cutSegment(sourceFile, outDir, plan) {
  const segFile = path.join(outDir, `${plan.id}.mp4`)
  const kfFile = path.join(outDir, `${plan.id}_kf.jpg`)
  const modelClipFile = path.join(outDir, `${plan.id}_model.mp4`)

  await runFfmpeg(buildSegmentArgs(sourceFile, segFile, plan))
  await runFfmpeg(buildKeyframeArgs(sourceFile, kfFile, plan))
  await runFfmpeg(buildModelClipArgs(sourceFile, modelClipFile, plan))

  return { segFile, kfFile, modelClipFile }
}
