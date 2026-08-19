import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { planSegments, cutSegment, buildSegmentArgs, buildModelClipArgs } from './segmentation.js'

const execFileAsync = promisify(execFile)

describe('planSegments', () => {
  it('splits an exact multiple into equal segments', () => {
    const plans = planSegments(10, 5)
    expect(plans).toHaveLength(2)
    expect(plans[0]).toMatchObject({
      id: 'seg_001', idx: 1, start_seconds: 0, end_seconds: 5, label: 'Scene 1', midpoint: 2.5,
    })
    expect(plans[1]).toMatchObject({
      id: 'seg_002', idx: 2, start_seconds: 5, end_seconds: 10, midpoint: 7.5,
    })
  })

  it('clamps the final segment to the video duration', () => {
    const plans = planSegments(7, 5)
    expect(plans).toHaveLength(2)
    expect(plans[1].start_seconds).toBe(5)
    expect(plans[1].end_seconds).toBe(7)
    expect(plans[1].midpoint).toBe(6)
  })

  it('handles a video shorter than one segment', () => {
    const plans = planSegments(2.4, 5)
    expect(plans).toHaveLength(1)
    expect(plans[0].end_seconds).toBe(2.4)
  })

  it('zero-pads ids past 9', () => {
    const plans = planSegments(55, 5)
    expect(plans[10].id).toBe('seg_011')
  })

  it('rejects nonsense inputs', () => {
    expect(() => planSegments(0, 5)).toThrow()
    expect(() => planSegments(10, 0)).toThrow()
    expect(() => planSegments(NaN, 5)).toThrow()
  })
})

describe('buildSegmentArgs', () => {
  it('caps encoder threads so a real HD source cannot OOM-kill the container', () => {
    const [plan] = planSegments(10, 5)
    const args = buildSegmentArgs('/in.mp4', '/out/seg_001.mp4', plan)
    const i = args.indexOf('-threads')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(Number(args[i + 1])).toBeLessThanOrEqual(8)
    expect(args.join(' ')).toContain('lookahead-threads=1')
  })

  it('keeps the correct command shape (libx264, input, output last)', () => {
    const [plan] = planSegments(10, 5)
    const args = buildSegmentArgs('/in.mp4', '/out/seg_001.mp4', plan)
    expect(args).toContain('libx264')
    expect(args[args.indexOf('-i') + 1]).toBe('/in.mp4')
    expect(args[args.length - 1]).toBe('/out/seg_001.mp4')
  })
})

describe('buildModelClipArgs', () => {
  it('downscales to 480p, keeps an audio stream, caps threads, output last', () => {
    const [plan] = planSegments(10, 5)
    const args = buildModelClipArgs('/in.mp4', '/out/seg_001_model.mp4', plan)
    expect(args.join(' ')).toContain('scale=-2:480')
    expect(args).toContain('-c:a')          // audio kept...
    expect(args).not.toContain('-an')       // ...NOT stripped
    const i = args.indexOf('-threads')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(Number(args[i + 1])).toBeLessThanOrEqual(8)
    expect(args[args.length - 1]).toBe('/out/seg_001_model.mp4')
  })
})

describe('cutSegment', () => {
  let workDir
  let clipPath

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'segmentation-test-'))
    clipPath = path.join(workDir, 'clip.mp4')
    await execFileAsync(ffmpegPath, [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=24',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clipPath,
    ])
  }, 60000)

  afterAll(async () => {
    await fs.rm(workDir, { recursive: true, force: true })
  })

  it('produces a playable segment file and a keyframe jpeg', async () => {
    const [plan] = planSegments(6, 3)
    const { segFile, kfFile, modelClipFile } = await cutSegment(clipPath, workDir, plan)

    const segStat = await fs.stat(segFile)
    expect(segStat.size).toBeGreaterThan(0)
    expect(segFile.endsWith('seg_001.mp4')).toBe(true)

    const kfBytes = await fs.readFile(kfFile)
    expect(kfBytes.length).toBeGreaterThan(0)
    // JPEG magic bytes
    expect(kfBytes[0]).toBe(0xff)
    expect(kfBytes[1]).toBe(0xd8)

    const modelStat = await fs.stat(modelClipFile)
    expect(modelStat.size).toBeGreaterThan(0)
    expect(modelClipFile.endsWith('seg_001_model.mp4')).toBe(true)
  }, 60000)
})

// ---------------------------------------------------------------------------
// Auto scene detection (2026-08-18 design)
// ---------------------------------------------------------------------------

import {
  parseScdetStderr, boundariesToScenes, buildSceneDetectArgs,
  detectScenes, planScenesAuto, sceneEnv,
} from './segmentation.js'

