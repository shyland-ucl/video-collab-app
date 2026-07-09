import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

// Mock the announcer so jsdom never touches the live region; we assert the
// boundary speaks the failure (a silent white screen is unrecoverable for a
// blind creator).
const { mockAnnounce } = vi.hoisted(() => ({ mockAnnounce: vi.fn() }))
vi.mock('../utils/announcer', () => ({ announce: mockAnnounce }))

import ErrorBoundary from './ErrorBoundary'

function Boom() {
  throw new Error('kaboom')
}

beforeEach(() => vi.clearAllMocks())

describe('ErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>all good</p>
      </ErrorBoundary>
    )
    expect(screen.getByText('all good')).toBeInTheDocument()
    expect(mockAnnounce).not.toHaveBeenCalled()
  })

  it('shows an assertive alert fallback and announces when a child throws', () => {
    // React logs the caught error to console.error — silence it for a clean run.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      )
      expect(screen.getByRole('alert')).toHaveTextContent(/something went wrong/i)
      expect(mockAnnounce).toHaveBeenCalledWith(
        expect.stringMatching(/something went wrong/i),
        { assertive: true }
      )
    } finally {
      spy.mockRestore()
    }
  })
})
