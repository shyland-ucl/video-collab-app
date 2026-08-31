/**
 * Undo/redo history for the editor timeline.
 *
 * Pure and React-free: a history is `{ past, future }` where each entry is
 * `{ opFn, preImage }`. `preImage` is the timeline state the edit's opFn was
 * applied to, so undo is a state REPLACEMENT (`() => preImage`) rather than an
 * inverse operation — no op needs to know how to reverse itself.
 *
 * Every function returns a new history; none mutates its input (same contract
 * as sceneEditOps.js).
 *
 * History is per-browser and never persisted: each participant undoes their own
 * edits. Because undo/redo replace state wholesale they are saved
 * non-rebasable, so a concurrent edit on the other device surfaces as a
 * conflict and resyncs instead of being clobbered — see EditorPage.applyAndSave.
 */

// Each entry holds a full timeline snapshot. The EDL is small (clips, captions,
// overlays), so 50 is a generous ceiling that still bounds memory on a long
// session.
export const MAX_HISTORY = 50

export function emptyHistory() {
  return { past: [], future: [] }
}

export const canUndo = (history) => history.past.length > 0
export const canRedo = (history) => history.future.length > 0

// A new edit forks the timeline, so anything previously undone is unreachable.
export function pushEntry(history, entry) {
  return { past: [...history.past, entry].slice(-MAX_HISTORY), future: [] }
}

export function undoStep(history) {
  if (!canUndo(history)) return null
  const entry = history.past[history.past.length - 1]
  return {
    entry,
    history: { past: history.past.slice(0, -1), future: [...history.future, entry] },
  }
}

export function redoStep(history) {
  if (!canRedo(history)) return null
  const entry = history.future[history.future.length - 1]
  return {
    entry,
    history: { past: [...history.past, entry], future: history.future.slice(0, -1) },
  }
}

/**
 * Wrap a raw opFn so it records the state it is applied to.
 *
 * The caller's opFn closes over EditorPage's live state, so the only moment the
 * pre-image is knowable is when applyAndSave actually invokes it. LAST call
 * wins: saveWithRebase replays the op against freshly-loaded remote state after
 * a version conflict, and that replay is what got persisted.
 */
export function makeUndoableOp(rawOpFn) {
  const entry = { preImage: null, opFn: null }
  entry.opFn = (state) => {
    entry.preImage = state
    return rawOpFn(state)
  }
  return entry
}
