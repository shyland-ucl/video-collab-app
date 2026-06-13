import { useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { announce } from '../../utils/announcer'
import ttsService from '../../services/ttsService'
import { useRootInert } from '../../hooks/useRootInert'
import { useAccessibility } from '../../contexts/AccessibilityContext'
import { applyOperation } from '../../lib/editor/sceneEditOps'

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

// Task 3's characterization proved applyOperation natively accepts every op in
// the AI contract ('delete', 'split', 'move_earlier', 'move_later',
// 'add_caption', 'trim_start', 'trim_end') with options { captionText,
// currentTime } — split falls back to the clip midpoint when currentTime is
// absent, and unknown ops are a safe no-op.
export function proposalToOpFn(proposal) {
  const { op, target_clip_id: id, params = {} } = proposal
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
  const { audioEnabled, speechRate } = useAccessibility()
  const confirmRef = useRef(null)
  const preFocusRef = useRef(typeof document !== 'undefined' ? document.activeElement : null)

  const described = describeProposal(proposal, clips)
  const question = described?.question ?? null

  const getInitialFocus = useCallback(() => confirmRef.current, [])
  const getRestoreFocus = useCallback(() => preFocusRef.current, [])
  useRootInert(Boolean(question), {
    initialFocus: getInitialFocus,
    restoreFocus: getRestoreFocus,
    focusDelay: 100,
  })

  // Speak + announce the DETERMINISTIC sentence the moment the dialog opens.
  useEffect(() => {
    if (!question) return
    announce(question, { assertive: true })
    if (audioEnabled) ttsService.speak(question, { rate: speechRate })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question])

  if (!described) return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-ai-edit-question"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
    >
      <div className="w-full max-w-lg bg-white rounded-t-2xl shadow-2xl">
        <div className="px-4 py-3 border-b border-gray-200">
          <h3 className="font-bold text-sm text-gray-900">Confirm AI edit</h3>
        </div>
        <div className="p-4 flex flex-col gap-3">
          <p id="confirm-ai-edit-question" className="text-lg font-semibold text-gray-900">
            {described.question}
          </p>
          {proposal.summary && <p className="text-sm text-gray-500">{proposal.summary}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              ref={confirmRef}
              onClick={onConfirm}
              className="flex-1 py-3 rounded-lg bg-[#2B579A] text-sm font-bold text-white hover:bg-[#1e3f6f] focus:outline-none focus:ring-2 focus:ring-[#2B579A] focus:ring-offset-1"
              style={{ minHeight: '48px' }}
              aria-label={`Confirm: ${described.question}`}
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 py-3 rounded-lg bg-gray-100 text-sm font-semibold text-gray-700 hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:ring-offset-1"
              style={{ minHeight: '48px' }}
              aria-label="Cancel — make no change"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
