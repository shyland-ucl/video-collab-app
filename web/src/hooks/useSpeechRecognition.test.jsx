// JSX wrapper is intentional: it exercises React's development lifecycle.
import { StrictMode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../utils/announcer.js', () => ({ announce: vi.fn() }))
vi.mock('../utils/earcon.js', () => ({ playEarcon: vi.fn() }))

import useSpeechRecognition from './useSpeechRecognition.js'

let recognition

class FakeSpeechRecognition {
  constructor() {
    recognition = this
  }

  start() {}
  stop() {}
  abort() {}
}

describe('useSpeechRecognition', () => {
  beforeEach(() => {
    recognition = null
    window.SpeechRecognition = FakeSpeechRecognition
  })

  it('stays mounted through the StrictMode setup-cleanup-setup cycle', () => {
    const onResult = vi.fn()
    const wrapper = ({ children }) => <StrictMode>{children}</StrictMode>
    const { result } = renderHook(
      () => useSpeechRecognition({ onResult }),
      { wrapper },
    )

    act(() => result.current.toggleListening())
    expect(result.current.isPreparing).toBe(true)

    act(() => recognition.onstart())
    expect(result.current.isPreparing).toBe(false)
    expect(result.current.isListening).toBe(true)

    act(() => recognition.onresult({ results: [[{ transcript: 'trim scene two' }]] }))
    expect(onResult).toHaveBeenCalledWith('trim scene two')
  })
})
