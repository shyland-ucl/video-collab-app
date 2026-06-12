import { describe, it, expect } from 'vitest'
import { computeClipLayout } from './usePlaybackEngine.js'

// computeClipLayout(clips) — pure EDL layout helper extracted from usePlaybackEngine.
// Each entry: { clip, effectiveStart, effectiveEnd, duration, edlOffset }
//   effectiveStart = clip.startTime + clip.trimStart
//   effectiveEnd   = clip.endTime   - clip.trimEnd
//   duration       = max(0, effectiveEnd - effectiveStart)
//   edlOffset      = cumulative sum of prior clip durations

describe('computeClipLayout (characterization)', () => {
  function makeClip(id, startTime, endTime, trimStart = 0, trimEnd = 0, sourceId = 'v1') {
    return { id, sourceId, name: id, startTime, endTime, trimStart, trimEnd, color: '#aaa', muted: false }
  }

  it('returns empty array for null/empty input', () => {
    expect(computeClipLayout(null)).toEqual([])
    expect(computeClipLayout([])).toEqual([])
  })

  it('computes a single untrimmed clip correctly', () => {
    const clips = [makeClip('s1', 0, 10)]
    const layout = computeClipLayout(clips)
    expect(layout).toHaveLength(1)
    expect(layout[0]).toMatchObject({
      effectiveStart: 0,
      effectiveEnd: 10,
      duration: 10,
      edlOffset: 0,
    })
    expect(layout[0].clip.id).toBe('s1')
  })

  it('applies trimStart and trimEnd to narrow the effective range', () => {
    const clips = [makeClip('s1', 0, 10, 1, 2)]
    const layout = computeClipLayout(clips)
    expect(layout[0].effectiveStart).toBe(1)
    expect(layout[0].effectiveEnd).toBe(8)
    expect(layout[0].duration).toBe(7)
  })

  it('accumulates edlOffset across clips', () => {
    const clips = [makeClip('s1', 0, 5), makeClip('s2', 5, 10)]
    const layout = computeClipLayout(clips)
    expect(layout[0].edlOffset).toBe(0)
    expect(layout[1].edlOffset).toBe(5)   // first clip is 5s long
    expect(layout[1].effectiveStart).toBe(5)
    expect(layout[1].effectiveEnd).toBe(10)
    expect(layout[1].duration).toBe(5)
  })

  it('clamps duration to 0 when trim exceeds clip length', () => {
    const clips = [makeClip('s1', 0, 3, 2, 2)]   // 3s clip trimmed by 4s total
    const layout = computeClipLayout(clips)
    expect(layout[0].duration).toBe(0)
  })

  it('preserves clip reference in each entry', () => {
    const clip = makeClip('s1', 0, 5)
    const layout = computeClipLayout([clip])
    expect(layout[0].clip).toBe(clip)
  })

  it('handles three clips with mixed trims and sequential offsets', () => {
    const clips = [
      makeClip('a', 0, 4, 0, 0),   // 4s
      makeClip('b', 0, 6, 1, 1),   // 4s effective
      makeClip('c', 0, 3, 0, 0),   // 3s
    ]
    const layout = computeClipLayout(clips)
    expect(layout[0].edlOffset).toBe(0)
    expect(layout[1].edlOffset).toBe(4)
    expect(layout[2].edlOffset).toBe(8)
    expect(layout[2].effectiveStart).toBe(0)
    expect(layout[2].effectiveEnd).toBe(3)
    expect(layout[2].duration).toBe(3)
  })
})
