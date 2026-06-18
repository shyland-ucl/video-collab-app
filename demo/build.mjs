import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { FFMPEG, FFPROBE, DEMO_DIR, OUT_DIR } from './lib/paths.mjs'
import { clipDuration } from './lib/timecode.mjs'

const moments = JSON.parse(readFileSync(join(DEMO_DIR, 'moments.json')))
const CLIPS = join(OUT_DIR, 'clips')
const CARDS = join(OUT_DIR, 'cards')
const BROLL = join(DEMO_DIR, 'app', 'out')
const SEG = join(OUT_DIR, 'segments')
mkdirSync(SEG, { recursive: true })
const ff = (a, opts) => execFileSync(FFMPEG, ['-y', '-v', 'error', ...a], { stdio: 'inherit', ...opts })
const dur = (m) => m.dur ?? clipDuration(m.srtStart, m.srtEnd)
const vdur = (p) => parseFloat(
  execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]).toString().trim()
)

// Common normalize: 1920x1080@30, yuv420p, 48k stereo AAC, exactly `d` seconds.
// `seek` (seconds) seeks into the source before grabbing `d` seconds — used for
// b-roll, whose webm begins with sign-in/loading and only shows the UI near the end.
const VF = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=30,setsar=1,format=yuv420p'
function norm(srcVideo, srcAudio, d, outPath, seek = 0) {
  const args = []
  if (seek > 0) args.push('-ss', seek.toFixed(3))
  args.push('-i', srcVideo)
  if (srcAudio) {
    args.push('-i', srcAudio)
    args.push('-t', d.toFixed(3), '-vf', VF, '-r', '30')
    args.push('-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest')
  } else {
    // lavfi input must come before output options; place -vf/-r after all inputs
    args.push('-f', 'lavfi', '-t', d.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
    args.push('-t', d.toFixed(3), '-vf', VF, '-r', '30')
    args.push('-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-shortest')
  }
  args.push('-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', outPath)
  ff(args)
}

const list = []
for (const m of moments.timeline) {
  const out = join(SEG, `${m.id}.mp4`)
  if (m.type === 'card') norm(join(CARDS, `${m.card}.mp4`), null, dur(m), out)
  else if (m.type === 'clip') {
    const v = join(CLIPS, `${m.id}.deid.mp4`)
    if (!existsSync(v)) throw new Error(`missing de-identified clip ${v} — run deidentify.py + pass QA`)
    norm(v, join(CLIPS, `${m.id}.audio.wav`), dur(m), out)
  } else if (m.type === 'broll') {
    const v = join(BROLL, `${m.brollId}.webm`)
    if (!existsSync(v)) throw new Error(`missing b-roll webm ${v} — run: npx playwright test -c demo/app/demo-broll.config.mjs`)
    // Take the TAIL of the webm (the UI shot); its head is sign-in/loading.
    const seek = Math.max(0, vdur(v) - dur(m) - 0.2)
    norm(v, null, dur(m), out, seek)   // b-roll is silent under its caption
  }
  list.push(`file '${out.replace(/\\/g, '/')}'`)
}
const listPath = join(OUT_DIR, 'concat.txt')
writeFileSync(listPath, list.join('\n'))

// Concat (all segments share codec params) then burn captions.
const concat = join(OUT_DIR, 'concat.mp4')
ff(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', concat])

// Burn ASS subtitles: run ffmpeg with cwd=OUT_DIR and pass subtitle file by
// plain basename to avoid Windows drive-letter colon escaping issues in the
// ass= filter path.
ff(['-i', concat, '-vf', `ass=demo.ass`, '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', join(OUT_DIR, 'demo.mp4')], { cwd: OUT_DIR })

// Silent captioned variant.
ff(['-i', join(OUT_DIR, 'demo.mp4'), '-an', '-c:v', 'copy', join(OUT_DIR, 'demo-silent.mp4')])
console.log('built -> out/demo.mp4 + out/demo-silent.mp4')
