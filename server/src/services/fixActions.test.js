import { describe, it, expect } from 'vitest'
import { AI_FIXABLE_ACTIONS, FIX_VALUE_RANGES, inRangeValue } from './fixActions.js'

describe('fixActions', () => {
  it('lists the fixable actions', () => {
    expect(AI_FIXABLE_ACTIONS).toEqual(['brightness', 'contrast', 'saturation', 'zoom', 'rotate', 'mute', 'unmute'])
  })

  it('defines numeric ranges for the colour/geometry ops only', () => {
    expect(FIX_VALUE_RANGES.brightness).toEqual([-100, 100])
    expect(FIX_VALUE_RANGES.zoom).toEqual([100, 250])
    expect(FIX_VALUE_RANGES.rotate).toEqual([-180, 180])
    expect(FIX_VALUE_RANGES.mute).toBeUndefined()
  })

  it('inRangeValue accepts in-range finite numbers, rejects the rest', () => {
    expect(inRangeValue('brightness', 30)).toBe(true)
    expect(inRangeValue('brightness', -100)).toBe(true)
    expect(inRangeValue('brightness', 101)).toBe(false)
    expect(inRangeValue('zoom', 99)).toBe(false)
    expect(inRangeValue('rotate', 90)).toBe(true)
    expect(inRangeValue('brightness', NaN)).toBe(false)
    expect(inRangeValue('brightness', '30')).toBe(false)
    expect(inRangeValue('mute', 1)).toBe(false)
    expect(inRangeValue('nope', 1)).toBe(false)
  })
})
