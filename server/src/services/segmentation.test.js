import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { planSegments, cutSegment } from './segmentation.js'

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
    const { segFile, kfFile } = await cutSegment(clipPath, workDir, plan)

    const segStat = await fs.stat(segFile)
    expect(segStat.size).toBeGreaterThan(0)
    expect(segFile.endsWith('seg_001.mp4')).toBe(true)

    const kfBytes = await fs.readFile(kfFile)
    expect(kfBytes.length).toBeGreaterThan(0)
    // JPEG magic bytes
    expect(kfBytes[0]).toBe(0xff)
    expect(kfBytes[1]).toBe(0xd8)
  }, 60000)
})
