import { useState, useRef, useCallback, useEffect } from 'react'
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
 *   - listening => bg-danger animate-pulse, preparing => bg-helper-soft
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
 *   submitOnVoice   true (default) → a recognised transcript auto-submits
 *                   immediately (probe InlineVQAComposer: VQA + Ask AI to Edit).
 *                   false → the transcript FILLS the text input and waits for an
 *                   explicit Enter / Send (probe TaskRouterPanel: the Ask-Helper
 *                   task composer, so a blind helper can compose a longer,
 *                   multi-sentence instruction before sending).
 *
 * Focus management (probe parity — InlineVQAComposer / TaskRouterPanel):
 *   - on mount the mic button is auto-focused (the composer mounts when its "ask"
 *     panel opens, so mount === panel-opened; landing on the mic saves a swipe);
 *   - when `disabled` flips true→false (the request resolved) and focus fell to
 *     <body>, the mic is refocused so the user stays anchored in the composer.
 */


export default function VoiceComposer({
  onSubmit,
  disabled = false,
  placeholder = 'Type your message...',
  announcement = 'Speak now.',
  submitLabel = 'Send',
  inputAriaLabel = 'Type your message',
  submitOnVoice = true,
}) {
  const [input, setInput] = useState('')
  const voiceButtonRef = useRef(null)

  // Auto-focus the mic button on mount. The composer renders only when its
  // parent "ask" panel opens, so mount === panel-opened; voice is the primary
  // BLV interaction, so landing on the mic skips one swipe (probe
  // InlineVQAComposer / TaskRouterPanel).
  useEffect(() => {
    const raf = requestAnimationFrame(() => voiceButtonRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [])

  // When `disabled` flips true→false (the request resolved) restore focus to the
  // mic if focus fell to <body> — TalkBack/Chromium drop focus to <body> when a
  // focused element is disabled, and even though we only signal disablement via
  // aria-disabled, a tap elsewhere mid-pending can still strand focus. Probe
  // InlineVQAComposer parity.
  const wasDisabledRef = useRef(disabled)
  useEffect(() => {
    if (wasDisabledRef.current && !disabled) {
      const raf = requestAnimationFrame(() => {
        if (document.activeElement === document.body || !document.activeElement) {
          voiceButtonRef.current?.focus()
        }
      })
      wasDisabledRef.current = false
      return () => cancelAnimationFrame(raf)
    }
    wasDisabledRef.current = disabled
    return undefined
  }, [disabled])

  const submit = useCallback(
    (text) => {
      if (!text || !text.trim() || disabled) return
      onSubmit(text.trim())
      setInput('')
    },
    [onSubmit, disabled]
  )

  // Speech result handler. submitOnVoice (default) auto-submits the transcript
  // straight away — the probe InlineVQAComposer behaviour (VQA + Ask AI to Edit).
  // When false, FILL the input instead and wait for an explicit Enter / Send —
  // the probe TaskRouterPanel behaviour (Ask-Helper task), so a blind helper can
  // compose a longer instruction before sending.
  const handleVoiceResult = useCallback(
    (transcript) => {
      if (submitOnVoice) {
        submit(transcript)
      } else {
        setInput(transcript)
      }
    },
    [submitOnVoice, submit]
  )

  const { isListening, isPreparing, toggleListening } = useSpeechRecognition({
    onResult: handleVoiceResult,
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
        className={`flex items-center justify-center rounded transition-colors ${
          isListening
            ? 'bg-danger text-on-accent animate-pulse'
            : isPreparing
              ? 'bg-helper-soft text-helper'
              : 'bg-sunken text-ink-soft hover:bg-line'
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
        className={`flex-1 px-3 py-2 border border-line-strong bg-surface text-ink rounded text-sm ${
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
        className={`px-4 py-2 rounded bg-creator text-on-accent text-sm font-bold transition-colors ${
          submitDisabled ? 'opacity-50 cursor-not-allowed' : ''
        }`}
        style={{ minHeight: '44px' }}
      >
        {submitLabel}
      </button>
    </div>
  )
}
