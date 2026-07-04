import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { FFMPEG, DEMO_DIR, OUT_DIR } from './lib/paths.mjs'
import { loadMoments, loadMarkers, effectiveDur, voPath, probeDur } from './lib/timeline.mjs'

const moments = loadMoments()
const markers = loadMarkers()
const CLIPS = join(OUT_DIR, 'clips')
const CARDS = join(OUT_DIR, 'cards')
const BROLL = join(DEMO_DIR, 'app', 'out')
const SEG = join(OUT_DIR, 'segments')
mkdirSync(SEG, { recursive: true })
const ff = (a, opts) => execFileSync(FFMPEG, ['-y', '-v', 'error', ...a], { stdio: 'inherit', ...opts })

const VF = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=30,setsar=1,format=yuv420p'

// One segment builder for every moment type. Always emits exactly `d` seconds,
// 1920x1080@30 yuv420p video + 48k stereo AAC audio, so concat -c copy works.
//   video     : source video file (seeked by `seek`)
//   audioFile : optional narration WAV (clip voice, or app voiceover). null => silence.
//   audioDelay: seconds to delay the audio (tail-place a short voiceover).
function segment(video, outPath, { d, seek = 0, audioFile = null, audioDelay = 0 }) {
  const D = d.toFixed(3)
  const args = []
  if (seek > 0) args.push('-ss', seek.toFixed(3))
  args.push('-i', video)
  const filters = [`[0:v]${VF},trim=duration=${D},setpts=PTS-STARTPTS[v]`]
  let amap
  if (audioFile) {
    args.push('-i', audioFile)
    const delayMs = Math.max(0, Math.round(audioDelay * 1000))
    const pre = delayMs > 0 ? `adelay=${delayMs}:all=1,` : ''
    filters.push(`[1:a]${pre}apad,aformat=sample_rates=48000:channel_layouts=stereo,atrim=duration=${D},asetpts=PTS-STARTPTS[a]`)
    amap = '[a]'
  } else {
    args.push('-f', 'lavfi', '-t', D, '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
    amap = '1:a'
  }
  args.push('-filter_complex', filters.join(';'))
  args.push('-map', '[v]', '-map', amap, '-t', D, '-r', '30',
    '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', outPath)
  ff(args)
}

const list = []
for (const m of moments.timeline) {
  const out = join(SEG, `${m.id}.mp4`)
  const d = effectiveDur(m)

  if (m.type === 'card') {
    segment(join(CARDS, `${m.card}.mp4`), out, { d })
  } else if (m.type === 'clip') {
    const v = join(CLIPS, `${m.id}.deid.mp4`)
    if (!existsSync(v)) throw new Error(`missing de-identified clip ${v} — run deidentify.py + pass QA`)
    segment(v, out, { d, audioFile: join(CLIPS, `${m.id}.audio.wav`) })
  } else if (m.type === 'broll') {
    const v = join(BROLL, `${m.brollId}.webm`)
    if (!existsSync(v)) throw new Error(`missing b-roll webm ${v} — run: npx playwright test -c demo/app/demo-broll.config.mjs`)
    // Seek to where the interesting UI begins (markers.json contentStart from
    // the Playwright recording); fall back to the webm tail if no marker.
    const mk = markers[m.brollId] || {}
    const seek = mk.contentStart != null
      ? Math.max(0, mk.contentStart)
      : Math.max(0, probeDur(v) - d - 0.2)
    // Optional app voiceover: vo+voFit (Overview description) plays from the
    // start; a tail vo (edit confirmation) is delayed to land as the result shows.
    let audioFile = null, audioDelay = 0
    if (m.vo && existsSync(voPath(m.vo))) {
      audioFile = voPath(m.vo)
      if (!m.voFit) audioDelay = Math.max(0, d - probeDur(audioFile) - 0.3)
    }
    segment(v, out, { d, seek, audioFile, audioDelay })
  }
  list.push(`file '${out.replace(/\\/g, '/')}'`)
}
const listPath = join(OUT_DIR, 'concat.txt')
writeFileSync(listPath, list.join('\n'))

// Concat (all segments share codec params) then burn captions.
const concat = join(OUT_DIR, 'concat.mp4')
ff(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', concat])

// Burn ASS subtitles: run with cwd=OUT_DIR and pass the subtitle by basename to
// avoid Windows drive-letter colon escaping in the ass= filter path.
ff(['-i', concat, '-vf', `ass=demo.ass`, '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p',
  '-c:a', 'copy', join(OUT_DIR, 'demo.mp4')], { cwd: OUT_DIR })

// Silent captioned variant.
ff(['-i', join(OUT_DIR, 'demo.mp4'), '-an', '-c:v', 'copy', join(OUT_DIR, 'demo-silent.mp4')])
console.log('built -> out/demo.mp4 + out/demo-silent.mp4')
