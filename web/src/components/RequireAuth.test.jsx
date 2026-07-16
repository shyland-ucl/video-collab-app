import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'

let mockSession
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ session: mockSession, user: mockSession?.user ?? null }),
}))

import RequireAuth from './RequireAuth'

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/signin" element={<div>sign in page</div>} />
        <Route path="/secret" element={<RequireAuth><div>secret content</div></RequireAuth>} />
      </Routes>
    </MemoryRouter>
  )
}

function SearchProbe() {
  return <div>search:{useLocation().search}</div>
}

describe('RequireAuth', () => {
  it('shows an accessible status while session is loading', () => {
    mockSession = undefined
    renderAt('/secret')
    expect(screen.queryByText('secret content')).not.toBeInTheDocument()
    expect(screen.queryByText('sign in page')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Checking your sign-in…')
  })

  it('redirects to /signin when signed out', () => {
    mockSession = null
    renderAt('/secret')
    expect(screen.getByText('sign in page')).toBeInTheDocument()
  })

  it('renders children when signed in', () => {
    mockSession = { user: { id: 'u1' } }
    renderAt('/secret')
    expect(screen.getByText('secret content')).toBeInTheDocument()
  })

  it('carries ?next= with encoded path+search when redirecting', () => {
    mockSession = null
    render(
      <MemoryRouter initialEntries={['/secret?tab=2']}>
        <Routes>
          <Route path="/signin" element={<SearchProbe />} />
          <Route path="/secret" element={<RequireAuth><div>secret content</div></RequireAuth>} />
        </Routes>
      </MemoryRouter>
    )
    expect(screen.getByText(/search:/)).toHaveTextContent('next=%2Fsecret%3Ftab%3D2')
  })
})
