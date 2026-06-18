import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
export const DEMO_DIR = join(__dir, '..')
export const OUT_DIR = join(DEMO_DIR, 'out')
export const F_ROOT = "F:\\Lan's Project"
export const SCRIPTS = "C:\\Users\\shyla\\Downloads\\Video_Editing_Platform\\Study Scripts"
// System ffmpeg/ffprobe are on PATH (ffprobe is required and not in ffmpeg-static).
export const FFMPEG = 'ffmpeg'
export const FFPROBE = 'ffprobe'
