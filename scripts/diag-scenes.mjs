/**
 * Local scene-detection check — run auto scene detection on any video file
 * and print the resulting plan next to what fixed windows would have produced.
 * Pure local (ffprobe + ffmpeg via the server's static binaries): no env, no
 * Supabase, no Gemini. Never run in CI.
 *
 * Run from repo root:
 *   node scripts/diag-scenes.mjs <video-file> [segmentLengthSeconds=10]
 *
 * Tunables (same envs the server reads): SCENE_THRESHOLD, MIN_SCENE_SECONDS,
 * MAX_SCENES, AUTO_SCENES=0.
 */
import { getVideoMeta } from '../server/src/services/videoMeta.js'
import { planSegments, planScenesAuto, sceneEnv } from '../server/src/services/segmentation.js'

const file = process.argv[2]
const segmentLength = Number(process.argv[3] ?? 10)
if (!file) {
  console.error('usage: node scripts/diag-scenes.mjs <video-file> [segmentLengthSeconds=10]')
  process.exit(1)
}

const meta = await getVideoMeta(file)
const duration = Math.round(meta.duration_seconds * 100) / 100
console.log(`file: ${file}`)
console.log(`duration: ${duration}s  ${meta.width}x${meta.height}  env:`, sceneEnv())

const t0 = Date.now()
const detected = await planScenesAuto(file, duration, segmentLength, (m) => console.log(`  [detect] ${m}`))
console.log(`detection pass took ${Date.now() - t0}ms\n`)

const fixed = planSegments(duration, segmentLength)

const fmt = (p) => `${String(p.start_seconds).padStart(7)} -> ${String(p.end_seconds).padStart(7)}  (${(p.end_seconds - p.start_seconds).toFixed(2)}s)`
console.log(`AUTO (${detected.length} scenes):`)
for (const p of detected) console.log(`  ${p.id}  ${fmt(p)}`)
console.log(`\nFIXED WINDOWS (${fixed.length} scenes):`)
for (const p of fixed) console.log(`  ${p.id}  ${fmt(p)}`)
