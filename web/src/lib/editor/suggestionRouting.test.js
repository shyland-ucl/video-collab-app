import { describe, it, expect } from 'vitest'
import {
  suggestionClip,
  taskStatusToOutcome,
  fixTemplateToOpFn,
  describeFixTemplate,
} from './suggestionRouting'

const CLIPS = [
  { id: 'seg-a', name: 'Scene 1', muted: false },
  { id: 'seg-b-split-1765-x', name: 'Scene 2', muted: false }, // a split half of seg-b
  { id: 'seg-c', name: 'Scene 3', muted: true },
]

describe('suggestionClip', () => {
  it('matches a suggestion to its scene by segment_id', () => {
    expect(suggestionClip({ segment_id: 'seg-a' }, CLIPS)?.id).toBe('seg-a')
  })
  it('resolves a split half back to its root segment', () => {
    expect(suggestionClip({ segment_id: 'seg-b' }, CLIPS)?.id).toBe('seg-b-split-1765-x')
  })
  it('returns null for a deleted (unmatched) scene', () => {
    expect(suggestionClip({ segment_id: 'seg-z' }, CLIPS)).toBeNull()
  })
  it('returns null when the suggestion has no segment_id', () => {
    expect(suggestionClip({}, CLIPS)).toBeNull()
  })
})

describe('taskStatusToOutcome', () => {
  it('maps helper task statuses to outcomes', () => {
    expect(taskStatusToOutcome('done')).toBe('applied')
    expect(taskStatusToOutcome('cant_do')).toBe('failed')
    expect(taskStatusToOutcome('needs_discussion')).toBe('pending')
    expect(taskStatusToOutcome('pending')).toBe('pending')
    expect(taskStatusToOutcome('weird')).toBe('pending')
  })
})

describe('fixTemplateToOpFn', () => {
  it('sets a colour value keyed by rootSegmentId', () => {
    const fn = fixTemplateToOpFn({ action: 'brightness', value: 30 }, 'seg-b-split-1765-x')
    const next = fn({ clips: CLIPS, colour: {} })
    expect(next.colour['seg-b']).toEqual({ brightness: 30 })
  })
  it('merges into an existing colour grade without dropping other keys', () => {
    const fn = fixTemplateToOpFn({ action: 'zoom', value: 150 }, 'seg-a')
    const next = fn({ clips: CLIPS, colour: { 'seg-a': { brightness: 10 } } })
    expect(next.colour['seg-a']).toEqual({ brightness: 10, zoom: 150 })
  })
  it('mutes the clip via applyOperation (deterministic set)', () => {
    const fn = fixTemplateToOpFn({ action: 'mute', value: true }, 'seg-a')
    const next = fn({ clips: CLIPS, colour: {} })
    expect(next.clips.find((c) => c.id === 'seg-a').muted).toBe(true)
  })
  it('unmutes the clip', () => {
    const fn = fixTemplateToOpFn({ action: 'unmute', value: false }, 'seg-c')
    const next = fn({ clips: CLIPS, colour: {} })
    expect(next.clips.find((c) => c.id === 'seg-c').muted).toBe(false)
  })
  it('is an identity op for an unknown action or missing inputs', () => {
    const s = { clips: CLIPS, colour: {} }
    expect(fixTemplateToOpFn({ action: 'teleport', value: 1 }, 'seg-a')(s)).toBe(s)
    expect(fixTemplateToOpFn(null, 'seg-a')(s)).toBe(s)
    expect(fixTemplateToOpFn({ action: 'brightness', value: 10 }, null)(s)).toBe(s)
  })
})

describe('describeFixTemplate', () => {
  it('is sign-aware for the bipolar sliders', () => {
    expect(describeFixTemplate({ action: 'brightness', value: 20 }, 'Scene 1').question).toBe('Increase the brightness on Scene 1?')
    expect(describeFixTemplate({ action: 'brightness', value: -20 }, 'Scene 1').question).toBe('Reduce the brightness on Scene 1?')
    expect(describeFixTemplate({ action: 'contrast', value: -5 }, 'Scene 1').done).toBe('Reduced the contrast on Scene 1.')
  })
  it('describes zoom, rotate, mute, unmute', () => {
    expect(describeFixTemplate({ action: 'zoom', value: 150 }, 'Scene 2').question).toBe('Zoom Scene 2 to 150%?')
    expect(describeFixTemplate({ action: 'rotate', value: 5 }, 'Scene 2').question).toBe('Rotate Scene 2 by 5 degrees?')
    expect(describeFixTemplate({ action: 'mute', value: true }, 'Scene 3').question).toBe('Mute the original audio on Scene 3?')
    expect(describeFixTemplate({ action: 'unmute', value: false }, 'Scene 3').done).toBe('Unmuted the original audio on Scene 3.')
  })
  it('falls back to a generic scene name and null for unknown actions', () => {
    expect(describeFixTemplate({ action: 'zoom', value: 120 }, '').question).toContain('this scene')
    expect(describeFixTemplate({ action: 'teleport', value: 1 }, 'Scene 1')).toBeNull()
    expect(describeFixTemplate(null, 'Scene 1')).toBeNull()
  })
})
