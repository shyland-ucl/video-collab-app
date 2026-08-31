import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import ffmpegPath from 'ffmpeg-static'

const execFileAsync = promisify(execFile)

// libx264 auto-detects the HOST core count (Railway's many-core hosts yield
// threads=60) and gives every frame-thread its own full-resolution working
// buffers. On a memory-limited container that OOM-kills the encode on the first
// real HD video — the synthetic 320x240 test clip (1/27th the pixels) never
// exercised it. Capping the pool is the load-bearing memory fix. Tunable via
// env so the ceiling can be matched to the container without a code change, but
// hard-clamped to [1,8] so an operator can't accidentally tune it back into OOM
// territory (default-safe is 2; 8 is ample for the short segments/clips here).
const FFMPEG_THREADS_MAX = 8
export const FFMPEG_THREADS = (() => {
  const n = Math.floor(Number(process.env.FFMPEG_THREADS))
  return Number.isFinite(n) && n > 0 ? Math.min(n, FFMPEG_THREADS_MAX) : 2
})()

// Shared libx264 thread caps for every encode (segment + render clip). Pins the
// frame-thread pool (-threads, the dominant per-thread buffer multiplier) AND
// x264's internal lookahead pool. Append AFTER -preset so x264-params wins.
export function x264ThreadArgs() {
  return ['-threads', String(FFMPEG_THREADS), '-x264-params', 'lookahead-threads=1']
}

const FFMPEG_TIMEOUT_MS = (() => {
  const n = Math.floor(Number(process.env.FFMPEG_TIMEOUT_MS))
  return Number.isFinite(n) && n > 0 ? n : 600_000
})()

// timeout bounds a hung/runaway child; killSignal SIGKILL because ffmpeg traps
// SIGTERM and would keep running. err.killed then distinguishes OUR timeout kill
// (killed=true) from an OS/OOM SIGKILL (killed=false) — see formatExecError.
export const EXEC_OPTS = {
  maxBuffer: 10 * 1024 * 1024,
  timeout: FFMPEG_TIMEOUT_MS,
  killSignal: 'SIGKILL',
}

export const runFfmpeg = (args, opts = EXEC_OPTS) => execFileAsync(ffmpegPath, args, opts)

// execFile only rejects on a NON-ZERO exit, but ffmpeg exits 0 after encoding
// zero frames: it logs "Output file is empty, nothing was encoded" and, for the
// image2 muxer, never creates the output file at all. A caller that then read
// that file got a bare "ENOENT ... seg_NNN_kf.jpg" pointing at a temp dir that
// no longer exists. Assert the artefact we asked ffmpeg for actually landed, so
// the failure names itself at the call that caused it.
export async function runFfmpegTo(outFile, args, opts = EXEC_OPTS) {
  const result = await runFfmpeg(args, opts)
  const size = await fs.stat(outFile).then((s) => s.size).catch(() => -1)
  if (size <= 0) {
    throw new Error(
      `ffmpeg_no_output: ${path.basename(outFile)} not written — ffmpeg encoded 0 frames ` +
      '(seek past the end of the video stream?)'
    )
  }
  return result
}

// Previously the catch blocks stored only err.message: for a signalled child
// that is just "Command failed: <cmd> <stderr>" with NO exit code or signal — so
// an OOM kill (SIGKILL) was indistinguishable from a real ffmpeg error. Capture
// the discriminating fields and add a plain-language hint so the NEXT failure is
// unambiguous in the DB row.
export function formatExecError(err) {
  const parts = [String(err?.message ?? err)]
  if (err?.signal) parts.push(`signal=${err.signal}`)
  if (err?.code != null) parts.push(`code=${err.code}`)
  if (err?.killed) parts.push('killed=true')

  if (err?.killed) {
    parts.push('hint=timed out (exceeded FFMPEG_TIMEOUT_MS)')
  } else if (err?.signal === 'SIGKILL' || err?.code === 137) {
    parts.push('hint=external kill, likely container OOM — lower FFMPEG_THREADS or raise container memory')
  } else if (err?.signal === 'SIGTERM') {
    parts.push('hint=platform stop/redeploy')
  }
  return parts.join(' | ').slice(0, 4000)
}
