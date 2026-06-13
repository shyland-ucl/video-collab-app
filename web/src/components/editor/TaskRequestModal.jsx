import { useState, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { announce } from '../../utils/announcer'
import { useRootInert } from '../../hooks/useRootInert'
import useSpeechRecognition from '../../hooks/useSpeechRecognition'

/**
 * Ported from probe src/components/probe3/TaskRequestModal.jsx (Task 9).
 * Adaptations: `route` ('ai' | 'helper') generalized to `mode`
 * ('ai' | 'helper' | 'vqa'); `segment` prop → `clip` (production clip shape:
 * startTime/endTime instead of start_time/end_time); `pendingAIResponse` /
 * `aiResponse` generalized to `pending` / `response` so the same modal shows
 * AI clarifications and VQA answers. Escape closes the modal (the explorer's
 * window-level handler is suspended while this modal is open).
 * Kept identical: speech recognition flow, focus management via useRootInert,
 * helper-route closes on send while ai/vqa stay open awaiting the response.
 */

const TITLES = {
  ai: 'Ask AI',
  helper: 'Ask Helper',
  vqa: 'Ask About This Scene',
}

const MIC_PROMPTS = {
  ai: 'Speak now. Ask the AI.',
  helper: 'Speak now. Ask the helper.',
  vqa: 'Speak now. Ask about this scene.',
}

const PLACEHOLDERS = {
  ai: 'Describe what you want done...',
  helper: 'Describe what you want done...',
  vqa: 'Ask a question about this scene...',
}

const INPUT_LABELS = {
  ai: 'Task description',
  helper: 'Task description',
  vqa: 'Your question',
}

const PENDING_TEXT = {
  ai: 'AI is working on this...',
  vqa: 'Getting the answer...',
}

const RESPONSE_HEADINGS = {
  ai: 'AI',
  vqa: 'Answer',
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function TaskRequestModal({ mode, clip, onSend, onClose, pending = false, response = null }) {
  const [text, setText] = useState('')
  const inputRef = useRef(null)
  const preFocusRef = useRef(typeof document !== 'undefined' ? document.activeElement : null)

  const isHelper = mode === 'helper'
  const title = TITLES[mode] ?? 'Ask'

  const getInputFocus = useCallback(() => inputRef.current, [])
  const getRestoreFocus = useCallback(() => preFocusRef.current, [])
  useRootInert(true, { initialFocus: getInputFocus, restoreFocus: getRestoreFocus, focusDelay: 100 })

  const handleResult = useCallback((transcript) => {
    setText(transcript)
    announce(`Heard: ${transcript}`)
  }, [])

  const { isListening: listening, isPreparing, toggleListening } = useSpeechRecognition({
    onResult: handleResult,
    announcement: MIC_PROMPTS[mode] ?? 'Speak now.',
  })

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed) return
    onSend(trimmed)
    if (isHelper) {
      // Helper route: close immediately (the page announces failures).
      onClose()
    }
    // AI / VQA routes: modal stays open, waiting for the response.
    setText('')
  }, [text, onSend, onClose, isHelper])

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => {
        if (e.target === e.currentTarget && !pending) onClose()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !pending) {
          e.preventDefault()
          onClose()
        }
      }}
    >
      <div className="w-full max-w-lg bg-white rounded-t-2xl shadow-2xl max-h-[70vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h3 className="font-bold text-sm text-gray-900">{title}</h3>
          <button
            onClick={onClose}
            disabled={pending}
            className="px-3 py-1.5 rounded text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 focus:outline-2 focus:outline-blue-500"
            style={{ minHeight: '48px', minWidth: '48px' }}
            aria-label="Close"
          >
            Done
          </button>
        </div>

        <div className="p-4 flex flex-col gap-3 overflow-y-auto">
          {/* Scene context */}
          {clip && (
            <p className="text-xs text-gray-500">
              Scene: <span className="font-semibold text-gray-700">{clip.name}</span>{' '}
              ({formatTime(clip.startTime)} &ndash; {formatTime(clip.endTime)})
            </p>
          )}

          {/* Text input + voice button */}
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSend()
              }}
              placeholder={PLACEHOLDERS[mode] ?? 'Describe what you want done...'}
              disabled={pending}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-2 focus:outline-[#9B59B6] disabled:opacity-50"
              style={{ minHeight: '48px' }}
              aria-label={INPUT_LABELS[mode] ?? 'Task description'}
            />
            <button
              onClick={toggleListening}
              disabled={pending}
              aria-busy={isPreparing || undefined}
              className={`px-3 py-2 rounded-lg text-sm font-bold focus:outline-none focus:ring-2 focus:ring-offset-1 ${
                listening
                  ? 'bg-red-500 text-white animate-pulse focus:ring-red-400'
                  : isPreparing
                    ? 'bg-amber-300 text-amber-900 focus:ring-amber-400'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200 focus:ring-gray-400'
              } disabled:opacity-40`}
              style={{ minHeight: '48px', minWidth: '48px' }}
              aria-label={
                isPreparing
                  ? 'Preparing microphone, please wait'
                  : listening
                    ? 'Listening, speak now or tap to stop'
                    : 'Voice input'
              }
            >
              {listening ? '...' : isPreparing ? 'Wait' : 'Mic'}
            </button>
          </div>

          {/* Send button */}
          <button
            onClick={handleSend}
            disabled={!text.trim() || pending}
            className="w-full py-3 rounded-lg text-sm font-bold text-white disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-offset-1"
            style={{
              minHeight: '48px',
              backgroundColor: mode === 'ai' ? '#9B59B6' : mode === 'vqa' ? '#2B579A' : '#E67E22',
              '--tw-ring-color': mode === 'ai' ? '#9B59B6' : mode === 'vqa' ? '#2B579A' : '#E67E22',
            }}
            aria-label={mode === 'vqa' ? 'Send question' : 'Send task'}
          >
            Send
          </button>

          {/* Pending state */}
          {pending && (
            <div className="flex items-center gap-2 p-3 bg-purple-50 rounded-lg" role="status" aria-live="polite">
              <span
                className="w-4 h-4 border-2 border-purple-400 border-t-transparent rounded-full animate-spin"
                aria-hidden="true"
              />
              <span className="text-sm text-purple-700 font-medium">
                {PENDING_TEXT[mode] ?? 'Working on it...'}
              </span>
            </div>
          )}

          {/* Response (AI clarification or VQA answer) */}
          {response && (
            <div className="p-3 bg-green-50 border border-green-200 rounded-lg" role="status" aria-live="polite">
              <p className="text-xs font-semibold text-green-700 uppercase tracking-wide mb-1">
                {RESPONSE_HEADINGS[mode] ?? 'Response'}
              </p>
              <p className="text-sm text-gray-800">{response}</p>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
