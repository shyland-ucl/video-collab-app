/**
 * DOCUMENTED API — applyOperation dispatch table
 * ================================================
 * applyOperation(editState, sceneId, operation, options) accepts the following
 * operation strings (case-insensitive):
 *
 *   Trim / cut:
 *     'trim'        — alias for 'trim_start', tightens start by TRIM_STEP_SECONDS (0.5 s)
 *     'trim_start'  — tightens clip start by 0.5 s (options: none used by dispatcher)
 *     'trim_end'    — tightens clip end by 0.5 s
 *
 *   Split:
 *     'split'       — options.currentTime (number) used as split point; falls back to midpoint
 *
 *   Delete:
 *     'delete'      — removes the clip and its captions
 *     'remove'      — alias for 'delete'
 *     'discard'     — alias for 'delete'
 *
 *   Reorder / move:
 *     'reorder'     — moves clip earlier (toward index 0), alias for 'move_earlier'
 *     'move_earlier'— moves clip earlier (swaps with predecessor)
 *     'move_up'     — alias for 'move_earlier'
 *     'move_later'  — moves clip later (swaps with successor)
 *     'move_down'   — alias for 'move_later'
 *
 *   Caption:
 *     'add_caption' — options.captionText (string); defaults to 'AI-added caption'
 *     'caption'     — alias for 'add_caption'
 *
 *   Sound:
 *     'add_sound'   — options.sound / options.soundId / falls back to SOUND_LIBRARY[0]
 *     'sound'       — alias for 'add_sound'
 *     'remove_sound'— clears the sound from the clip
 *
 *   Mute / unmute:
 *     'mute'        — sets clip.muted = true
 *     'mute_audio'  — alias for 'mute'
 *     'unmute'      — sets clip.muted = false
 *     'unmute_audio'— alias for 'unmute'
 *     'toggle_mute' — flips clip.muted
 *
 *   Unknown operation — returns editState unchanged (safe no-op).
 *
 * DIRECT FUNCTION ARGUMENT VALUES (not applyOperation):
 *   trimClipStart(editState, sceneId, direction):
 *     direction: +1 (tighten, increases trimStart by 0.5 s)
 *                -1 (loosen, decreases trimStart by 0.5 s, floor 0)
 *
 *   trimClipEnd(editState, sceneId, direction):
 *     direction: +1 (tighten, increases trimEnd by 0.5 s)
 *                -1 (loosen, decreases trimEnd by 0.5 s, floor 0)
 *
 *   moveClip(editState, sceneId, direction):
 *     direction: 'up'   — swap with predecessor (move earlier in timeline)
 *                'down' — swap with successor  (move later in timeline)
 *     NOTE: applyOperation maps 'move_earlier'/'reorder'/'move_up' → 'up'
 *                               'move_later'/'move_down'           → 'down'
 */

import { describe, it, expect } from 'vitest'
import {
  splitClip, moveClip, deleteClip, addCaption,
  trimClipStart, trimClipEnd, applyOperation, getClipForScene,
} from './sceneEditOps.js'

function makeState() {
  return {
    clips: [
      { id: 's1', sourceId: 'v1', name: 'Scene 1', startTime: 0, endTime: 5, trimStart: 0, trimEnd: 0, color: '#aaa', muted: false },
      { id: 's2', sourceId: 'v1', name: 'Scene 2', startTime: 5, endTime: 10, trimStart: 0, trimEnd: 0, color: '#bbb', muted: false },
    ],
    captions: [],
    textOverlays: [],
    sources: [{ id: 'v1', name: 'vid', src: 'blob:x', duration: 10 }],
  }
}

