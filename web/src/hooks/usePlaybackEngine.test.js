import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import usePlaybackEngine, { computeClipLayout } from './usePlaybackEngine.js'

// A minimal stand-in for an <video> element: the engine only touches
// muted/volume/currentTime/paused/play/pause + the seeked event listeners.
function fakeVideo() {
  return {
    muted: false,
    volume: 1,
    currentTime: 0,
    paused: true,
    play: () => Promise.resolve(),
    pause() { this.paused = true },
    addEventListener() {},
    removeEventListener() {},
  }
}

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

// ---------------------------------------------------------------------------
// Per-clip mute + volume render — the active source's <video> element gets
// muted/volume from the active clip (Fix 1). One place, honoured on BOTH
// devices since both drive playback through this engine.
// ---------------------------------------------------------------------------
describe('usePlaybackEngine — mute + volume on the active element', () => {
  function setup(clips) {
    const el = fakeVideo()
    const videoRefs = { v1: { current: el } }
    renderHook(() => usePlaybackEngine(null, clips, [], true, videoRefs))
    return el
  }

  it('mutes the active source video when the active clip is muted', () => {
    const el = setup([
      { id: 's1', sourceId: 'v1', name: 's1', startTime: 0, endTime: 10, trimStart: 0, trimEnd: 0, muted: true },
    ])
    expect(el.muted).toBe(true)
  })

  it('leaves the active video unmuted when the active clip is not muted', () => {
    const el = setup([
      { id: 's1', sourceId: 'v1', name: 's1', startTime: 0, endTime: 10, trimStart: 0, trimEnd: 0, muted: false },
    ])
    expect(el.muted).toBe(false)
  })

  it('maps clip.volume (0-200 percent) onto element.volume (0-1)', () => {
    const el = setup([
      { id: 's1', sourceId: 'v1', name: 's1', startTime: 0, endTime: 10, trimStart: 0, trimEnd: 0, volume: 40 },
    ])
    expect(el.volume).toBe(0.4)
  })

  it('clamps volume above 100% to a max element volume of 1', () => {
    const el = setup([
      { id: 's1', sourceId: 'v1', name: 's1', startTime: 0, endTime: 10, trimStart: 0, trimEnd: 0, volume: 200 },
    ])
    expect(el.volume).toBe(1)
  })

  it('defaults to full volume (1) when the clip carries no volume', () => {
    const el = setup([
      { id: 's1', sourceId: 'v1', name: 's1', startTime: 0, endTime: 10, trimStart: 0, trimEnd: 0 },
    ])
    expect(el.volume).toBe(1)
  })

  it('updates mute and volume when the active clip is edited in place', () => {
    const el = fakeVideo()
    const videoRefs = { v1: { current: el } }
    const baseClip = {
      id: 's1', sourceId: 'v1', name: 's1', startTime: 0, endTime: 10,
      trimStart: 0, trimEnd: 0, muted: false, volume: 100,
    }
    const { rerender } = renderHook(
      ({ clips }) => usePlaybackEngine(null, clips, [], true, videoRefs),
      { initialProps: { clips: [baseClip] } },
    )

    expect(el.muted).toBe(false)
    expect(el.volume).toBe(1)

    rerender({ clips: [{ ...baseClip, muted: true, volume: 40 }] })

    expect(el.muted).toBe(true)
    expect(el.volume).toBe(0.4)
  })
})

describe('usePlaybackEngine — same-count reorder', () => {
  it('switches and seeks the real media element to the clip now at the active index', () => {
    const firstVideo = fakeVideo()
    const secondVideo = fakeVideo()
    firstVideo.paused = false
    const videoRefs = {
      v1: { current: firstVideo },
      v2: { current: secondVideo },
    }
    const a = { id: 'a', sourceId: 'v1', startTime: 0, endTime: 4, trimStart: 0, trimEnd: 0 }
    const b = { id: 'b', sourceId: 'v2', startTime: 5, endTime: 9, trimStart: 0, trimEnd: 0 }
    const { result, rerender } = renderHook(
      ({ clips }) => usePlaybackEngine(null, clips, [], true, videoRefs),
      { initialProps: { clips: [a, b] } },
    )

    expect(result.current.activeSourceId).toBe('v1')

    rerender({ clips: [b, a] })

    expect(result.current.activeSourceId).toBe('v2')
    expect(secondVideo.currentTime).toBe(5)
    expect(firstVideo.paused).toBe(true)
  })

  it('preserves current playback when only a later clip is edited', () => {
    const firstVideo = fakeVideo()
    const secondVideo = fakeVideo()
    const videoRefs = {
      v1: { current: firstVideo },
      v2: { current: secondVideo },
    }
    const a = { id: 'a', sourceId: 'v1', startTime: 0, endTime: 4, trimStart: 0, trimEnd: 0 }
    const b = { id: 'b', sourceId: 'v2', startTime: 5, endTime: 9, trimStart: 0, trimEnd: 0 }
    const { rerender } = renderHook(
      ({ clips }) => usePlaybackEngine(null, clips, [], true, videoRefs),
      { initialProps: { clips: [a, b] } },
    )

    firstVideo.currentTime = 2.5
    rerender({ clips: [a, { ...b, trimEnd: 1 }] })

    expect(firstVideo.currentTime).toBe(2.5)
  })
})
