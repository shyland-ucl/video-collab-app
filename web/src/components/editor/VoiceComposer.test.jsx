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

describe('VoiceComposer', () => {
  it('typing + clicking submit calls onSubmit(trimmed text)', async () => {
    const onSubmit = vi.fn()
    render(<VoiceComposer onSubmit={onSubmit} submitLabel="Ask" inputAriaLabel="Your question" />)

    await userEvent.type(screen.getByRole('textbox', { name: /your question/i }), '  what is she doing?  ')
    await userEvent.click(screen.getByRole('button', { name: /^ask$/i }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('what is she doing?')
  })

  it('typing + Enter submits', async () => {
    const onSubmit = vi.fn()
    render(<VoiceComposer onSubmit={onSubmit} inputAriaLabel="Your question" />)

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
