import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Mock the speech hook so jsdom never touches the Web Speech API. We capture
// the options the component passes (onResult / announcement) and expose a
// controllable toggleListening spy + listening/preparing state so a test can
// drive the mic states and simulate a recognised result.
const hookState = vi.hoisted(() => ({
  isListening: false,
  isPreparing: false,
  toggleListening: vi.fn(),
  lastOptions: null,
}))

vi.mock('../../hooks/useSpeechRecognition', () => ({
  default: (options) => {
    hookState.lastOptions = options
    return {
      isListening: hookState.isListening,
      isPreparing: hookState.isPreparing,
      toggleListening: hookState.toggleListening,
    }
  },
}))

// The hook (mocked away) is what would touch announcer + earcon; mock them too
// so nothing reaches the live region or AudioContext if the real hook leaks in.
vi.mock('../../utils/announcer', () => ({ announce: vi.fn() }))
vi.mock('../../utils/earcon', () => ({ playEarcon: vi.fn() }))

import VoiceComposer from './VoiceComposer'

beforeEach(() => {
  vi.clearAllMocks()
  hookState.isListening = false
  hookState.isPreparing = false
  hookState.lastOptions = null
})

// The composer auto-focuses the mic button on mount via requestAnimationFrame
// (VoiceComposer.jsx). Drain that rAF so it can't fire mid-interaction and steal
// focus from the input — otherwise a subsequent {Enter} lands on the mic button
// instead of the input's onKeyDown and the submit never fires (flaky under load).
function flushRaf() {
  // act() flushes the React effect; the inner rAF promise drains the callback
  // jsdom schedules on a macrotask.
  return act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve()))
  })
}

