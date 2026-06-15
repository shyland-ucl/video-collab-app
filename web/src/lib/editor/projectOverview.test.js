import { describe, it, expect } from 'vitest'
import {
  summarizeEditStateChange,
  summarizeVisualAdjustment,
  formatDuration,
  getTimelineDuration,
  getEffectiveClipDuration,
  getProjectOverviewText,
  describeEditOp,
  labelEditActor,
} from './projectOverview.js'

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------
describe('formatDuration', () => {
  it('renders seconds only when under a minute', () => {
    expect(formatDuration(45)).toBe('45 sec')
  })

  it('renders "X min Y sec" for values with both minutes and seconds', () => {
    // 65 s = 1 min 5 sec
    expect(formatDuration(65)).toBe('1 min 5 sec')
  })

  it('renders "X min" when seconds are exactly 0', () => {
    expect(formatDuration(120)).toBe('2 min')
  })

  it('rounds to nearest second', () => {
    expect(formatDuration(1.7)).toBe('2 sec')
  })

  it('returns "0 sec" for 0 or falsy input', () => {
    expect(formatDuration(0)).toBe('0 sec')
    expect(formatDuration(null)).toBe('0 sec')
  })
})

// ---------------------------------------------------------------------------
// getEffectiveClipDuration
// ---------------------------------------------------------------------------
describe('getEffectiveClipDuration', () => {
  it('returns duration minus trim amounts', () => {
    const clip = { startTime: 0, endTime: 10, trimStart: 1, trimEnd: 2 }
    expect(getEffectiveClipDuration(clip)).toBe(7)
  })

  it('returns 0 for null/undefined', () => {
    expect(getEffectiveClipDuration(null)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// getTimelineDuration
// ---------------------------------------------------------------------------
describe('getTimelineDuration', () => {
  it('sums effective clip durations accounting for trimStart and trimEnd', () => {
    const state = { clips: [{ id: 'a', startTime: 0, endTime: 5, trimStart: 1, trimEnd: 0 }] }
    // effective = (5 - 0) - 1 - 0 = 4
    expect(getTimelineDuration(state)).toBe(4)
  })

  it('returns 0 for empty clips array', () => {
    expect(getTimelineDuration({ clips: [] })).toBe(0)
  })

  it('returns fallbackDuration when clips array is empty', () => {
    expect(getTimelineDuration({ clips: [] }, 30)).toBe(30)
  })

  it('sums multiple clips', () => {
    const state = {
      clips: [
        { startTime: 0, endTime: 5, trimStart: 0, trimEnd: 0 },
        { startTime: 5, endTime: 10, trimStart: 0, trimEnd: 0 },
      ],
    }
    expect(getTimelineDuration(state)).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// summarizeEditStateChange
// ---------------------------------------------------------------------------
describe('summarizeEditStateChange', () => {
  const clip1 = { id: 'a', name: 'Scene 1', startTime: 0, endTime: 5, trimStart: 0, trimEnd: 0 }
  const clip2 = { id: 'b', name: 'Scene 2', startTime: 5, endTime: 10, trimStart: 0, trimEnd: 0 }

  it('summarizes a deletion — returns object with actionText mentioning the scene', () => {
    const prev = { clips: [clip1], captions: [], textOverlays: [] }
    const next = { clips: [], captions: [], textOverlays: [] }
    const summary = summarizeEditStateChange(prev, next, 'Helper')
    // actionText identifies the deleted scene (index 0 → "scene 1")
    expect(summary.actionText).toMatch(/deleted scene 1/i)
    expect(summary.shortText).toMatch(/Helper deleted scene 1/i)
    expect(summary.announcement).toBeTruthy()
    expect(summary.overviewText).toBeTruthy()
    expect(summary.promptText).toBeTruthy()
  })

  it('returns empty strings when nothing changed', () => {
    const state = { clips: [clip1], captions: [], textOverlays: [] }
    const summary = summarizeEditStateChange(state, state, 'Helper')
    expect(summary.actionText).toBe('')
    expect(summary.shortText).toBe('')
    expect(summary.announcement).toBe('')
    expect(summary.promptText).toBe('')
  })

  it('summarizes a split — actionText contains "split"', () => {
    const prev = { clips: [clip1], captions: [], textOverlays: [] }
    // simulate split: first keeps id 'a', second gets new id
    const next = {
      clips: [
        { ...clip1, endTime: 2.5 },
        { ...clip1, id: 'a-split-123', startTime: 2.5 },
      ],
      captions: [], textOverlays: [],
    }
    const summary = summarizeEditStateChange(prev, next, 'Helper')
    expect(summary.actionText).toMatch(/split/i)
  })

  it('summarizes a move — actionText contains "moved"', () => {
    const prev = { clips: [clip1, clip2], captions: [], textOverlays: [] }
    const next = { clips: [clip2, clip1], captions: [], textOverlays: [] }
    const summary = summarizeEditStateChange(prev, next, 'Helper')
    expect(summary.actionText).toMatch(/moved/i)
  })

  it('summarizes a trim change', () => {
    const prev = { clips: [clip1], captions: [], textOverlays: [] }
    const next = { clips: [{ ...clip1, trimStart: 0.5 }], captions: [], textOverlays: [] }
    const summary = summarizeEditStateChange(prev, next, 'Helper')
    expect(summary.actionText).toMatch(/trimmed/i)
  })

  it('summarizes an added caption', () => {
    const prev = { clips: [clip1], captions: [], textOverlays: [] }
    const next = {
      clips: [clip1],
      captions: [{ id: 'c1', sceneId: 'a', text: 'Hello', startTime: 0, endTime: 5 }],
      textOverlays: [],
    }
    const summary = summarizeEditStateChange(prev, next, 'Helper')
    expect(summary.actionText).toMatch(/added a caption/i)
  })

  it('summary object always has overviewText reflecting next state clip count', () => {
    const prev = { clips: [clip1, clip2], captions: [], textOverlays: [] }
    const next = { clips: [clip2], captions: [], textOverlays: [] }
    const summary = summarizeEditStateChange(prev, next, 'Helper')
    // next has 1 clip — overview should say "1 clip"
    expect(summary.overviewText).toMatch(/1 clip/)
  })

  // ---- Colour grade announcement (helper colour → BLV creator) ----
  // A single-property colour change must announce with the SAME wording the
  // helper device speaks (EditorTimeline → summarizeVisualAdjustment(property,
  // value, 'Helper')) so both devices — and the probe — describe the identical
  // edit identically. Per the probe, the wording carries NO scene number.
  it('announces a single-property colour change with the helper/probe wording (no scene number)', () => {
    const prev = { clips: [clip1, clip2], captions: [], textOverlays: [], colour: {} }
    const next = {
      clips: [clip1, clip2], captions: [], textOverlays: [],
      colour: { b: { brightness: 30 } }, // 'b' is clip2
    }
    const summary = summarizeEditStateChange(prev, next, 'Helper')
    // Identical to summarizeVisualAdjustment('brightness', 30, 'Helper').
    const expected = summarizeVisualAdjustment('brightness', 30, 'Helper')
    expect(summary).toEqual(expected)
    expect(summary.actionText).toBe('changed brightness +30')
    expect(summary.announcement).toBe(
      'Helper changed brightness +30. Review the video frame to confirm the visual change.'
    )
    // Faithful to the helper + probe: no "on scene N" appended.
    expect(summary.announcement).not.toMatch(/scene/i)
  })

  it('announces a rotate-only colour change (regression: rotate was missing from COLOUR_PROPS, so it was silent on the creator)', () => {
    const prev = { clips: [clip1], captions: [], textOverlays: [], colour: {} }
    const next = {
      clips: [clip1], captions: [], textOverlays: [],
      colour: { a: { rotate: 30 } }, // 'a' is clip1
    }
    const summary = summarizeEditStateChange(prev, next, 'Your helper')
    expect(summary).toEqual(summarizeVisualAdjustment('rotate', 30, 'Your helper'))
    expect(summary.actionText).toBe('changed rotation 30°')
    expect(summary.announcement).toBe(
      'Your helper changed rotation 30°. Review the video frame to confirm the visual change.'
    )
    expect(summary.announcement).not.toMatch(/scene/i)
  })

  it('uses the passed actorLabel as the colour-announcement prefix (creator hears its own label)', () => {
    const prev = { clips: [clip1], captions: [], textOverlays: [], colour: {} }
    const next = {
      clips: [clip1], captions: [], textOverlays: [],
      colour: { a: { brightness: 15 } },
    }
    // The creator-side EditorPage passes roleLabel(otherRole), e.g. "Your helper".
    const summary = summarizeEditStateChange(prev, next, 'Your helper')
    expect(summary.announcement).toBe(
      'Your helper changed brightness +15. Review the video frame to confirm the visual change.'
    )
  })

  it('announces a multi-property colour change as "adjusted the look of" the scene', () => {
    const prev = { clips: [clip1], captions: [], textOverlays: [], colour: {} }
    const next = {
      clips: [clip1], captions: [], textOverlays: [],
      colour: { a: { brightness: 20, contrast: 10 } }, // 'a' is clip1 → scene 1
    }
    const summary = summarizeEditStateChange(prev, next, 'Helper')
    expect(summary.actionText).toMatch(/adjusted the look of scene 1/i)
    expect(summary.announcement).toBeTruthy()
  })

  it('keys colour scenes by root segment id (a split half grades the root scene) — single property uses helper wording', () => {
    const splitHalf = { id: 'a-split-123-x', name: 'Scene 1', startTime: 2.5, endTime: 5, trimStart: 0, trimEnd: 0 }
    const prev = { clips: [clip1, splitHalf, clip2], captions: [], textOverlays: [], colour: {} }
    const next = {
      clips: [clip1, splitHalf, clip2], captions: [], textOverlays: [],
      colour: { a: { zoom: 120 } }, // root 'a' grade
    }
    const summary = summarizeEditStateChange(prev, next, 'Helper')
    expect(summary.actionText).toBe('changed zoom 120%')
    expect(summary.announcement).toMatch(/changed zoom 120%/i)
  })

  it('stays empty when the colour map is unchanged (no spurious announcement)', () => {
    const state = {
      clips: [clip1], captions: [], textOverlays: [],
      colour: { a: { brightness: 30 } },
    }
    const summary = summarizeEditStateChange(state, state, 'Helper')
    expect(summary.actionText).toBe('')
    expect(summary.announcement).toBe('')
  })

  // ---- Mute toggle announcement (helper/creator mute → other device) ----
  // A mute-ONLY diff changes no clip count / order / trim / caption, so before
  // the mute branch it fell through to an empty summary and the creator heard
  // nothing. The branch must yield a non-empty, scene-anchored announcement.
  it('announces a mute-only diff as "muted scene N"', () => {
    const prev = { clips: [clip1, clip2], captions: [], textOverlays: [] }
    const next = {
      clips: [clip1, { ...clip2, muted: true }], captions: [], textOverlays: [],
    }
    const summary = summarizeEditStateChange(prev, next, 'Helper')
    expect(summary.actionText).toBe('muted scene 2')
    expect(summary.shortText).toBe('Helper muted scene 2')
    expect(summary.announcement).toMatch(/^Helper muted scene 2\./)
    expect(summary.announcement).toBeTruthy()
  })

  it('announces an unmute-only diff as "unmuted scene N"', () => {
    const prev = { clips: [{ ...clip1, muted: true }, clip2], captions: [], textOverlays: [] }
    const next = { clips: [clip1, clip2], captions: [], textOverlays: [] }
    const summary = summarizeEditStateChange(prev, next, 'Helper')
    expect(summary.actionText).toBe('unmuted scene 1')
    expect(summary.shortText).toBe('Helper unmuted scene 1')
    expect(summary.announcement).toMatch(/^Helper unmuted scene 1\./)
  })

  it('stays empty when the muted flag is unchanged (no spurious announcement)', () => {
    const state = {
      clips: [{ ...clip1, muted: true }, clip2], captions: [], textOverlays: [],
    }
    const summary = summarizeEditStateChange(state, state, 'Helper')
    expect(summary.actionText).toBe('')
    expect(summary.announcement).toBe('')
  })
})

// ---------------------------------------------------------------------------
// getProjectOverviewText
// ---------------------------------------------------------------------------
describe('getProjectOverviewText', () => {
  it('includes clip count and duration', () => {
    const text = getProjectOverviewText({ clipCount: 3, totalDuration: 90, captionCount: 0, textOverlayCount: 0 })
    expect(text).toMatch(/3 clips/)
    expect(text).toMatch(/1 min 30 sec/)
  })

  it('includes caption count when > 0', () => {
    const text = getProjectOverviewText({ clipCount: 1, totalDuration: 5, captionCount: 2, textOverlayCount: 0 })
    expect(text).toMatch(/2 captions/)
  })

  it('omits caption count when 0', () => {
    const text = getProjectOverviewText({ clipCount: 1, totalDuration: 5, captionCount: 0, textOverlayCount: 0 })
    expect(text).not.toMatch(/caption/)
  })
})

// ---------------------------------------------------------------------------
// describeEditOp
// ---------------------------------------------------------------------------
describe('describeEditOp', () => {
  it('returns "Removed from edit" for delete / remove / discard', () => {
    expect(describeEditOp('delete')).toBe('Removed from edit')
    expect(describeEditOp('remove')).toBe('Removed from edit')
    expect(describeEditOp('discard')).toBe('Removed from edit')
  })

  it('returns "Moved earlier" for reorder / move_earlier / move_up', () => {
    expect(describeEditOp('move_earlier')).toBe('Moved earlier')
    expect(describeEditOp('reorder')).toBe('Moved earlier')
    expect(describeEditOp('move_up')).toBe('Moved earlier')
  })

  it('returns "Caption added" for add_caption / caption', () => {
    expect(describeEditOp('add_caption')).toBe('Caption added')
    expect(describeEditOp('caption')).toBe('Caption added')
  })

  it('returns "Edited" for null/undefined', () => {
    expect(describeEditOp(null)).toBe('Edited')
    expect(describeEditOp(undefined)).toBe('Edited')
  })
})

// ---------------------------------------------------------------------------
// labelEditActor
// ---------------------------------------------------------------------------
describe('labelEditActor', () => {
  it('maps CREATOR → Creator, HELPER → Helper, RESEARCHER / AI → AI', () => {
    expect(labelEditActor('CREATOR')).toBe('Creator')
    expect(labelEditActor('HELPER')).toBe('Helper')
    expect(labelEditActor('RESEARCHER')).toBe('AI')
    expect(labelEditActor('AI')).toBe('AI')
  })

  it('returns the fallback for unknown actors', () => {
    expect(labelEditActor('UNKNOWN')).toBe('Helper')
    expect(labelEditActor('UNKNOWN', 'Someone')).toBe('Someone')
  })
})
