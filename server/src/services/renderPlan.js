// Pure EDL → render plan + ffmpeg arg/filter builders. No ffmpeg, no IO — the
// testable core of the render. Keep rootSegmentId + the colour math in sync with
// web stateStore.rootSegmentId and HelperDevice.colourValuesToFilter/Transform.
//
// SECURITY: project_state JSONB is opaque + member-writable (no DB shape check),
// so EVERY value reaching an ffmpeg arg/filtergraph here is treated as hostile —
// coerced to a finite number and range-clamped. A non-numeric value (e.g. a
// crafted `rotate` string) can NEVER reach the -vf string and inject filters.

export const OUTPUT = { w: 1280, h: 720, fps: 30 }
// Bound in-process work: a hostile EDL could otherwise queue thousands of
// downloads + encodes. Renders above this are rejected (400) by the route.
export const MAX_CLIPS = 300

function rootSegmentId(clipId) {
  return String(clipId).replace(/(-split-\d+-[0-9a-z]+)+$/, '')
}

function clampNum(v, lo, hi) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.min(hi, Math.max(lo, n))
}

// Coerce + range-clamp a colour grade to the editor's slider ranges; drop any
// non-numeric/neutral field. Returns null when nothing renderable remains.
export function sanitizeColour(colour) {
  if (!colour || typeof colour !== 'object') return null
  const out = {}
  const b = clampNum(colour.brightness, -100, 100); if (b) out.brightness = b
  const c = clampNum(colour.contrast, -100, 100); if (c) out.contrast = c
  const s = clampNum(colour.saturation, -100, 100); if (s) out.saturation = s
  const z = clampNum(colour.zoom, 100, 250); if (z && z !== 100) out.zoom = z
  const r = clampNum(colour.rotate, -180, 180); if (r) out.rotate = r
  return Object.keys(out).length ? out : null
}

// EDL → ordered plan entries. Throws { code:'nothing_to_render' } when no clip
// resolves and { code:'too_many_clips' } when the EDL exceeds MAX_CLIPS.
export function buildRenderPlan(state, sources) {
  const byId = new Map((sources ?? []).map((s) => [s.id, s]))
  const colour = state?.colour ?? {}
  const plan = []
  for (const [index, clip] of (state?.clips ?? []).entries()) {
    const src = byId.get(clip.sourceId)
    if (!src) continue // unresolvable source → drop (worker logs it)
    const start = Number(clip.startTime)
    const end = Number(clip.endTime)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue // non-numeric times → skip
    const effStart = start + (Number(clip.trimStart) || 0)
    const effEnd = end - (Number(clip.trimEnd) || 0)
    if (!(effEnd > effStart)) continue // zero/negative window → skip
    const volRaw = Number(clip.volume)
    plan.push({
      index,
      sourceId: clip.sourceId,
      sourcePath: src.storage_path,
      effStart,
      effEnd,
      colour: sanitizeColour(colour[rootSegmentId(clip.id)]),
      muted: !!clip.muted,
      volume: Number.isFinite(volRaw) ? Math.min(200, Math.max(0, volRaw)) : 100,
    })
  }
  if (!plan.length) {
    const err = new Error('nothing_to_render'); err.code = 'nothing_to_render'; throw err
  }
  if (plan.length > MAX_CLIPS) {
    const err = new Error('too_many_clips'); err.code = 'too_many_clips'; throw err
  }
  return plan
}

const n3 = (v) => Number(Number(v).toFixed(3)).toString()

// Colour → ffmpeg -vf chain (or null when neutral). Every field is coerced to a
// finite number (defence-in-depth: this function is injection-proof on its own,
// independent of buildRenderPlan's sanitize). Mirrors the CSS preview:
// brightness ×(1+b/200), contrast ×(1+c/200), saturation ×(1+s/100), zoom
// center-crop (1/z), rotate deg→rad.
export function colourToVf(colour, _out = OUTPUT) {
  if (!colour) return null
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d }
  const brightness = num(colour.brightness, 0)
  const contrast = num(colour.contrast, 0)
  const saturation = num(colour.saturation, 0)
  const zoom = num(colour.zoom, 100)
  const rotate = num(colour.rotate, 0)
  if (brightness === 0 && contrast === 0 && saturation === 0 && zoom === 100 && rotate === 0) return null
  const parts = []
  if (brightness !== 0) {
    const b = n3(1 + brightness / 200) // CSS brightness() is multiplicative
    parts.push(`lutrgb=r=clip(val*${b}\\,0\\,255):g=clip(val*${b}\\,0\\,255):b=clip(val*${b}\\,0\\,255)`)
  }
  if (contrast !== 0 || saturation !== 0) {
    parts.push(`eq=contrast=${n3(1 + contrast / 200)}:saturation=${n3(1 + saturation / 100)}`)
  }
  if (zoom > 100) parts.push(`crop=iw/${n3(zoom / 100)}:ih/${n3(zoom / 100)}`) // >100 only: crop must be ≤ input
  if (rotate !== 0) parts.push(`rotate=${n3(rotate)}*PI/180:fillcolor=black`)
  return parts.length ? parts.join(',') : null
}

// Full execFile arg array for ONE clip → an intermediate mp4 normalised to the
// canonical size/fps/codec AND a uniform audio stream (every clip keeps one aac
// stereo 48k track — mute = volume 0, NOT -an — so the final concat is a stream
// copy across muted + unmuted clips).
export function clipFfmpegArgs(entry, outFile, out = OUTPUT) {
  const colourVf = colourToVf(entry.colour, out)
  const fit = `scale=${out.w}:${out.h}:force_original_aspect_ratio=decrease,pad=${out.w}:${out.h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${out.fps}`
  const vf = colourVf ? `${colourVf},${fit}` : fit
  const vol = entry.muted ? 0 : entry.volume / 100
  return [
    '-y', '-ss', String(entry.effStart), '-to', String(entry.effEnd), '-i', entry.sourcePath,
    '-vf', vf,
    '-af', `volume=${n3(vol)}`,
    '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-r', String(out.fps),
    '-c:a', 'aac', '-ar', '48000', '-ac', '2',
    outFile,
  ]
}
