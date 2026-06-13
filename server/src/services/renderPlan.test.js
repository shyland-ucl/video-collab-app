import { describe, it, expect } from 'vitest'
import { buildRenderPlan, colourToVf, clipFfmpegArgs, OUTPUT } from './renderPlan.js'

const SOURCES = [
  { id: 'v1', storage_path: 'p1/v1/original.mp4' },
  { id: 'v2', storage_path: 'p1/v2/original.mp4' },
]
const baseClip = (o) => ({ trimStart: 0, trimEnd: 0, ...o })

describe('buildRenderPlan', () => {
  it('orders clips, computes effective ranges, resolves source + colour by rootSegmentId', () => {
    const state = {
      clips: [
        baseClip({ id: 's1', sourceId: 'v1', startTime: 0, endTime: 5, trimStart: 1 }),
        baseClip({ id: 's1-split-1765-a', sourceId: 'v1', startTime: 5, endTime: 8 }),
        baseClip({ id: 's2', sourceId: 'v2', startTime: 2, endTime: 9, trimEnd: 2, muted: true, volume: 150 }),
      ],
      colour: { s1: { brightness: 20 }, s2: { zoom: 150 } },
    }
    const plan = buildRenderPlan(state, SOURCES)
    expect(plan.map((p) => p.index)).toEqual([0, 1, 2])
    expect(plan[0]).toMatchObject({ sourceId: 'v1', sourcePath: 'p1/v1/original.mp4', effStart: 1, effEnd: 5 })
    expect(plan[0].colour).toEqual({ brightness: 20 })
    expect(plan[1].colour).toEqual({ brightness: 20 }) // split half inherits the root grade
    expect(plan[2]).toMatchObject({ effStart: 2, effEnd: 7, muted: true, volume: 150 })
    expect(plan[2].colour).toEqual({ zoom: 150 })
  })

  it('drops clips whose source is unresolvable and throws nothing_to_render on an empty plan', () => {
    const okState = { clips: [baseClip({ id: 'g', sourceId: 'gone', startTime: 0, endTime: 2 })], colour: {} }
    expect(() => buildRenderPlan(okState, SOURCES)).toThrow(/nothing_to_render/)
  })

  it('skips zero/negative-window clips', () => {
    const state = {
      clips: [
        baseClip({ id: 'a', sourceId: 'v1', startTime: 0, endTime: 2, trimStart: 1, trimEnd: 1 }), // window 0 → skip
        baseClip({ id: 'b', sourceId: 'v1', startTime: 0, endTime: 3 }),
      ],
      colour: {},
    }
    const plan = buildRenderPlan(state, SOURCES)
    expect(plan).toHaveLength(1)
    expect(plan[0].index).toBe(1)
  })
})

describe('colourToVf', () => {
  it('returns null for a neutral grade or absent colour', () => {
    expect(colourToVf(undefined, OUTPUT)).toBeNull()
    expect(colourToVf({ brightness: 0, contrast: 0, saturation: 0, zoom: 100, rotate: 0 }, OUTPUT)).toBeNull()
  })
  it('emits eq contrast/saturation with the exact CSS multipliers', () => {
    const vf = colourToVf({ contrast: 20, saturation: 50 }, OUTPUT)
    expect(vf).toContain('eq=contrast=1.1') // 1 + 20/200
    expect(vf).toContain('saturation=1.5') // 1 + 50/100
  })
  it('emits a multiplicative brightness lut', () => {
    const vf = colourToVf({ brightness: 20 }, OUTPUT) // 1 + 20/200 = 1.1
    expect(vf).toContain('lutrgb=')
    expect(vf).toContain('val*1.1')
  })
  it('emits a center crop for zoom and a rotate in radians', () => {
    const vf = colourToVf({ zoom: 200, rotate: 90 }, OUTPUT)
    expect(vf).toContain('crop=iw/2:ih/2') // zoom 200 → 1/2 center crop
    expect(vf).toContain('rotate=90*PI/180')
  })
})

describe('clipFfmpegArgs', () => {
  it('builds an execFile arg array: input, seek window, filters, codec, output last', () => {
    const entry = { sourcePath: '/tmp/v1.mp4', effStart: 1, effEnd: 5, colour: { brightness: 20 }, muted: false, volume: 100 }
    const args = clipFfmpegArgs(entry, '/tmp/clip_000.mp4')
    expect(args).toContain('-ss')
    expect(args[args.indexOf('-ss') + 1]).toBe('1')
    expect(args).toContain('-to')
    expect(args[args.indexOf('-to') + 1]).toBe('5')
    expect(args[args.indexOf('-i') + 1]).toBe('/tmp/v1.mp4')
    expect(args.join(' ')).toContain('libx264')
    expect(args.join(' ')).toMatch(/scale=1280:720/)
    expect(args[args.length - 1]).toBe('/tmp/clip_000.mp4')
  })
  it('drops audio for a muted clip and sets volume otherwise', () => {
    const muted = clipFfmpegArgs({ sourcePath: '/s', effStart: 0, effEnd: 2, colour: null, muted: true, volume: 100 }, '/o.mp4')
    expect(muted).toContain('-an')
    const loud = clipFfmpegArgs({ sourcePath: '/s', effStart: 0, effEnd: 2, colour: null, muted: false, volume: 150 }, '/o.mp4')
    expect(loud.join(' ')).toContain('volume=1.5')
  })
  it('applies the canonical fit even with no colour grade', () => {
    const args = clipFfmpegArgs({ sourcePath: '/s', effStart: 0, effEnd: 2, colour: null, muted: false, volume: 100 }, '/o.mp4')
    expect(args.join(' ')).toMatch(/force_original_aspect_ratio=decrease/)
    expect(args.join(' ')).toMatch(/pad=1280:720/)
  })
})
