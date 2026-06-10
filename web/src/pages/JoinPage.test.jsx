import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'

const { mockRpc } = vi.hoisted(() => ({ mockRpc: vi.fn() }))
vi.mock('../lib/supabaseClient', () => ({ supabase: { rpc: mockRpc } }))

let mockSession
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ session: mockSession, user: mockSession?.user ?? null }),
}))
vi.mock('../utils/announcer', () => ({ announce: vi.fn() }))

import JoinPage from './JoinPage'
import { announce } from '../utils/announcer'

function LocationProbe({ label }) {
  const loc = useLocation()
  return <div>{label}:{loc.pathname}{loc.search}</div>
}

function renderAt(token) {
  return render(
    <MemoryRouter initialEntries={[`/join/${token}`]}>
      <Routes>
        <Route path="/join/:token" element={<JoinPage />} />
        <Route path="/signin" element={<LocationProbe label="signin" />} />
        <Route path="/projects/:id" element={<LocationProbe label="project" />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('JoinPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('redirects signed-out users to /signin preserving the join path', () => {
    mockSession = null
    renderAt('tok-1')
    expect(screen.getByText(/signin:/)).toHaveTextContent('next=%2Fjoin%2Ftok-1')
  })

  it('redeems and navigates to the project on success', async () => {
    mockSession = { user: { id: 'u2' } }
    mockRpc.mockResolvedValue({ data: 'proj-9', error: null })
    renderAt('tok-1')
    await waitFor(() => expect(screen.getByText(/project:/)).toHaveTextContent('/projects/proj-9'))
    expect(mockRpc).toHaveBeenCalledWith('redeem_invite', { invite_token: 'tok-1' })
    expect(announce).toHaveBeenCalledWith('Joined project')
  })

  it('maps known DB errors to friendly messages', async () => {
    mockSession = { user: { id: 'u2' } }
    mockRpc.mockResolvedValue({ data: null, error: { message: 'P0001: expired_invite' } })
    renderAt('tok-1')
    expect(await screen.findByText('This invite link has expired. Ask for a new one.')).toBeInTheDocument()
    expect(announce).toHaveBeenCalledWith('Could not join the project')
  })

  it('falls back to a generic message for unknown errors', async () => {
    mockSession = { user: { id: 'u2' } }
    mockRpc.mockResolvedValue({ data: null, error: { message: 'network exploded' } })
    renderAt('tok-1')
    expect(await screen.findByText('Could not join the project. Please try again.')).toBeInTheDocument()
  })
})
