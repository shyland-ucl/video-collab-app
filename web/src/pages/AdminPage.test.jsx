import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { mockFetchAdminProjects } = vi.hoisted(() => ({ mockFetchAdminProjects: vi.fn() }))
vi.mock('../lib/supabaseClient', () => ({ supabase: {} }))
vi.mock('../lib/admin', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, fetchAdminProjects: mockFetchAdminProjects }
})

import AdminPage from './AdminPage'

function row(overrides = {}) {
  return {
    project_id: 'p1',
    title: 'Family holiday',
    status: 'active',
    created_at: '2026-08-20T10:00:00Z',
    owner_id: 'u1',
    owner_email: 'creator@x.test',
    members: [
      { user_id: 'u1', email: 'creator@x.test', role: 'creator' },
      { user_id: 'u2', email: 'helper@x.test', role: 'helper' },
    ],
    video_count: 2,
    videos_ready: 2,
    videos_processing: 0,
    videos_failed: 0,
    task_count: 3,
    suggestion_count: 4,
    render_count: 1,
    state_version: 7,
    event_count: 42,
    last_activity_at: '2026-08-25T09:00:00Z',
    ...overrides,
  }
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/admin']}>
      <Routes>
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/admin/projects/:id" element={<p>Inspector stub</p>} />
      </Routes>
    </MemoryRouter>
  )
}

describe('AdminPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('says plainly that the view is read-only', async () => {
    mockFetchAdminProjects.mockResolvedValue([])
    renderPage()
    expect(await screen.findByText(/read access only/)).toBeInTheDocument()
  })

  it('lists every project with its participants', async () => {
    mockFetchAdminProjects.mockResolvedValue([row()])
    renderPage()
    expect(await screen.findByRole('link', { name: 'Family holiday' })).toHaveAttribute(
      'href',
      '/admin/projects/p1'
    )
    expect(screen.getByText('Creator: creator@x.test')).toBeInTheDocument()
    expect(screen.getByText('Helper: helper@x.test')).toBeInTheDocument()
  })

  it('rolls up totals across the trial', async () => {
    mockFetchAdminProjects.mockResolvedValue([
      row(),
      row({ project_id: 'p2', title: 'Second', video_count: 1, render_count: 0, members: [] }),
    ])
    renderPage()
    await screen.findByRole('link', { name: 'Family holiday' })
    const total = (label) => screen.getByText(label).nextElementSibling.textContent
    expect(total('Projects')).toBe('2')
    // the two rows share the same pair, so they are 2 people and not 4
    expect(total('People')).toBe('2')
    expect(total('Videos')).toBe('3')
    expect(total('Exports')).toBe('1')
    expect(total('Need help')).toBe('0')
  })

  it('surfaces a project whose video failed', async () => {
    mockFetchAdminProjects.mockResolvedValue([row({ videos_failed: 1 })])
    renderPage()
    expect(await screen.findByText('Video failed')).toBeInTheDocument()
  })

  it('filters by participant email', async () => {
    mockFetchAdminProjects.mockResolvedValue([
      row(),
      row({
        project_id: 'p2',
        title: 'Other pair',
        owner_email: 'someone@y.test',
        members: [{ user_id: 'u3', email: 'someone@y.test', role: 'creator' }],
      }),
    ])
    renderPage()
    await screen.findByRole('link', { name: 'Family holiday' })
    await userEvent.type(screen.getByLabelText(/Filter by project name/), 'someone@')
    expect(screen.getByRole('link', { name: 'Other pair' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Family holiday' })).not.toBeInTheDocument()
  })

  it('shows the empty state when no project has been created', async () => {
    mockFetchAdminProjects.mockResolvedValue([])
    renderPage()
    expect(await screen.findByText(/No projects have been created yet/)).toBeInTheDocument()
  })

  it('shows the error when the RPC refuses', async () => {
    mockFetchAdminProjects.mockRejectedValue(new Error('not_admin'))
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('not_admin')
  })
})