describe('parseScdetStderr', () => {
  // Captured verbatim from the bundled ffmpeg-static build.
  const FIXTURE = [
    'frame=    0 fps=0.0 q=-0.0 size=       0kB time=00:00:00.00 bitrate=N/A speed=   0x    ',
    '[scdet @ 00000000065d10c0] lavfi.scd.score: 15.625, lavfi.scd.time: 3',
    '[scdet @ 00000000065d10c0] lavfi.scd.score: 35.563, lavfi.scd.time: 6.006',
    '[out#0/null @ 000] video:443kB audio:0kB subtitle:0kB other streams:0kB',
  ].join('\n')

  it('extracts {time, score} pairs from real scdet log lines', () => {
    expect(parseScdetStderr(FIXTURE)).toEqual([
      { time: 3, score: 15.625 },
      { time: 6.006, score: 35.563 },
    ])
  })

  it('returns [] for empty / cut-free / undefined stderr', () => {
    expect(parseScdetStderr('')).toEqual([])
    expect(parseScdetStderr('frame= 100 fps=50')).toEqual([])
    expect(parseScdetStderr(undefined)).toEqual([])
  })
})

describe('buildSceneDetectArgs', () => {
  it('is a decode-only pass: downscaled, no audio, null output, no x264', () => {
    const args = buildSceneDetectArgs('/in.mp4', 10)
    expect(args[args.indexOf('-i') + 1]).toBe('/in.mp4')
    expect(args.join(' ')).toContain('scale=320:-2,scdet=threshold=10')
    expect(args).toContain('-an')
    expect(args).not.toContain('libx264')
    expect(args[args.length - 1]).toBe('-')
  })
})

describe('boundariesToScenes', () => {
  const OPTS = { minLen: 3, maxLen: 10, maxScenes: 30 }

  it('turns cuts into contiguous scenes in the planSegments shape', () => {
    const plans = boundariesToScenes(
      [{ time: 3, score: 15 }, { time: 6, score: 35 }], 10, OPTS)
    expect(plans).toHaveLength(3)
    expect(plans[0]).toMatchObject({
      id: 'seg_001', idx: 1, start_seconds: 0, end_seconds: 3, label: 'Scene 1', midpoint: 1.5,
    })
    expect(plans[1]).toMatchObject({ start_seconds: 3, end_seconds: 6 })
    expect(plans[2]).toMatchObject({ start_seconds: 6, end_seconds: 10 })
  })

  it('scenes always tile [0, duration] with no gaps', () => {
    const plans = boundariesToScenes(
      [{ time: 2.5, score: 12 }, { time: 9.9, score: 20 }, { time: 17, score: 11 }], 40, OPTS)
    expect(plans[0].start_seconds).toBe(0)
    expect(plans[plans.length - 1].end_seconds).toBe(40)
    for (let i = 1; i < plans.length; i++) {
      expect(plans[i].start_seconds).toBe(plans[i - 1].end_seconds)
    }
  })

  it('merges a too-short middle scene into the previous one', () => {
    // cuts at 4 and 5 -> middle scene is 1s < minLen 3
    const plans = boundariesToScenes(
      [{ time: 4, score: 15 }, { time: 5, score: 15 }], 12, OPTS)
    expect(plans.map((p) => [p.start_seconds, p.end_seconds])).toEqual([[0, 5], [5, 12]])
  })

  it('merges a too-short OPENING scene into the next one', () => {
    const plans = boundariesToScenes([{ time: 1, score: 30 }], 8, OPTS)
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ start_seconds: 0, end_seconds: 8 })
  })

  it('splits an over-long scene into equal chunks <= maxLen', () => {
    const plans = boundariesToScenes([{ time: 25, score: 15 }], 30, OPTS)
    // [0,25] is 25s -> 3 chunks of ~8.33; [25,30] stays
    expect(plans).toHaveLength(4)
    expect(plans[0].start_seconds).toBe(0)
    expect(plans[2].end_seconds).toBe(25)
    for (const p of plans.slice(0, 3)) {
      expect(p.end_seconds - p.start_seconds).toBeLessThanOrEqual(10.01)
      expect(p.end_seconds - p.start_seconds).toBeGreaterThanOrEqual(3)
    }
    expect(plans[3]).toMatchObject({ start_seconds: 25, end_seconds: 30 })
  })

  it('caps the number of cut-scenes by dropping the weakest cuts', () => {
    const cuts = [
      { time: 10, score: 50 }, { time: 20, score: 5 },
      { time: 30, score: 40 }, { time: 40, score: 6 },
    ]
    const plans = boundariesToScenes(cuts, 50, { minLen: 3, maxLen: 100, maxScenes: 3 })
    // strongest 2 cuts survive (10 and 30)
    expect(plans.map((p) => p.start_seconds)).toEqual([0, 10, 30])
  })

  it('dedupes near-identical cuts keeping the stronger score', () => {
    const plans = boundariesToScenes(
      [{ time: 5, score: 12 }, { time: 5.05, score: 60 }], 10, OPTS)
    expect(plans).toHaveLength(2)
    expect(plans[0].end_seconds).toBe(5.05)
  })

  it('ignores out-of-range cuts', () => {
    const plans = boundariesToScenes(
      [{ time: -1, score: 15 }, { time: 0, score: 15 }, { time: 99, score: 15 }], 8, OPTS)
    expect(plans).toHaveLength(1)
  })
})

