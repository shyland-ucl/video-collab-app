import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

// The list is built from two queries: own memberships, then the projects those
// ids (or ownership) resolve to. The mock is table-aware so each assertion can
// target the query it cares about.
const { mockOrder, mockOr, mockMemberships, mockSingle, mockInsert, mockRpc } = vi.hoisted(() => {
  const mockOrder = vi.fn()
  const mockOr = vi.fn(() => ({ order: mockOrder }))
  const mockMemberships = vi.fn()
  const mockSingle = vi.fn()
  const mockInsert = vi.fn(() => ({ select: vi.fn(() => ({ single: mockSingle })) }))
  const mockRpc = vi.fn()
  return { mockOrder, mockOr, mockMemberships, mockSingle, mockInsert, mockRpc }
})
vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    from: vi.fn((table) =>
      table === 'project_members'
        ? { select: vi.fn(() => ({ eq: mockMemberships })) }
        : { select: vi.fn(() => ({ or: mockOr })), insert: mockInsert }
    ),
    rpc: mockRpc,
  },
}))
const authState = { user: { id: 'u1' }, isAdmin: false }
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ ...authState, signOut: vi.fn() }),
}))
vi.mock('../utils/announcer', () => ({ announce: vi.fn() }))

import ProjectsPage from './ProjectsPage'
import { announce } from '../utils/announcer'

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<ProjectsPage />} />
        <Route path="/projects/:id" element={<p>Project page stub</p>} />
      </Routes>
    </MemoryRouter>
  )
}

describe('ProjectsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authState.isAdmin = false
    mockMemberships.mockResolvedValue({ data: [], error: null })
  })

  it('shows the empty state when there are no projects', async () => {
    mockOrder.mockResolvedValue({ data: [], error: null })
    renderPage()
    expect(await screen.findByText(/No projects yet/)).toBeInTheDocument()
  })

  it('shows a Settings link in the header', async () => {
    mockOrder.mockResolvedValue({ data: [], error: null })
    renderPage()
    await screen.findByText(/No projects yet/)
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings')
  })

  it('lists projects as links to their pages', async () => {
    mockOrder.mockResolvedValue({
      data: [{ id: 'p1', title: 'My film', status: 'active', created_at: '2026-01-01', owner_id: 'u1' }],
      error: null,
    })
    renderPage()
    const link = await screen.findByRole('link', { name: 'My film' })
    expect(link).toHaveAttribute('href', '/projects/p1')
  })

  it('creates a project and announces it', async () => {
    mockOrder.mockResolvedValue({ data: [], error: null })
    mockSingle.mockResolvedValue({ data: { id: 'p2', title: 'New film' }, error: null })
    renderPage()
    await screen.findByText(/No projects yet/)
    await userEvent.type(screen.getByLabelText('New project name'), 'New film')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(announce).toHaveBeenCalledWith('Project New film created'))
    expect(mockInsert).toHaveBeenCalledWith({ title: 'New film', owner_id: 'u1' })
  })

  // Regression guard for the admin role (migration 0015): the researcher can
  // SELECT every project, so "Your projects" must filter by own membership
  // rather than leaning on RLS to do it.
  it('scopes the list to projects the user owns or belongs to', async () => {
    mockMemberships.mockResolvedValue({
      data: [{ project_id: 'p1' }, { project_id: 'p2' }],
      error: null,
    })
    mockOrder.mockResolvedValue({ data: [], error: null })
    renderPage()
    await screen.findByText(/No projects yet/)
    expect(mockOr).toHaveBeenCalledWith('owner_id.eq.u1,id.in.(p1,p2)')
  })

  it('still filters by ownership when the user belongs to no project', async () => {
    mockMemberships.mockResolvedValue({ data: [], error: null })
    mockOrder.mockResolvedValue({ data: [], error: null })
    renderPage()
    await screen.findByText(/No projects yet/)
    expect(mockOr).toHaveBeenCalledWith('owner_id.eq.u1')
  })

  it('hides the trial dashboard link from participants', async () => {
    mockOrder.mockResolvedValue({ data: [], error: null })
    renderPage()
    await screen.findByText(/No projects yet/)
    expect(screen.queryByRole('link', { name: 'Trial dashboard' })).not.toBeInTheDocument()
  })

  it('offers the trial dashboard link to the researcher admin', async () => {
    authState.isAdmin = true
    mockOrder.mockResolvedValue({ data: [], error: null })
    renderPage()
    await screen.findByText(/No projects yet/)
    expect(screen.getByRole('link', { name: 'Trial dashboard' })).toHaveAttribute('href', '/admin')
  })

  it('announces failure when create errors', async () => {
    mockOrder.mockResolvedValue({ data: [], error: null })
    mockSingle.mockResolvedValue({ data: null, error: { message: 'nope' } })
    renderPage()
    await screen.findByText(/No projects yet/)
    await userEvent.type(screen.getByLabelText('New project name'), 'Bad film')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(announce).toHaveBeenCalledWith('Could not create project'))
    expect(screen.getByText('nope')).toBeInTheDocument()
  })
})

describe('ProjectsPage — join with a code', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authState.isAdmin = false
    mockMemberships.mockResolvedValue({ data: [], error: null })
    mockOrder.mockResolvedValue({ data: [], error: null })
  })

  async function typeCodeAndJoin(code) {
    await screen.findByText(/No projects yet/)
    await userEvent.type(screen.getByLabelText('Join with a code'), code)
    await userEvent.click(screen.getByRole('button', { name: 'Join' }))
  }

  it('redeems the code and navigates to the project', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true, project_id: 'p9' }, error: null })
    renderPage()
    await typeCodeAndJoin('4827')
    expect(mockRpc).toHaveBeenCalledWith('redeem_code', { p_code: '4827' })
    expect(await screen.findByText('Project page stub')).toBeInTheDocument()
    expect(announce).toHaveBeenCalledWith('Joined project')
  })

  it.each([
    ['invalid_code', "That code didn't work. Check the digits and try again."],
    ['expired_code', 'This code has expired. Ask for a new one.'],
    ['too_many_attempts', 'Too many tries. Please wait 15 minutes.'],
  ])('shows the right message for %s', async (reason, message) => {
    mockRpc.mockResolvedValue({ data: { ok: false, reason }, error: null })
    renderPage()
    await typeCodeAndJoin('0000')
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(announce).toHaveBeenCalledWith(message, { assertive: true })
  })

  it('shows a generic message on transport error', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'network' } })
    renderPage()
    await typeCodeAndJoin('1234')
    expect(
      await screen.findByText('Could not join the project. Please try again.')
    ).toBeInTheDocument()
    expect(announce).toHaveBeenCalledWith(
      'Could not join the project. Please try again.',
      { assertive: true }
    )
  })

  it('rejects an incomplete code without calling the backend', async () => {
    renderPage()
    await screen.findByText(/No projects yet/)
    await userEvent.type(screen.getByLabelText('Join with a code'), '12')
    fireEvent.submit(screen.getByLabelText('Join with a code').closest('form'))
    expect(mockRpc).not.toHaveBeenCalled()
    expect(await screen.findByText('Enter all 4 digits of the code.')).toBeInTheDocument()
  })

  it('disables the Join button while redemption is in flight', async () => {
    mockRpc.mockReturnValue(new Promise(() => {})) // never resolves
    renderPage()
    await typeCodeAndJoin('4827')
    expect(screen.getByRole('button', { name: 'Joining…' })).toBeDisabled()
  })
})
