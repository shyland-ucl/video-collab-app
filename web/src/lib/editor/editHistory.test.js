import { describe, it, expect, vi } from 'vitest'
import {
  MAX_HISTORY,
  emptyHistory,
  pushEntry,
  undoStep,
  redoStep,
  canUndo,
  canRedo,
  makeUndoableOp,
} from './editHistory.js'

const entry = (name) => ({ name, opFn: (s) => s, preImage: null })

describe('emptyHistory', () => {
  it('starts with nothing to undo or redo', () => {
    const h = emptyHistory()
    expect(canUndo(h)).toBe(false)
    expect(canRedo(h)).toBe(false)
  })
})

describe('pushEntry', () => {
  it('makes the pushed entry available to undo', () => {
    const h = pushEntry(emptyHistory(), entry('a'))
    expect(canUndo(h)).toBe(true)
  })

  it('drops the redo future, because a new edit forks the timeline', () => {
    const pushed = pushEntry(emptyHistory(), entry('a'))
    const undone = undoStep(pushed).history
    expect(canRedo(undone)).toBe(true)

    const forked = pushEntry(undone, entry('b'))
    expect(canRedo(forked)).toBe(false)
  })

  it('keeps only the newest MAX_HISTORY entries', () => {
    let h = emptyHistory()
    for (let i = 0; i < MAX_HISTORY + 5; i++) h = pushEntry(h, entry(`e${i}`))

    expect(h.past).toHaveLength(MAX_HISTORY)
    expect(h.past[0].name).toBe('e5')
    expect(h.past[h.past.length - 1].name).toBe(`e${MAX_HISTORY + 4}`)
  })

  it('does not mutate the history it is given', () => {
    const before = emptyHistory()
    pushEntry(before, entry('a'))
    expect(before.past).toEqual([])
  })
})

describe('undoStep', () => {
  it('returns the newest entry and moves it to the redo future', () => {
    const h = pushEntry(pushEntry(emptyHistory(), entry('a')), entry('b'))
    const step = undoStep(h)

    expect(step.entry.name).toBe('b')
    expect(step.history.past.map((e) => e.name)).toEqual(['a'])
    expect(step.history.future.map((e) => e.name)).toEqual(['b'])
  })

  it('returns null when there is nothing to undo', () => {
    expect(undoStep(emptyHistory())).toBeNull()
  })

  it('does not mutate the history it is given', () => {
    const h = pushEntry(emptyHistory(), entry('a'))
    undoStep(h)
    expect(h.past).toHaveLength(1)
    expect(h.future).toHaveLength(0)
  })
})

describe('redoStep', () => {
  it('returns the most recently undone entry and moves it back to the past', () => {
    const undone = undoStep(pushEntry(emptyHistory(), entry('a'))).history
    const step = redoStep(undone)

    expect(step.entry.name).toBe('a')
    expect(step.history.past.map((e) => e.name)).toEqual(['a'])
    expect(step.history.future).toEqual([])
  })

  it('returns null when there is nothing to redo', () => {
    expect(redoStep(emptyHistory())).toBeNull()
  })
})

describe('makeUndoableOp', () => {
  it('delegates to the raw op and returns its result', () => {
    const raw = vi.fn((s) => ({ ...s, edited: true }))
    const made = makeUndoableOp(raw)

    expect(made.opFn({ clips: [] })).toEqual({ clips: [], edited: true })
    expect(raw).toHaveBeenCalledTimes(1)
  })

  it('records the state the op was applied to, so undo can restore it', () => {
    const original = { clips: ['a'] }
    const made = makeUndoableOp((s) => ({ ...s, clips: [] }))

    made.opFn(original)

    expect(made.preImage).toBe(original)
  })

  // saveWithRebase re-runs the opFn against freshly-loaded remote state when the
  // first insert hits the version conflict, and THAT is the state the persisted
  // version was built on. Keeping the first pre-image would make undo restore a
  // snapshot that never accounted for the concurrent edit.
  it('keeps the LAST pre-image when the op is replayed on a rebase', () => {
    const local = { clips: ['a'] }
    const remote = { clips: ['a', 'b'] }
    const made = makeUndoableOp((s) => ({ ...s, clips: [] }))

    made.opFn(local)
    made.opFn(remote)

    expect(made.preImage).toBe(remote)
  })
})
