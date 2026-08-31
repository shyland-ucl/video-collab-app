import { useCallback, useState } from 'react'
import {
  emptyHistory,
  pushEntry,
  undoStep,
  redoStep,
  canUndo as historyCanUndo,
  canRedo as historyCanRedo,
  makeUndoableOp,
} from '../lib/editor/editHistory.js'

// Cross-device summaries the OTHER participant hears (EditorPage announces
// these after the save lands). Deliberately terse — the acting participant's
// own confirmation is announced synchronously by the button handler.
export const UNDO_TEXT = 'Undo'
export const REDO_TEXT = 'Redo'

/**
 * Binds an undo/redo history to EditorPage's applyAndSave.
 *
 * Wraps applyAndSave rather than replacing it: callers opt in per edit, so
 * deliberate timeline operations become undoable while high-churn saves (text
 * overlay drags, which persist on every pointer move) keep using applyAndSave
 * directly and stay off the stack.
 *
 * The stack only ever moves on a SUCCESSFUL save. A conflicted edit never
 * reached the server, so recording it would let undo restore a state that was
 * never persisted.
 */
export function useEditHistory(applyAndSave) {
  const [history, setHistory] = useState(emptyHistory)

  const applyAndSaveUndoable = useCallback(
    async (rawOpFn, announceText, options = {}) => {
      const entry = makeUndoableOp(rawOpFn)
      const ok = await applyAndSave(entry.opFn, announceText, options)
      if (ok) setHistory((h) => pushEntry(h, entry))
      return ok
    },
    [applyAndSave]
  )

  // State-REPLACING opFn: ignores the state it is handed and restores the
  // pre-image, so it must not be rebased onto remote state. The `?? s` guard
  // keeps a never-invoked entry from blanking the timeline.
  const undo = useCallback(async () => {
    const step = undoStep(history)
    if (!step) return false
    const ok = await applyAndSave((s) => step.entry.preImage ?? s, UNDO_TEXT, { rebasable: false })
    if (ok) setHistory(step.history)
    return ok
  }, [history, applyAndSave])

  // Re-runs the original op, which re-captures its pre-image against whatever
  // the timeline looks like now — so a following undo restores the right state.
  const redo = useCallback(async () => {
    const step = redoStep(history)
    if (!step) return false
    const ok = await applyAndSave(step.entry.opFn, REDO_TEXT, { rebasable: false })
    if (ok) setHistory(step.history)
    return ok
  }, [history, applyAndSave])

  return {
    applyAndSaveUndoable,
    undo,
    redo,
    canUndo: historyCanUndo(history),
    canRedo: historyCanRedo(history),
  }
}
