import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ffprobeStatic from 'ffprobe-static'

const execFileAsync = promisify(execFile)

export async function getVideoMeta(filePath) {
  const { stdout } = await execFileAsync(
    ffprobeStatic.path,
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { maxBuffer: 10 * 1024 * 1024 }
  )
  const info = JSON.parse(stdout)
  const stream = (info.streams ?? []).find((s) => s.codec_type === 'video')
  if (!stream) throw new Error('no_video_stream')

  const duration = Number(info.format?.duration)
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('bad_duration')

  let fps = null
  const [num, den] = String(stream.r_frame_rate ?? '').split('/').map(Number)
  if (Number.isFinite(num) && Number.isFinite(den) && den > 0) fps = num / den

  return {
    duration_seconds: duration,
    width: stream.width ?? null,
    height: stream.height ?? null,
    fps,
    size_bytes: Number(info.format?.size) || null,
  }
}
