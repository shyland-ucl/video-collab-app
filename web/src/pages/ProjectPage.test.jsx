import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

// Hoisted mock factories — must declare before any vi.mock calls
const { mockProjectSingle, mockMembersEq, mockInviteSingle } = vi.hoisted(() => {
  const mockProjectSingle = vi.fn()
  const mockMembersEq = vi.fn()
  const mockInviteSingle = vi.fn()
  return { mockProjectSingle, mockMembersEq, mockInviteSingle }
})

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
      if (table === 'invites') {
        return {
          insert: vi.fn(() => ({
            select: vi.fn(() => ({ single: mockInviteSingle })),
          })),
        }
      }
      return {}
    }),
  },
}))

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1' } }),
}))

vi.mock('../utils/announcer', () => ({ announce: vi.fn() }))

import ProjectPage from './ProjectPage'
import { announce } from '../utils/announcer'
import { supabase } from '../lib/supabaseClient'

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

  it('invite success with no navigator.share copies link and announces', async () => {
    mockProjectSingle.mockResolvedValue({ data: PROJECT, error: null })
    mockMembersEq.mockResolvedValue({ data: MEMBERS, error: null })
    mockInviteSingle.mockResolvedValue({ data: { token: 'abc123' }, error: null })

    // Ensure navigator.share is undefined so the clipboard branch runs
    const originalShare = navigator.share
    delete navigator.share
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    })

    renderAt()
    await screen.findByText('My film')

    await userEvent.click(screen.getByRole('button', { name: 'Invite a helper' }))

    await waitFor(() =>
      expect(announce).toHaveBeenCalledWith('Invite link created and copied to clipboard')
    )

    // invite insert was called with correct args
    expect(supabase.from).toHaveBeenCalledWith('invites')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('/join/abc123')
    )

    // link text is visible on screen — the URL is in its own text node so use a function matcher
    expect(
      await screen.findByText((content) => content.includes('/join/abc123'))
    ).toBeInTheDocument()

    // restore
    if (originalShare !== undefined) {
      Object.defineProperty(navigator, 'share', { value: originalShare, configurable: true })
    }
  })

  it('invite insert error announces failure and shows friendly error text', async () => {
    mockProjectSingle.mockResolvedValue({ data: PROJECT, error: null })
    mockMembersEq.mockResolvedValue({ data: MEMBERS, error: null })
    mockInviteSingle.mockResolvedValue({ data: null, error: { message: 'permission denied' } })

    renderAt()
    await screen.findByText('My film')

    await userEvent.click(screen.getByRole('button', { name: 'Invite a helper' }))

    await waitFor(() => expect(announce).toHaveBeenCalledWith('Could not create invite'))
    expect(
      screen.getByText('Could not create an invite link. Only the project owner can invite.')
    ).toBeInTheDocument()
  })
})
