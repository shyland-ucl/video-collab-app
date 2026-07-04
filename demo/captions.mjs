import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OUT_DIR } from './lib/paths.mjs'
import { loadMoments, effectiveDur } from './lib/timeline.mjs'

const moments = loadMoments()
const dur = effectiveDur
const t = (sec) => {
  const h = Math.floor(sec/3600), mm = Math.floor((sec%3600)/60)
  const ss = (sec%60).toFixed(2).padStart(5,'0')
  return `${h}:${String(mm).padStart(2,'0')}:${ss}`
}
const head = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap, Arial, 52, &H00FFFFFF, &H00000000, &H64000000, 1, 3, 0, 2, 120, 120, 90, 1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`
let cur = 0, lines = ''
for (const m of moments.timeline) {
  const d = dur(m)
  if (m.caption) {
    // Caption text only — no speaker label (participants are not named).
    const text = m.caption.replace(/\n/g, '\\N')
    lines += `Dialogue: 0,${t(cur)},${t(cur+d)},Cap,,0,0,0,,${text}\n`
  }
  cur += d
}
if (cur < 55 || cur > 82) throw new Error(`total duration ${cur.toFixed(1)}s is outside the 55–82s acceptance window`)
writeFileSync(join(OUT_DIR, 'demo.ass'), head + lines)
console.log('captions -> out/demo.ass; total', cur.toFixed(1), 's')
