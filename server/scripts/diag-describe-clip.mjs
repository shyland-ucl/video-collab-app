// Manual quality check: build a 480p model clip from a sample video and print
// the clip-based description next to the keyframe-based one. Requires GEMINI_API_KEY.
// Usage (from server/):  node --env-file=.env scripts/diag-describe-clip.mjs <path-to-video.mp4>
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { makeGeminiModel, loadDescriptionPrompt, describeScene, describeKeyframe } from '../src/services/descriptions.js'
import { buildModelClipArgs, buildKeyframeArgs, planSegments } from '../src/services/segmentation.js'

const exec = promisify(execFile)
const src = process.argv[2]
if (!src) {
  console.error('usage: node --env-file=.env scripts/diag-describe-clip.mjs <video.mp4>')
  process.exit(1)
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diag-clip-'))
try {
  const plan = planSegments(5, 5)[0] // first ~5s scene
  const clip = path.join(dir, 'm.mp4')
  const kf = path.join(dir, 'k.jpg')
  await exec(ffmpegPath, buildModelClipArgs(src, clip, plan))
  await exec(ffmpegPath, buildKeyframeArgs(src, kf, plan))

  const model = makeGeminiModel()
  const prompt = await loadDescriptionPrompt()
  const clipB64 = (await fs.readFile(clip)).toString('base64')
  const kfB64 = (await fs.readFile(kf)).toString('base64')

  console.log('=== FROM CLIP (frames + audio) ===')
  console.log(JSON.stringify(await describeScene(model, prompt, { data: clipB64 }), null, 2))
  console.log('\n=== FROM KEYFRAME (legacy) ===')
  console.log(JSON.stringify(await describeKeyframe(model, prompt, kfB64), null, 2))
} finally {
  await fs.rm(dir, { recursive: true, force: true })
}
