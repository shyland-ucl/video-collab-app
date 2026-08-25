import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const authState = { isAdmin: undefined }
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => authState,
}))

import RequireAdmin from './RequireAdmin'

function renderGuard() {
  return render(
    <MemoryRouter>
      <RequireAdmin>
        <p>Researcher content</p>
      </RequireAdmin>
    </MemoryRouter>
  )
}

describe('RequireAdmin', () => {
  beforeEach(() => {
    authState.isAdmin = undefined
  })

  // undefined is "not answered yet", not "no" — showing the refusal first would
  // flash a scary message at the researcher on every load.
  it('waits while the admin check is in flight', () => {
    renderGuard()
    expect(screen.queryByText('Researcher content')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('refuses a participant and offers a way back', () => {
    authState.isAdmin = false
    renderGuard()
    expect(screen.queryByText('Researcher content')).not.toBeInTheDocument()
    expect(screen.getByText(/for the study researcher/)).toBeInTheDocument()
    expect(screen.getByRole('link')).toHaveAttribute('href', '/')
  })

  it('renders the view for the researcher', () => {
    authState.isAdmin = true
    renderGuard()
    expect(screen.getByText('Researcher content')).toBeInTheDocument()
  })
})
