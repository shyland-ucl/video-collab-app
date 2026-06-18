import { describe, it, expect } from 'vitest'
import { srtToSeconds, secondsToFfmpeg, clipDuration } from './timecode.mjs'

describe('timecode', () => {
  it('parses comma and dot millis', () => {
    expect(srtToSeconds('00:14:03,897')).toBeCloseTo(843.897, 3)
    expect(srtToSeconds('01:16:44.850')).toBeCloseTo(4604.850, 3)
  })
  it('formats seconds for ffmpeg', () => {
    expect(secondsToFfmpeg(843.897)).toBe('00:14:03.897')
    expect(secondsToFfmpeg(5)).toBe('00:00:05.000')
  })
  it('computes clip duration', () => {
    expect(clipDuration('00:14:03,897', '00:14:08,039')).toBeCloseTo(4.142, 3)
  })
})
