import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'

const execFileAsync = promisify(execFile)
const EXEC_OPTS = { maxBuffer: 10 * 1024 * 1024 }

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
// phone videos often have keyframes 5-10s apart.
export async function cutSegment(sourceFile, outDir, plan) {
  const segFile = path.join(outDir, `${plan.id}.mp4`)
  const kfFile = path.join(outDir, `${plan.id}_kf.jpg`)

  await execFileAsync(ffmpegPath, [
    '-y', '-ss', String(plan.start_seconds), '-to', String(plan.end_seconds),
    '-i', sourceFile,
    '-c:v', 'libx264', '-c:a', 'aac', '-preset', 'fast',
    segFile,
  ], EXEC_OPTS)

  await execFileAsync(ffmpegPath, [
    '-y', '-ss', String(plan.midpoint),
    '-i', sourceFile,
    '-frames:v', '1', '-q:v', '2',
    kfFile,
  ], EXEC_OPTS)

  return { segFile, kfFile }
}
