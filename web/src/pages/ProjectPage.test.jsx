import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { mockProjectSingle, mockMembersEq, mockReadyVideosLimit, mockRpc } = vi.hoisted(() => ({
  mockProjectSingle: vi.fn(),
  mockMembersEq: vi.fn(),
  mockReadyVideosLimit: vi.fn(),
  mockRpc: vi.fn(),
}))

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    from: vi.fn((table) => {
      if (table === 'projects') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({ single: mockProjectSingle })),
          })),
        }
      }
      if (table === 'project_members') {
        return {
          select: vi.fn(() => ({
            eq: mockMembersEq,
          })),
        }
      }
      if (table === 'videos') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({ limit: mockReadyVideosLimit })),
            })),
          })),
        }
      }
      return {}
    }),
    rpc: mockRpc,
  },
}))

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1' } }),
}))

vi.mock('../utils/announcer', () => ({ announce: vi.fn() }))

vi.mock('../components/VideosSection', () => ({
  default: () => <section>videos section stub</section>,
}))

import ProjectPage from './ProjectPage'
import { announce } from '../utils/announcer'

function renderAt(projectId = 'p1') {
  return render(
    <MemoryRouter initialEntries={[`/projects/${projectId}`]}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectPage />} />
      </Routes>
    </MemoryRouter>
  )
}

const PROJECT = { id: 'p1', title: 'My film', owner_id: 'u1' }
const MEMBERS = [
  { user_id: 'u1', role: 'creator' },
  { user_id: 'u2', role: 'helper' },
]

describe('ProjectPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReadyVideosLimit.mockResolvedValue({ data: [], error: null })
  })

  it('renders project title and members with "(you)" marker after load', async () => {
    mockProjectSingle.mockResolvedValue({ data: PROJECT, error: null })
    mockMembersEq.mockResolvedValue({ data: MEMBERS, error: null })

    renderAt()

    expect(await screen.findByText('My film')).toBeInTheDocument()
    expect(screen.getByText('People (2)')).toBeInTheDocument()
    expect(screen.getByText('Creator (you)')).toBeInTheDocument()
    expect(screen.getByText('Helper')).toBeInTheDocument()
  })

  it('shows not-found error and back link when project load errors', async () => {
    mockProjectSingle.mockResolvedValue({ data: null, error: { message: 'not found' } })

    renderAt()

    expect(
      await screen.findByText('Project not found, or you are not a member of it.')
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to projects' })).toBeInTheDocument()
  })

  it('shows the Open editor link when the project has a ready video', async () => {
    mockProjectSingle.mockResolvedValue({ data: PROJECT, error: null })
    mockMembersEq.mockResolvedValue({ data: MEMBERS, error: null })
    mockReadyVideosLimit.mockResolvedValue({ data: [{ id: 'v1' }], error: null })

    renderAt()

    const link = await screen.findByRole('link', { name: 'Open editor' })
    expect(link).toHaveAttribute('href', '/projects/p1/edit')
  })

  it('hides the Open editor link when no video is ready', async () => {
    mockProjectSingle.mockResolvedValue({ data: PROJECT, error: null })
    mockMembersEq.mockResolvedValue({ data: MEMBERS, error: null })

    renderAt()
    await screen.findByText('My film')

    await waitFor(() => expect(mockReadyVideosLimit).toHaveBeenCalled())
    expect(screen.queryByRole('link', { name: 'Open editor' })).not.toBeInTheDocument()
  })

  it('shows the 4-digit code with expiry note and announces it', async () => {
    mockProjectSingle.mockResolvedValue({ data: PROJECT, error: null })
    mockMembersEq.mockResolvedValue({ data: MEMBERS, error: null })
    mockRpc.mockResolvedValue({
      data: { code: '4827', expires_at: '2026-06-12T12:00:00Z' },
      error: null,
    })

    renderAt()
    await screen.findByText('My film')

    await userEvent.click(screen.getByRole('button', { name: 'Invite a helper' }))

    expect(await screen.findByText('4827')).toBeInTheDocument()
    expect(screen.getByText('Expires in 15 minutes.')).toBeInTheDocument()
    expect(
      screen.getByText('Ask your helper to enter this code on their home page.')
    ).toBeInTheDocument()
    expect(mockRpc).toHaveBeenCalledWith('create_invite', { p_project_id: 'p1' })
    await waitFor(() =>
      expect(announce).toHaveBeenCalledWith('Invite code created: 4 8 2 7')
    )
  })

  it('a second press replaces the code with a fresh one', async () => {
    mockProjectSingle.mockResolvedValue({ data: PROJECT, error: null })
    mockMembersEq.mockResolvedValue({ data: MEMBERS, error: null })
    mockRpc
      .mockResolvedValueOnce({
        data: { code: '4827', expires_at: '2026-06-12T12:00:00Z' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { code: '9151', expires_at: '2026-06-12T12:20:00Z' },
        error: null,
      })

    renderAt()
    await screen.findByText('My film')

    await userEvent.click(screen.getByRole('button', { name: 'Invite a helper' }))
    await screen.findByText('4827')
    await userEvent.click(screen.getByRole('button', { name: 'Invite a helper' }))

    expect(await screen.findByText('9151')).toBeInTheDocument()
    expect(screen.queryByText('4827')).not.toBeInTheDocument()
  })

  it('rpc error announces failure and shows friendly error text', async () => {
    mockProjectSingle.mockResolvedValue({ data: PROJECT, error: null })
    mockMembersEq.mockResolvedValue({ data: MEMBERS, error: null })
    mockRpc.mockResolvedValue({ data: null, error: { message: 'not_owner' } })

    renderAt()
    await screen.findByText('My film')

    await userEvent.click(screen.getByRole('button', { name: 'Invite a helper' }))

    await waitFor(() => expect(announce).toHaveBeenCalledWith('Could not create invite code'))
    expect(
      screen.getByText('Could not create a code. Only the project owner can invite.')
    ).toBeInTheDocument()
  })

  it('treats a success response with no code as a failure', async () => {
    mockProjectSingle.mockResolvedValue({ data: PROJECT, error: null })
    mockMembersEq.mockResolvedValue({ data: MEMBERS, error: null })
    mockRpc.mockResolvedValue({ data: null, error: null })

    renderAt()
    await screen.findByText('My film')

    await userEvent.click(screen.getByRole('button', { name: 'Invite a helper' }))

    await waitFor(() => expect(announce).toHaveBeenCalledWith('Could not create invite code'))
    expect(
      screen.getByText('Could not create a code. Only the project owner can invite.')
    ).toBeInTheDocument()
  })

  it('clears a previously shown code when a later attempt fails', async () => {
    mockProjectSingle.mockResolvedValue({ data: PROJECT, error: null })
    mockMembersEq.mockResolvedValue({ data: MEMBERS, error: null })
    mockRpc
      .mockResolvedValueOnce({
        data: { code: '4827', expires_at: '2026-06-12T12:00:00Z' },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: { message: 'not_owner' } })

    renderAt()
    await screen.findByText('My film')

    await userEvent.click(screen.getByRole('button', { name: 'Invite a helper' }))
    await screen.findByText('4827')
    await userEvent.click(screen.getByRole('button', { name: 'Invite a helper' }))

    await waitFor(() =>
      expect(
        screen.getByText('Could not create a code. Only the project owner can invite.')
      ).toBeInTheDocument()
    )
    expect(screen.queryByText('4827')).not.toBeInTheDocument()
  })
})
