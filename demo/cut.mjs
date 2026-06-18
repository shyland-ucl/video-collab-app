import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { FFMPEG, F_ROOT, SCRIPTS, DEMO_DIR, OUT_DIR } from './lib/paths.mjs'
import { srtToSeconds, secondsToFfmpeg, clipDuration } from './lib/timecode.mjs'

const sessions = JSON.parse(readFileSync(join(DEMO_DIR, 'sessions.json')))
const moments = JSON.parse(readFileSync(join(DEMO_DIR, 'moments.json')))
const offsets = existsSync(join(DEMO_DIR, 'offsets.json'))
  ? JSON.parse(readFileSync(join(DEMO_DIR, 'offsets.json'))) : {}
const CLIPS = join(OUT_DIR, 'clips')
mkdirSync(CLIPS, { recursive: true })

const ff = (args) => execFileSync(FFMPEG, ['-y', '-v', 'error', ...args], { stdio: 'inherit' })

for (const m of moments.timeline) {
  if (m.type !== 'clip') continue
  const s = sessions[m.session]
  if (!s) throw new Error(`unknown session ${m.session}`)
  if (!(m.session in offsets)) throw new Error(`no offset for ${m.session}; run calibrate.py`)
  const off = offsets[m.session]
  const start = srtToSeconds(m.srtStart)
  const dur = clipDuration(m.srtStart, m.srtEnd)
  const wav = join(SCRIPTS, s.wav)
  const vid = join(F_ROOT, s.videoAngles?.[0] ?? s.video)

  // Narration: cut from WAV (PCM seek is accurate even before -i).
  ff(['-ss', secondsToFfmpeg(start), '-t', dur.toFixed(3), '-i', wav,
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '48000', '-ac', '2',
      join(CLIPS, `${m.id}.audio.wav`)])

  // Video: fast-seek to (t-5) then accurate output-seek 5s; pad to 1920x1080@30.
  const vstart = Math.max(0, start + off - 5)
  ff(['-ss', secondsToFfmpeg(vstart), '-i', vid, '-ss', '5', '-t', dur.toFixed(3),
      '-an', '-vf',
      'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=30,setsar=1',
      '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p',
      join(CLIPS, `${m.id}.raw.mp4`)])

  // QA still at the clip start (to eyeball A/V sync before de-id).
  ff(['-i', join(CLIPS, `${m.id}.raw.mp4`), '-frames:v', '1', join(CLIPS, `${m.id}.start.png`)])
  console.log('cut', m.id, `dur=${dur.toFixed(2)}s`)
}
console.log('clips ->', CLIPS)
