import { useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { announce } from '../../utils/announcer'
import ttsService from '../../services/ttsService'
import { useRootInert } from '../../hooks/useRootInert'
import { useAccessibility } from '../../contexts/AccessibilityContext'

/**
 * Presentational confirm-first dialog. Speaks + announces a DETERMINISTIC
 * sentence on open, traps focus (useRootInert), and offers Confirm / Cancel.
 *
 * Extracted from ConfirmAiEditDialog (Phase 3b) so BOTH confirm-first AI paths
 * share one a11y-correct dialog:
 *   - the Ask-AI-to-Edit proposal path (ConfirmAiEditDialog computes the
 *     sentence from the op via describeProposal, then renders this);
 *   - the Phase 3b "Ask AI to fix it" suggestion path (CreatorDevice computes
 *     the sentence from a fix_template via describeFixTemplate, or from a
 *     re-run /ai-edit proposal, then renders this).
 *
 * The HARD REQUIREMENT is unchanged: `question` is composed deterministically
 * by the caller (never the model's free text), because for a blind user a
 * summary/op mismatch is unrecoverable. `summary` is optional supplementary
 * colour shown visually only.
 *
 * Props: { question, summary?, onConfirm, onCancel }.
 */
export default function ConfirmEditDialog({
  question,
  summary,
  title = 'Confirm AI edit',
  confirmLabel = 'Confirm',
  destructive = false,
  onConfirm,
  onCancel,
}) {
  const { audioEnabled, speechRate } = useAccessibility()
  const confirmRef = useRef(null)
  const preFocusRef = useRef(typeof document !== 'undefined' ? document.activeElement : null)

  const getInitialFocus = useCallback(() => confirmRef.current, [])
  const getRestoreFocus = useCallback(() => preFocusRef.current, [])
  useRootInert(Boolean(question), {
    initialFocus: getInitialFocus,
    restoreFocus: getRestoreFocus,
    focusDelay: 100,
  })

  useEffect(() => {
    if (!question) return
    announce(question, { assertive: true })
    if (audioEnabled) ttsService.speak(question, { rate: speechRate })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question])

  if (!question) return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center overscroll-contain bg-black/40"
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
      <div className="w-full max-w-lg rounded-t-2xl bg-surface shadow-pop" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="px-4 py-3 border-b border-line">
          <h3 className="font-bold text-sm text-ink">{title}</h3>
        </div>
        <div className="p-4 flex flex-col gap-3">
          <p id="confirm-ai-edit-question" className="text-lg font-semibold text-ink">
            {question}
          </p>
          {summary && <p className="text-sm text-ink-soft">{summary}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              ref={confirmRef}
              onClick={onConfirm}
              className={`flex-1 rounded-lg py-3 text-sm font-bold ${
                destructive
                  ? 'bg-danger text-on-accent hover:opacity-90'
                  : 'bg-brand text-on-brand hover:bg-brand-strong'
              }`}
              style={{ minHeight: '48px' }}
              aria-label={`${confirmLabel}: ${question}`}
            >
              {confirmLabel}
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 py-3 rounded-lg bg-sunken text-sm font-semibold text-ink-soft hover:bg-line"
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
