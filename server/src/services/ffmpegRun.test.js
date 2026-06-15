import { describe, it, expect } from 'vitest'
import { FFMPEG_THREADS, x264ThreadArgs, EXEC_OPTS, formatExecError } from './ffmpegRun.js'

describe('x264ThreadArgs', () => {
  it('caps libx264 threads to a small bounded number (never the host core count)', () => {
    const args = x264ThreadArgs()
    const i = args.indexOf('-threads')
    expect(i).toBeGreaterThanOrEqual(0)
    const n = Number(args[i + 1])
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThanOrEqual(8) // hard clamp ceiling — never the host core count
    expect(n).toBe(FFMPEG_THREADS)
  })

  it('pins the lookahead thread pool', () => {
    expect(x264ThreadArgs().join(' ')).toContain('lookahead-threads=1')
  })
})

describe('EXEC_OPTS', () => {
  it('bounds a hung/over-limit encode with a timeout and an unconditional kill', () => {
    expect(EXEC_OPTS.timeout).toBeGreaterThan(0)
    expect(EXEC_OPTS.killSignal).toBe('SIGKILL')
    expect(EXEC_OPTS.maxBuffer).toBeGreaterThanOrEqual(1024 * 1024)
  })
})

describe('formatExecError', () => {
  it('surfaces an external SIGKILL (the OOM fingerprint) with an actionable hint', () => {
    const s = formatExecError({ message: 'Command failed: ffmpeg ...', signal: 'SIGKILL', killed: false })
    expect(s).toContain('signal=SIGKILL')
    expect(s).toMatch(/OOM/i)
  })

  it('labels OUR timeout kill distinctly from an OOM kill', () => {
    const s = formatExecError({ message: 'Command failed', signal: 'SIGKILL', killed: true })
    expect(s).toContain('killed=true')
    expect(s).toMatch(/timed out/i)
    expect(s).not.toMatch(/OOM/i)
  })

  it('preserves a normal non-zero ffmpeg exit code and adds no OOM hint', () => {
    const s = formatExecError({ message: 'Command failed: ... Conversion failed!', code: 1 })
    expect(s).toContain('code=1')
    expect(s).not.toMatch(/OOM/i)
  })

  it('flags a platform SIGTERM (redeploy/eviction)', () => {
    expect(formatExecError({ message: 'x', signal: 'SIGTERM' })).toMatch(/platform stop|redeploy/i)
  })

  it('falls back to stringifying a bare error', () => {
    expect(formatExecError(new Error('boom'))).toContain('boom')
  })
})
