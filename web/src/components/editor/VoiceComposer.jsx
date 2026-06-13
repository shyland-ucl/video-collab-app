import { useState, useRef, useCallback } from 'react'
import useSpeechRecognition from '../../hooks/useSpeechRecognition'

/**
 * Voice-or-type composer for the editor's three "ask" surfaces (VQA,
 * Ask AI to Edit, Ask Helper to Edit). A faithful port of the probe's
 * shared/InlineVQAComposer.jsx adapted to this app's purple creator accent.
 *
 * The mic button (VoiceButton) is the primary BLV interaction: a tap toggles
 * the Web Speech recogniser via useSpeechRecognition. On a recognised result
 * the hook calls back with the transcript, which we submit immediately
 * (auto-submit-on-speech) — the same behaviour as the probe, where `onResult`
 * was wired straight to the submit function. The text input remains available
 * for sighted typing / Gboard mic dictation and submits on Enter or the
 * submit button.
 *
 * Accessibility parity with the probe:
 *   - mic aria-label changes across idle / preparing / listening states
 *   - aria-pressed reflects listening|preparing
 *   - listening => bg-red-500 animate-pulse, preparing => bg-amber-300
 *   - 44px minimum touch targets on every control
 *   - the hook plays the "speak now" earcon + assertive announce on start
 *
 * Props:
 *   onSubmit(text)  required — receives the trimmed question/instruction,
 *                   from voice OR typing. Downstream handlers are unchanged.
 *   disabled        true while a request is in flight; gates clicks, marks
 *                   controls aria-disabled (NOT the HTML disabled attribute,
 *                   so focus is never dropped to <body> mid-request).
 *   placeholder     text input placeholder.
 *   announcement    assertive "Speak now…" string spoken when the mic opens
 *                   (per-context, e.g. "Speak now. Ask your question.").
 *   submitLabel     visible + aria text for the submit button (e.g. "Ask").
 *   inputAriaLabel  aria-label for the text input.
 */

const ACCENT = '#9B59B6' // Probe 3 creator primary (purple)

export default function VoiceComposer({
  onSubmit,
  disabled = false,
  placeholder = 'Type your message...',
  announcement = 'Speak now.',
  submitLabel = 'Send',
  inputAriaLabel = 'Type your message',
}) {
  const [input, setInput] = useState('')
  const voiceButtonRef = useRef(null)

  const submit = useCallback(
    (text) => {
      if (!text || !text.trim() || disabled) return
      onSubmit(text.trim())
      setInput('')
    },
    [onSubmit, disabled]
  )

  // Auto-submit on speech: the recognised transcript goes straight to submit,
  // matching the probe (onResult wired directly to its submit function).
  const { isListening, isPreparing, toggleListening } = useSpeechRecognition({
    onResult: submit,
    announcement,
  })

  const handleVoiceClick = useCallback(() => {
    if (disabled) return
    toggleListening()
  }, [disabled, toggleListening])

  const handleSubmitClick = useCallback(() => {
    if (disabled) return
    submit(input)
  }, [disabled, input, submit])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit(input)
    }
  }

  // aria-disabled (not the HTML disabled attribute) on the buttons so an
  // in-flight request never blurs the focused control to <body>. Click
  // handlers gate on `disabled` so a tap during pending is a no-op.
  const submitDisabled = !input.trim() || disabled
  return (
    <div className="flex gap-2">
      <button
        type="button"
        ref={voiceButtonRef}
        onClick={handleVoiceClick}
        // Short, stable accessible name. State is conveyed concisely by
        // aria-pressed (the screen reader says "pressed"/"not pressed"); the
        // spoken "Speak now…" comes once from the live region on mic-open, so
        // the button must NOT also narrate a "listening, speak now…" sentence
        // (that double-spoke and echoed "speak now").
        aria-label={isListening || isPreparing ? 'Stop voice input' : 'Voice input'}
        aria-pressed={isListening || isPreparing}
        aria-disabled={disabled || undefined}
        className={`flex items-center justify-center rounded transition-colors focus:outline-2 focus:outline-offset-2 focus:outline-blue-500 ${
          isListening
            ? 'bg-red-500 text-white animate-pulse'
            : isPreparing
              ? 'bg-amber-300 text-amber-900'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
        } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
        style={{ minHeight: '44px', minWidth: '44px' }}
      >
        <svg width="20" height="20" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
          <rect x="7" y="1" width="4" height="10" rx="2" />
          <path d="M4 8a5 5 0 0 0 10 0" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <line x1="9" y1="14" x2="9" y2="17" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={`flex-1 px-3 py-2 border border-gray-300 rounded text-sm focus:outline-2 focus:outline-[#9B59B6] ${
          disabled ? 'opacity-60' : ''
        }`}
        style={{ minHeight: '44px' }}
        aria-label={inputAriaLabel}
        readOnly={disabled}
      />
      <button
        type="button"
        onClick={handleSubmitClick}
        aria-label={submitLabel}
        aria-disabled={submitDisabled || undefined}
        className={`px-4 py-2 rounded text-white text-sm font-bold transition-colors focus:outline-2 focus:outline-offset-2 focus:outline-blue-500 ${
          submitDisabled ? 'opacity-50 cursor-not-allowed' : ''
        }`}
        style={{ backgroundColor: ACCENT, minHeight: '44px' }}
      >
        {submitLabel}
      </button>
    </div>
  )
}