describe('sceneEditOps (characterization of the probe port)', () => {
  // ------------------------------------------------------------------ deleteClip
  it('deleteClip removes the clip and leaves others', () => {
    const next = deleteClip(makeState(), 's1')
    expect(next.clips.map((c) => c.id)).toEqual(['s2'])
  })

  it('deleteClip does not mutate the input state', () => {
    const state = makeState()
    deleteClip(state, 's1')
    expect(state.clips).toHaveLength(2)
  })

  it('deleteClip also removes captions belonging to the deleted scene', () => {
    const state = makeState()
    state.captions = [
      { id: 'cap1', sceneId: 's1', text: 'hello', startTime: 0, endTime: 5 },
      { id: 'cap2', sceneId: 's2', text: 'world', startTime: 5, endTime: 10 },
    ]
    const next = deleteClip(state, 's1')
    expect(next.captions.map((c) => c.id)).toEqual(['cap2'])
  })

  // ------------------------------------------------------------------ moveClip
  it('moveClip direction "up" swaps clip with predecessor (moves earlier)', () => {
    const next = moveClip(makeState(), 's2', 'up')
    expect(next.clips.map((c) => c.id)).toEqual(['s2', 's1'])
  })

  it('moveClip direction "down" swaps clip with successor (moves later)', () => {
    const next = moveClip(makeState(), 's1', 'down')
    expect(next.clips.map((c) => c.id)).toEqual(['s2', 's1'])
  })

  it('moveClip at the start boundary with "up" is a no-op', () => {
    const next = moveClip(makeState(), 's1', 'up')
    expect(next.clips.map((c) => c.id)).toEqual(['s1', 's2'])
  })

  it('moveClip at the end boundary with "down" is a no-op', () => {
    const next = moveClip(makeState(), 's2', 'down')
    expect(next.clips.map((c) => c.id)).toEqual(['s1', 's2'])
  })

  // ------------------------------------------------------------------ splitClip
  it('splitClip produces two clips: first keeps original id, second gets -split- suffix', () => {
    const next = splitClip(makeState(), 's1', 2)
    expect(next.clips).toHaveLength(3)
    const [first, second] = next.clips
    expect(first.id).toBe('s1')
    expect(second.id).toMatch(/^s1-split-/)
  })

  it('splitClip first piece ends at split time, second piece starts at split time', () => {
    const next = splitClip(makeState(), 's1', 2)
    const [first, second] = next.clips
    expect(first.endTime).toBe(2)
    expect(second.startTime).toBe(2)
  })

  it('splitClip covers the original range (no gap)', () => {
    const next = splitClip(makeState(), 's1', 2)
    const [first, second] = next.clips
    // original startTime..endTime = 0..5; split at 2
    expect(first.startTime).toBe(0)
    expect(second.endTime).toBe(5)
  })

  it('splitClip first piece resets trimEnd to 0, second piece resets trimStart to 0', () => {
    const state = makeState()
    state.clips[0].trimStart = 0.5
    state.clips[0].trimEnd = 0.5
    const next = splitClip(state, 's1', 2)
    const [first, second] = next.clips
    expect(first.trimEnd).toBe(0)
    expect(second.trimStart).toBe(0)
  })

  it('splitClip with no splitTime defaults to clip midpoint', () => {
    const next = splitClip(makeState(), 's1')
    const [first, second] = next.clips
    // midpoint of 0..5 = 2.5
    expect(first.endTime).toBe(2.5)
    expect(second.startTime).toBe(2.5)
  })

  // ------------------------------------------------------------------ addCaption
  it('addCaption attaches a caption to the scene', () => {
    const next = addCaption(makeState(), 's2', 'hello')
    expect(next.captions).toHaveLength(1)
    expect(next.captions[0]).toMatchObject({ sceneId: 's2', text: 'hello' })
  })

  it('addCaption caption startTime/endTime match the clip bounds', () => {
    const next = addCaption(makeState(), 's2', 'hi')
    expect(next.captions[0].startTime).toBe(5)
    expect(next.captions[0].endTime).toBe(10)
  })

  it('addCaption with empty text is a no-op', () => {
    const next = addCaption(makeState(), 's1', '   ')
    expect(next.captions).toHaveLength(0)
  })

  // ------------------------------------------------------------------ trimClipStart
  it('trimClipStart direction +1 increases trimStart by 0.5 s', () => {
    const next = trimClipStart(makeState(), 's1', +1)
    expect(getClipForScene(next, 's1').trimStart).toBe(0.5)
  })

  it('trimClipStart direction -1 decreases trimStart (floor 0)', () => {
    // already 0 so stays at 0
    const next = trimClipStart(makeState(), 's1', -1)
    expect(getClipForScene(next, 's1').trimStart).toBe(0)
  })

  it('trimClipStart does not mutate input', () => {
    const state = makeState()
    trimClipStart(state, 's1', +1)
    expect(state.clips[0].trimStart).toBe(0)
  })

  // ------------------------------------------------------------------ trimClipEnd
  it('trimClipEnd direction +1 increases trimEnd by 0.5 s', () => {
    const next = trimClipEnd(makeState(), 's1', +1)
    expect(getClipForScene(next, 's1').trimEnd).toBe(0.5)
  })

  it('trimClipEnd direction -1 decreases trimEnd (floor 0)', () => {
    const next = trimClipEnd(makeState(), 's1', -1)
    expect(getClipForScene(next, 's1').trimEnd).toBe(0)
  })

  // ------------------------------------------------------------------ applyOperation dispatch
  it('applyOperation "delete" removes the clip', () => {
    const next = applyOperation(makeState(), 's1', 'delete')
    expect(next.clips.map((c) => c.id)).toEqual(['s2'])
  })

  it('applyOperation "remove" is an alias for delete', () => {
    const next = applyOperation(makeState(), 's1', 'remove')
    expect(next.clips.map((c) => c.id)).toEqual(['s2'])
  })

  it('applyOperation "discard" is an alias for delete', () => {
    const next = applyOperation(makeState(), 's1', 'discard')
    expect(next.clips.map((c) => c.id)).toEqual(['s2'])
  })

  it('applyOperation "trim" / "trim_start" tightens the start', () => {
    const next = applyOperation(makeState(), 's1', 'trim_start')
    expect(getClipForScene(next, 's1').trimStart).toBe(0.5)
    const next2 = applyOperation(makeState(), 's1', 'trim')
    expect(getClipForScene(next2, 's1').trimStart).toBe(0.5)
  })

  it('applyOperation "trim_end" tightens the end', () => {
    const next = applyOperation(makeState(), 's1', 'trim_end')
    expect(getClipForScene(next, 's1').trimEnd).toBe(0.5)
  })

  it('applyOperation "split" splits at options.currentTime', () => {
    const next = applyOperation(makeState(), 's1', 'split', { currentTime: 3 })
    expect(next.clips[0].endTime).toBe(3)
    expect(next.clips[1].startTime).toBe(3)
  })

  it('applyOperation "move_earlier" / "reorder" / "move_up" moves clip up', () => {
    for (const op of ['move_earlier', 'reorder', 'move_up']) {
      const next = applyOperation(makeState(), 's2', op)
      expect(next.clips.map((c) => c.id)).toEqual(['s2', 's1'])
    }
  })

  it('applyOperation "move_later" / "move_down" moves clip down', () => {
    for (const op of ['move_later', 'move_down']) {
      const next = applyOperation(makeState(), 's1', op)
      expect(next.clips.map((c) => c.id)).toEqual(['s2', 's1'])
    }
  })

  it('applyOperation "add_caption" attaches a caption from options.captionText', () => {
    const next = applyOperation(makeState(), 's1', 'add_caption', { captionText: 'Test caption' })
    expect(next.captions[0]).toMatchObject({ sceneId: 's1', text: 'Test caption' })
  })

  it('applyOperation "add_caption" defaults captionText to "AI-added caption" when not provided', () => {
    const next = applyOperation(makeState(), 's1', 'add_caption')
    expect(next.captions[0].text).toBe('AI-added caption')
  })

  it('applyOperation "caption" is an alias for "add_caption"', () => {
    const next = applyOperation(makeState(), 's1', 'caption', { captionText: 'Hi' })
    expect(next.captions[0].text).toBe('Hi')
  })

  it('applyOperation unknown operation returns state unchanged', () => {
    const state = makeState()
    const next = applyOperation(state, 's1', 'explode')
    expect(next).toBe(state)
  })

  it('applyOperation "mute" sets clip.muted = true', () => {
    const next = applyOperation(makeState(), 's1', 'mute')
    expect(getClipForScene(next, 's1').muted).toBe(true)
  })

  it('applyOperation "unmute" sets clip.muted = false', () => {
    const state = makeState()
    state.clips[0].muted = true
    const next = applyOperation(state, 's1', 'unmute')
    expect(getClipForScene(next, 's1').muted).toBe(false)
  })

  it('applyOperation "toggle_mute" flips muted state', () => {
    const next = applyOperation(makeState(), 's1', 'toggle_mute')
    expect(getClipForScene(next, 's1').muted).toBe(true)
    const next2 = applyOperation(next, 's1', 'toggle_mute')
    expect(getClipForScene(next2, 's1').muted).toBe(false)
  })
})
