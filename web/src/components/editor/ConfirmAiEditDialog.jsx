import { applyOperation } from '../../lib/editor/sceneEditOps'
import ConfirmEditDialog from './ConfirmEditDialog'
import { fixTemplateToOpFn, describeFixTemplate } from '../../lib/editor/suggestionRouting'

/**
 * Confirm-first dialog for AI-proposed edits (phase 1c, Task 9).
 *
 * HARD REQUIREMENT (1c-6 review): the sentence this dialog speaks and renders
 * as its primary content is composed DETERMINISTICALLY client-side from the
 * validated op + the clip's name looked up from target_clip_id. Gemini's
 * free-text `summary` is supplementary colour only — it can never be the sole
 * description of the operation, because for a blind user a summary/op
 * mismatch is unrecoverable.
 */

const VISUAL_OPS = ['brightness', 'contrast', 'saturation', 'zoom', 'rotate', 'mute', 'unmute']

// mute/unmute carry no server value; fixTemplateToOpFn/describeFixTemplate ignore
// the value for them, but build the canonical bool for clarity.
function visualFixTemplate(op, params = {}) {
  const value = op === 'mute' ? true : op === 'unmute' ? false : params.value
  return { action: op, value }
}

// Task 3's characterization proved applyOperation natively accepts every op in
// the AI contract ('delete', 'split', 'move_earlier', 'move_later',
// 'add_caption', 'trim_start', 'trim_end') with options { captionText,
// currentTime } — split falls back to the clip midpoint when currentTime is
// absent, and unknown ops are a safe no-op.
export function proposalToOpFn(proposal) {
  const { op, target_clip_id: id, params = {} } = proposal
  if (VISUAL_OPS.includes(op)) {
    return fixTemplateToOpFn(visualFixTemplate(op, params), id)
  }
  return (state) => applyOperation(state, id, op, { captionText: params.caption_text })
}

// Deterministic question/announcement sentences per allowed op. Returns
// { question, done } or null when the proposal can't be described (unknown
// op, or the target clip is no longer in the timeline) — callers must not
// open the dialog in that case.
export function describeProposal(proposal, clips) {
  if (!proposal?.op || !proposal.target_clip_id) return null
  const clip = (clips || []).find((c) => c.id === proposal.target_clip_id)
  if (!clip) return null
  const name = clip.name
  if (VISUAL_OPS.includes(proposal.op)) {
    return describeFixTemplate(visualFixTemplate(proposal.op, proposal.params), name)
  }
  const caption = proposal.params?.caption_text ?? ''
  switch (proposal.op) {
    case 'delete':
      return { question: `Delete ${name}?`, done: `Deleted ${name}.` }
    case 'split':
      return {
        question: `Split ${name} into two at its midpoint?`,
        done: `Split ${name} into two at its midpoint.`,
      }
    case 'move_earlier':
      return {
        question: `Move ${name} earlier in the timeline?`,
        done: `Moved ${name} earlier in the timeline.`,
      }
    case 'move_later':
      return {
        question: `Move ${name} later in the timeline?`,
        done: `Moved ${name} later in the timeline.`,
      }
    case 'add_caption':
      return {
        question: `Add the caption '${caption}' to ${name}?`,
        done: `Added the caption '${caption}' to ${name}.`,
      }
    case 'trim_start':
      return {
        question: `Trim half a second off the start of ${name}?`,
        done: `Trimmed half a second off the start of ${name}.`,
      }
    case 'trim_end':
      return {
        question: `Trim half a second off the end of ${name}?`,
        done: `Trimmed half a second off the end of ${name}.`,
      }
    default:
      return null
  }
}

export default function ConfirmAiEditDialog({ proposal, clips, onConfirm, onCancel }) {
  // Compose the deterministic sentence from the op + clip name, then defer to
  // the shared presentational dialog. Returns null when the proposal can't be
  // described (caller must not have opened the dialog).
  const described = describeProposal(proposal, clips)
  if (!described) return null
  return (
    <ConfirmEditDialog
      question={described.question}
      summary={proposal.summary}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}
