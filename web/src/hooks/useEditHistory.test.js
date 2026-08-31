import { describe, it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useEditHistory } from './useEditHistory.js'

const STATE = { clips: [{ id: 's1' }, { id: 's2' }] }

// Mirrors EditorPage.applyAndSave: runs the opFn against tracked state and
// resolves true only when the change persisted.
function trackingApplyAndSave(tracked, { ok = true } = {}) {
  return vi.fn((opFn) => {
    if (ok) tracked.state = opFn(tracked.state)
    return Promise.resolve(ok)
  })
}

const deleteFirst = (s) => ({ ...s, clips: s.clips.slice(1) })

describe('useEditHistory', () => {
  it('starts with nothing to undo or redo', () => {
    const { result } = renderHook(() => useEditHistory(vi.fn()))
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(false)
  })

  it('passes the edit through to applyAndSave and records it', async () => {
    const tracked = { state: STATE }
    const applyAndSave = trackingApplyAndSave(tracked)
    const { result } = renderHook(() => useEditHistory(applyAndSave))

    await act(async () => {
      await result.current.applyAndSaveUndoable(deleteFirst, 'Deleted Scene 1')
    })

    expect(tracked.state.clips.map((c) => c.id)).toEqual(['s2'])
    expect(applyAndSave.mock.calls[0][1]).toBe('Deleted Scene 1')
    expect(result.current.canUndo).toBe(true)
  })

  // A conflicted or failed save never reached the server, so undoing it would
  // restore a state that was never persisted.
  it('does not record an edit whose save failed', async () => {
    const tracked = { state: STATE }
    const { result } = renderHook(() =>
      useEditHistory(trackingApplyAndSave(tracked, { ok: false }))
    )

    await act(async () => {
      await result.current.applyAndSaveUndoable(deleteFirst, 'Deleted Scene 1')
    })

    expect(result.current.canUndo).toBe(false)
  })

  it('undo restores the state the edit was applied to', async () => {
    const tracked = { state: STATE }
    const applyAndSave = trackingApplyAndSave(tracked)
    const { result } = renderHook(() => useEditHistory(applyAndSave))

    await act(async () => {
      await result.current.applyAndSaveUndoable(deleteFirst, 'Deleted Scene 1')
    })
    await act(async () => { await result.current.undo() })

    expect(tracked.state.clips.map((c) => c.id)).toEqual(['s1', 's2'])
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(true)
  })

  // Undo/redo replace state wholesale, so replaying them onto rebased remote
  // state would clobber a concurrent edit with a stale snapshot.
  it('saves undo and redo non-rebasably', async () => {
    const tracked = { state: STATE }
    const applyAndSave = trackingApplyAndSave(tracked)
    const { result } = renderHook(() => useEditHistory(applyAndSave))

    await act(async () => {
      await result.current.applyAndSaveUndoable(deleteFirst, 'Deleted Scene 1')
    })
    await act(async () => { await result.current.undo() })
    await act(async () => { await result.current.redo() })

    const [undoCall, redoCall] = applyAndSave.mock.calls.slice(1)
    expect(undoCall[2]).toEqual(expect.objectContaining({ rebasable: false }))
    expect(redoCall[2]).toEqual(expect.objectContaining({ rebasable: false }))
  })

  it('keeps the entry undoable when the undo save fails', async () => {
    const tracked = { state: STATE }
    let ok = true
    const applyAndSave = vi.fn((opFn) => {
      if (ok) tracked.state = opFn(tracked.state)
      return Promise.resolve(ok)
    })
    const { result } = renderHook(() => useEditHistory(applyAndSave))

    await act(async () => {
      await result.current.applyAndSaveUndoable(deleteFirst, 'Deleted Scene 1')
    })
    ok = false
    await act(async () => { await result.current.undo() })

    expect(result.current.canUndo).toBe(true)
    expect(result.current.canRedo).toBe(false)
  })

  it('redo re-applies the original edit', async () => {
    const tracked = { state: STATE }
    const { result } = renderHook(() => useEditHistory(trackingApplyAndSave(tracked)))

    await act(async () => {
      await result.current.applyAndSaveUndoable(deleteFirst, 'Deleted Scene 1')
    })
    await act(async () => { await result.current.undo() })
    await act(async () => { await result.current.redo() })

    expect(tracked.state.clips.map((c) => c.id)).toEqual(['s2'])
    expect(result.current.canRedo).toBe(false)
  })

  it('a fresh edit after an undo makes the undone edit unreachable', async () => {
    const tracked = { state: STATE }
    const { result } = renderHook(() => useEditHistory(trackingApplyAndSave(tracked)))

    await act(async () => {
      await result.current.applyAndSaveUndoable(deleteFirst, 'Deleted Scene 1')
    })
    await act(async () => { await result.current.undo() })
    await act(async () => {
      await result.current.applyAndSaveUndoable((s) => ({ ...s, captions: ['c'] }), 'Caption')
    })

    expect(result.current.canRedo).toBe(false)
  })

  it('undo and redo do nothing when their stacks are empty', async () => {
    const applyAndSave = vi.fn(() => Promise.resolve(true))
    const { result } = renderHook(() => useEditHistory(applyAndSave))

    await act(async () => { await result.current.undo() })
    await act(async () => { await result.current.redo() })

    expect(applyAndSave).not.toHaveBeenCalled()
  })
})
