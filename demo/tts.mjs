import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadMarkers, VO_DIR } from './lib/timeline.mjs'

// Synthesise the app's spoken text (captured into markers.json during b-roll
// recording) to WAVs the build muxes onto the app beats. Uses Windows SAPI
// (System.Speech) so it's offline + reproducible — this stands in for the
// participant's screen reader voicing the app.

mkdirSync(VO_DIR, { recursive: true })
const markers = loadMarkers()

const VO = {
  overview: markers.descriptions?.overview, // spoken Overview scene description
  feedback: markers.aiedit?.feedback,        // spoken real-time edit confirmation
}

function synth(text, outWav) {
  const txt = outWav + '.txt'
  writeFileSync(txt, text, 'utf8')
  const esc = (p) => p.replace(/\\/g, '\\\\').replace(/'/g, "''")
  const ps = [
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    "try { $s.SelectVoice('Microsoft Zira Desktop') } catch {};",
    '$s.Rate = 1;',
    `$s.SetOutputToWaveFile('${esc(outWav)}');`,
    `$t = [System.IO.File]::ReadAllText('${esc(txt)}');`,
    '$s.Speak($t); $s.Dispose();',
  ].join(' ')
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit' })
}

let n = 0
for (const [key, text] of Object.entries(VO)) {
  if (!text) { console.log(`skip ${key}: no text in markers.json (run b-roll first)`); continue }
  const outWav = join(VO_DIR, `${key}.wav`)
  synth(text, outWav)
  console.log(`vo ${key} -> ${outWav}  ("${text.slice(0, 60)}${text.length > 60 ? '…' : ''}")`)
  n++
}
console.log(`synthesised ${n} voiceover clip(s)`)
