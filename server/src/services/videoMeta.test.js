import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { getVideoMeta } from './videoMeta.js'

const execFileAsync = promisify(execFile)

let workDir
let clipPath

beforeAll(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videometa-test-'))
  clipPath = path.join(workDir, 'clip.mp4')
  await execFileAsync(ffmpegPath, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=24',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clipPath,
  ])
}, 60000)

afterAll(async () => {
  await fs.rm(workDir, { recursive: true, force: true })
})

describe('getVideoMeta', () => {
  it('reads duration, dimensions, fps, and size from a real clip', async () => {
    const meta = await getVideoMeta(clipPath)
    expect(meta.duration_seconds).toBeGreaterThan(3.5)
    expect(meta.duration_seconds).toBeLessThan(4.5)
    expect(meta.width).toBe(320)
    expect(meta.height).toBe(240)
    expect(meta.fps).toBeCloseTo(24, 0)
    expect(meta.size_bytes).toBeGreaterThan(0)
  }, 30000)

  it('rejects a file with no video stream', async () => {
    const textPath = path.join(workDir, 'not-a-video.mp4')
    await fs.writeFile(textPath, 'plain text pretending to be video')
    await expect(getVideoMeta(textPath)).rejects.toThrow()
  }, 30000)
})