describe('VoiceComposer', () => {
  it('typing + clicking submit calls onSubmit(trimmed text)', async () => {
    const onSubmit = vi.fn()
    render(<VoiceComposer onSubmit={onSubmit} submitLabel="Ask" inputAriaLabel="Your question" />)
    await flushRaf() // let the mount mic-autofocus settle so it can't steal focus mid-type

    await userEvent.type(screen.getByRole('textbox', { name: /your question/i }), '  what is she doing?  ')
    await userEvent.click(screen.getByRole('button', { name: /^ask$/i }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('what is she doing?')
  })

  it('typing + Enter submits', async () => {
    const onSubmit = vi.fn()
    render(<VoiceComposer onSubmit={onSubmit} inputAriaLabel="Your question" />)
    await flushRaf() // let the mount mic-autofocus settle so it can't steal focus mid-type

    await userEvent.type(screen.getByRole('textbox', { name: /your question/i }), 'hello{Enter}')

    expect(onSubmit).toHaveBeenCalledWith('hello')
  })

  it('clicking the mic calls the speech hook toggle', async () => {
    render(<VoiceComposer onSubmit={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /voice input/i }))
    expect(hookState.toggleListening).toHaveBeenCalledTimes(1)
  })

  it('a recognised speech result auto-submits via the hook onResult callback', async () => {
    const onSubmit = vi.fn()
    render(<VoiceComposer onSubmit={onSubmit} announcement="Speak now. Ask your question." />)

    // The composer wires onResult straight through to submit; simulate the hook
    // delivering a transcript.
    expect(hookState.lastOptions.announcement).toBe('Speak now. Ask your question.')
    act(() => {
      hookState.lastOptions.onResult('a person stirs a pot')
    })

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('a person stirs a pot')
  })

  it('mic has a short stable label + aria-pressed in the idle state', () => {
    render(<VoiceComposer onSubmit={vi.fn()} />)
    // Label is concise and does NOT narrate a "speak now" sentence (which
    // double-spoke with the live region). State is carried by aria-pressed.
    const mic = screen.getByRole('button', { name: /^voice input$/i })
    expect(mic).toHaveAttribute('aria-pressed', 'false')
    expect(mic).not.toHaveAttribute('aria-busy')
  })

  it('mic flips to a short "stop" label + aria-pressed when listening', () => {
    hookState.isListening = true
    render(<VoiceComposer onSubmit={vi.fn()} />)
    const mic = screen.getByRole('button', { name: /^stop voice input$/i })
    expect(mic).toHaveAttribute('aria-pressed', 'true')
    expect(mic.className).toMatch(/animate-pulse/)
  })

  it('mic shows the preparing state without an aria-busy chatter trigger', () => {
    hookState.isPreparing = true
    render(<VoiceComposer onSubmit={vi.fn()} />)
    const mic = screen.getByRole('button', { name: /^stop voice input$/i })
    expect(mic).toHaveAttribute('aria-pressed', 'true')
    // aria-busy removed — it caused extra screen-reader announcements.
    expect(mic).not.toHaveAttribute('aria-busy')
  })

  it('disabled gates submit + does not call onSubmit', async () => {
    const onSubmit = vi.fn()
    render(<VoiceComposer onSubmit={onSubmit} disabled inputAriaLabel="Your question" />)
    // readOnly while disabled; clicking submit is a no-op.
    await userEvent.click(screen.getByRole('button', { name: /send/i }))
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('VoiceComposer — focus management (probe parity)', () => {
  // The mic auto-focuses on mount (mount === ask-panel-opened) and refocuses
  // when a request resolves if focus fell to <body> — mirroring the probe's
  // InlineVQAComposer / TaskRouterPanel so a BLV user is not stranded.
  // (flushRaf is defined at module scope above.)

  it('auto-focuses the mic button on mount', async () => {
    render(<VoiceComposer onSubmit={vi.fn()} />)
    await flushRaf()
    const mic = screen.getByRole('button', { name: /^voice input$/i })
    expect(document.activeElement).toBe(mic)
  })

  it('refocuses the mic when disabled goes true→false and focus is on <body>', async () => {
    const { rerender } = render(<VoiceComposer onSubmit={vi.fn()} disabled />)
    await flushRaf()
    // Simulate the focus having fallen to <body> mid-request.
    document.body.focus()
    if (document.activeElement !== document.body) {
      // jsdom: blur the active element so activeElement falls back to body.
      document.activeElement?.blur?.()
    }
    expect(document.activeElement === document.body || !document.activeElement).toBe(true)

    // Request resolves: disabled true→false.
    rerender(<VoiceComposer onSubmit={vi.fn()} disabled={false} />)
    await flushRaf()

    const mic = screen.getByRole('button', { name: /^voice input$/i })
    expect(document.activeElement).toBe(mic)
  })
})

describe('VoiceComposer — submitOnVoice (per-surface voice behaviour)', () => {
  it('with submitOnVoice default (true), a speech result auto-submits', () => {
    const onSubmit = vi.fn()
    render(<VoiceComposer onSubmit={onSubmit} inputAriaLabel="Your question" />)
    act(() => {
      hookState.lastOptions.onResult('brighten the kitchen shot')
    })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('brighten the kitchen shot')
  })

  it('with submitOnVoice={false}, a speech result FILLS the input and does NOT submit', () => {
    const onSubmit = vi.fn()
    render(<VoiceComposer onSubmit={onSubmit} submitOnVoice={false} inputAriaLabel="Task description" />)
    act(() => {
      hookState.lastOptions.onResult('trim the noisy intro and add a caption')
    })
    // Filled, not submitted.
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: /task description/i })).toHaveValue(
      'trim the noisy intro and add a caption'
    )
  })

  it('with submitOnVoice={false}, an explicit submit then calls onSubmit with the filled text', async () => {
    const onSubmit = vi.fn()
    render(<VoiceComposer onSubmit={onSubmit} submitOnVoice={false} submitLabel="Send to helper" inputAriaLabel="Task description" />)
    act(() => {
      hookState.lastOptions.onResult('trim the noisy intro')
    })
    expect(onSubmit).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: /send to helper/i }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('trim the noisy intro')
  })
})
