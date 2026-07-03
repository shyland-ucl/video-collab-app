import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FFPROBE, DEMO_DIR, OUT_DIR } from './paths.mjs'
import { clipDuration } from './timecode.mjs'

// Shared timeline helpers so captions.mjs and build.mjs compute IDENTICAL
// per-moment durations (otherwise burned captions drift from the video).

export const VO_DIR = join(OUT_DIR, 'vo')
export const MARKERS_PATH = join(DEMO_DIR, 'app', 'out', 'markers.json')

export function loadMoments() {
  return JSON.parse(readFileSync(join(DEMO_DIR, 'moments.json'), 'utf8'))
}

export function loadMarkers() {
  return existsSync(MARKERS_PATH) ? JSON.parse(readFileSync(MARKERS_PATH, 'utf8')) : {}
}

export function voPath(key) {
  return join(VO_DIR, `${key}.wav`)
}

export function probeDur(p) {
  return parseFloat(
    execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p])
      .toString().trim()
  )
}

// Effective on-screen duration of a moment.
//  - clip : from SRT in/out (or an explicit dur override)
//  - card : explicit dur
//  - broll: explicit dur. If it carries a *fitted* voiceover (vo + voFit:true,
//    e.g. the spoken Overview description) the segment is stretched so the
//    narration finishes (capped at 13s). A tail voiceover (vo without voFit,
//    e.g. the short edit-confirmation) plays INSIDE the fixed dur and does not
//    change length.
export function effectiveDur(m) {
  if (m.type === 'clip' && m.srtStart) return m.dur ?? clipDuration(m.srtStart, m.srtEnd)
  let d = m.dur ?? 4
  if (m.vo && m.voFit) {
    const w = voPath(m.vo)
    if (existsSync(w)) d = Math.min(12, Math.max(d, probeDur(w) + 0.6))
  }
  return d
}
