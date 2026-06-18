export function srtToSeconds(s) {
  const m = String(s).trim().match(/^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/)
  if (!m) throw new Error(`bad SRT timecode: ${s}`)
  const [, h, mm, ss, ms] = m
  return (+h) * 3600 + (+mm) * 60 + (+ss) + (+ms.padEnd(3, '0')) / 1000
}

export function secondsToFfmpeg(n) {
  if (n < 0) n = 0
  const h = Math.floor(n / 3600)
  const mm = Math.floor((n % 3600) / 60)
  const ss = Math.floor(n % 60)
  const ms = Math.round((n - Math.floor(n)) * 1000)
  const p2 = (x) => String(x).padStart(2, '0')
  return `${p2(h)}:${p2(mm)}:${p2(ss)}.${String(ms).padStart(3, '0')}`
}

export function clipDuration(start, end) {
  return srtToSeconds(end) - srtToSeconds(start)
}
