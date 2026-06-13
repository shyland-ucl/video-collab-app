// Pure EDL → render plan + ffmpeg arg/filter builders. No ffmpeg, no IO — the
// testable core of the render. Keep rootSegmentId + the colour math in sync with
// web stateStore.rootSegmentId and HelperDevice.colourValuesToFilter/Transform.

export const OUTPUT = { w: 1280, h: 720, fps: 30 }

function rootSegmentId(clipId) {
  return clipId.replace(/(-split-\d+-[0-9a-z]+)+$/, '')
}

// EDL → ordered plan entries. Throws an error with code 'nothing_to_render' when
// no clip resolves to a renderable window.
export function buildRenderPlan(state, sources) {
  const byId = new Map((sources ?? []).map((s) => [s.id, s]))
  const colour = state?.colour ?? {}
  const plan = []
  for (const [index, clip] of (state?.clips ?? []).entries()) {
    const src = byId.get(clip.sourceId)
    if (!src) continue // unresolvable source → drop (worker logs it)
    const effStart = clip.startTime + (clip.trimStart || 0)
    const effEnd = clip.endTime - (clip.trimEnd || 0)
    if (!(effEnd > effStart)) continue // zero/negative window → skip
    plan.push({
      index,
      sourceId: clip.sourceId,
      sourcePath: src.storage_path,
      effStart,
      effEnd,
      colour: colour[rootSegmentId(clip.id)] ?? null,
      muted: !!clip.muted,
      volume: typeof clip.volume === 'number' ? clip.volume : 100,
    })
  }
  if (!plan.length) {
    const err = new Error('nothing_to_render')
    err.code = 'nothing_to_render'
    throw err
  }
  return plan
}

const n3 = (v) => Number(v.toFixed(3)).toString()

// Colour → ffmpeg -vf chain (or null when neutral). Mirrors the CSS preview:
// brightness ×(1+b/200), contrast ×(1+c/200) (eq pivots mid-grey like CSS),
// saturation ×(1+s/100), zoom center-crop (1/z), rotate deg→rad. The canonical
// scale+pad to the output frame is appended by clipFfmpegArgs (always).
export function colourToVf(colour, _out = OUTPUT) {
  if (!colour) return null
  const { brightness = 0, contrast = 0, saturation = 0, zoom = 100, rotate = 0 } = colour
  if (brightness === 0 && contrast === 0 && saturation === 0 && zoom === 100 && rotate === 0) return null
  const parts = []
  if (brightness !== 0) {
    const b = n3(1 + brightness / 200)
    // multiplicative brightness (CSS brightness() multiplies RGB); commas inside
    // the clip() expression are escaped so ffmpeg doesn't read them as filter args
    parts.push(`lutrgb=r=clip(val*${b}\\,0\\,255):g=clip(val*${b}\\,0\\,255):b=clip(val*${b}\\,0\\,255)`)
  }
  if (contrast !== 0 || saturation !== 0) {
    parts.push(`eq=contrast=${n3(1 + contrast / 200)}:saturation=${n3(1 + saturation / 100)}`)
  }
  if (zoom !== 100) parts.push(`crop=iw/${n3(zoom / 100)}:ih/${n3(zoom / 100)}`)
  if (rotate !== 0) parts.push(`rotate=${rotate}*PI/180:fillcolor=black`)
  return parts.join(',')
}

// Full execFile arg array for ONE clip → an intermediate mp4 normalised to the
// canonical size/fps/codec so the final concat is a stream copy.
export function clipFfmpegArgs(entry, outFile, out = OUTPUT) {
  const colourVf = colourToVf(entry.colour, out)
  const fit = `scale=${out.w}:${out.h}:force_original_aspect_ratio=decrease,pad=${out.w}:${out.h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${out.fps}`
  const vf = colourVf ? `${colourVf},${fit}` : fit
  const args = ['-y', '-ss', String(entry.effStart), '-to', String(entry.effEnd), '-i', entry.sourcePath, '-vf', vf]
  if (entry.muted) {
    args.push('-an')
  } else if (entry.volume !== 100) {
    args.push('-af', `volume=${n3(entry.volume / 100)}`)
  }
  args.push('-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-r', String(out.fps), '-c:a', 'aac', outFile)
  return args
}
