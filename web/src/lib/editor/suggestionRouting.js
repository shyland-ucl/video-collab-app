import { applyOperation } from './sceneEditOps'
import { rootSegmentId } from './stateStore'

// Phase 3b — pure helpers for routing a suggestion onto the editor's existing
// apply path. No React, no IO; unit-tested in isolation.

// Resolve the clip a suggestion attaches to. We key off the stable segment_id
// (persisted server-side), matching the clip whose rootSegmentId equals it — so
// a split's halves still resolve to the original scene. Returns null when the
// scene was deleted (stale suggestion → the card is not rendered).
export function suggestionClip(suggestion, clips) {
  if (!suggestion?.segment_id) return null
  return (clips ?? []).find((c) => rootSegmentId(c.id) === suggestion.segment_id) ?? null
}

// Map a helper task's status onto a suggestion outcome (the helper task is the
// completion signal for a helper-routed suggestion). 'needs_discussion' is not a
// terminal outcome — it stays pending until the helper marks done / can't do.
const TASK_OUTCOME = { done: 'applied', cant_do: 'failed', needs_discussion: 'pending', pending: 'pending' }
export function taskStatusToOutcome(status) {
  return TASK_OUTCOME[status] ?? 'pending'
}

const COLOUR_ACTIONS = ['brightness', 'contrast', 'saturation', 'zoom', 'rotate']

// A pure opFn (state -> state) that applies a fix_template to a clip, reusing the
// SAME state shapes the editor already persists (colour map keyed by
// rootSegmentId; toggle_mute via applyOperation). Returns identity for an
// unknown action so a bad template can never corrupt state.
export function fixTemplateToOpFn(fixTemplate, clipId) {
  if (!fixTemplate || !clipId) return (s) => s
  const { action, value } = fixTemplate
  if (action === 'mute' || action === 'unmute') {
    // applyOperation maps 'mute'/'unmute' to setClipMuted(true/false) — a
    // deterministic, idempotent set (propagates to split halves).
    return (s) => applyOperation(s, clipId, action)
  }
  if (COLOUR_ACTIONS.includes(action)) {
    const root = rootSegmentId(clipId)
    return (s) => ({
      ...s,
      colour: { ...(s?.colour ?? {}), [root]: { ...((s?.colour ?? {})[root] ?? {}), [action]: value } },
    })
  }
  return (s) => s
}

// Deterministic confirm/done sentences for a fix_template (BLV-safe: the dialog
// speaks these, never the model's free text). Returns null for an unknown action.
export function describeFixTemplate(fixTemplate, clipName) {
  if (!fixTemplate?.action) return null
  const name = clipName || 'this scene'
  const { action, value } = fixTemplate
  switch (action) {
    case 'brightness':
    case 'contrast':
    case 'saturation': {
      const verb = value >= 0 ? 'Increase' : 'Reduce'
      const past = value >= 0 ? 'Increased' : 'Reduced'
      return { question: `${verb} the ${action} on ${name}?`, done: `${past} the ${action} on ${name}.` }
    }
    case 'zoom':
      return { question: `Zoom ${name} to ${value}%?`, done: `Zoomed ${name} to ${value}%.` }
    case 'rotate':
      return { question: `Rotate ${name} by ${value} degrees?`, done: `Rotated ${name} by ${value} degrees.` }
    case 'mute':
      return { question: `Mute the original audio on ${name}?`, done: `Muted the original audio on ${name}.` }
    case 'unmute':
      return { question: `Unmute the original audio on ${name}?`, done: `Unmuted the original audio on ${name}.` }
    default:
      return null
  }
}