describe('detectScenes / planScenesAuto', () => {
  const STDERR_WITH_CUTS = [
    '[scdet @ 0x1] lavfi.scd.score: 15.625, lavfi.scd.time: 3',
    '[scdet @ 0x1] lavfi.scd.score: 35.563, lavfi.scd.time: 6',
  ].join('\n')

  it('detectScenes builds a plan from ffmpeg stderr', async () => {
    const run = async () => ({ stdout: '', stderr: STDERR_WITH_CUTS })
    const plans = await detectScenes('/in.mp4', 10, { maxLen: 10, run })
    expect(plans.map((p) => [p.start_seconds, p.end_seconds])).toEqual([[0, 3], [3, 6], [6, 10]])
  })

  it('detectScenes falls back to fixed windows when no cuts are found', async () => {
    const run = async () => ({ stdout: '', stderr: 'frame= 100' })
    const plans = await detectScenes('/in.mp4', 12, { maxLen: 5, run })
    expect(plans).toEqual(planSegments(12, 5))
  })

  it('planScenesAuto falls back to fixed windows when detection throws', async () => {
    const detect = async () => { throw new Error('boom') }
    const logs = []
    const plans = await planScenesAuto('/in.mp4', 12, 5, (m) => logs.push(m), { detect })
    expect(plans).toEqual(planSegments(12, 5))
    expect(logs.join(' ')).toContain('scene detection failed')
  })

  it('planScenesAuto reverts entirely with AUTO_SCENES=0', async () => {
    const prev = process.env.AUTO_SCENES
    process.env.AUTO_SCENES = '0'
    try {
      const detect = async () => { throw new Error('must not be called') }
      const plans = await planScenesAuto('/in.mp4', 12, 5, () => {}, { detect })
      expect(plans).toEqual(planSegments(12, 5))
    } finally {
      if (prev === undefined) delete process.env.AUTO_SCENES
      else process.env.AUTO_SCENES = prev
    }
  })

  it('sceneEnv clamps garbage env to defaults', () => {
    const prev = { ...process.env }
    process.env.SCENE_THRESHOLD = 'nope'
    process.env.MIN_SCENE_SECONDS = '-4'
    process.env.MAX_SCENES = ''
    try {
      expect(sceneEnv()).toEqual({ threshold: 10, minLen: 3, maxScenes: 30 })
    } finally {
      for (const k of ['SCENE_THRESHOLD', 'MIN_SCENE_SECONDS', 'MAX_SCENES']) {
        if (prev[k] === undefined) delete process.env[k]
        else process.env[k] = prev[k]
      }
    }
  })
})

describe('detectScenes against real ffmpeg (integration)', () => {
  let workDir
  let cutClip

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scdet-test-'))
    cutClip = path.join(workDir, 'cuts.mp4')
    // red 3s | blue 3s | testsrc 4s -> hard cuts at t=3 and t=6
    await execFileAsync(ffmpegPath, [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=3',
      '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=3',
      '-f', 'lavfi', '-i', 'testsrc=s=320x240:d=4',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', cutClip,
    ])
  }, 60000)

  afterAll(async () => {
    await fs.rm(workDir, { recursive: true, force: true })
  })

  it('finds the constructed cuts at ~3s and ~6s', async () => {
    const plans = await detectScenes(cutClip, 10, { maxLen: 10 })
    expect(plans).toHaveLength(3)
    expect(plans[0].start_seconds).toBe(0)
    expect(plans[0].end_seconds).toBeGreaterThan(2.7)
    expect(plans[0].end_seconds).toBeLessThan(3.3)
    expect(plans[1].end_seconds).toBeGreaterThan(5.7)
    expect(plans[1].end_seconds).toBeLessThan(6.3)
    expect(plans[2].end_seconds).toBe(10)
  }, 60000)
})
