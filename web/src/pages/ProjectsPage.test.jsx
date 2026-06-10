import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

const mockOrder = vi.fn()
const mockSingle = vi.fn()
vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({ order: mockOrder })),
      insert: vi.fn(() => ({ select: vi.fn(() => ({ single: mockSingle })) })),
    })),
  },
}))
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1' }, signOut: vi.fn() }),
}))
vi.mock('../utils/announcer', () => ({ announce: vi.fn() }))

import ProjectsPage from './ProjectsPage'
import { announce } from '../utils/announcer'

function renderPage() {
  return render(
    <MemoryRouter>
      <ProjectsPage />
    </MemoryRouter>
  )
}

describe('ProjectsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the empty state when there are no projects', async () => {
    mockOrder.mockResolvedValue({ data: [], error: null })
    renderPage()
    expect(await screen.findByText(/No projects yet/)).toBeInTheDocument()
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
