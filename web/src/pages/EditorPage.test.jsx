import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const {
  mockMemberMaybeSingle, mockVideosOrder, mockSegmentsOrder, mockSignedUrls,
  mockLoadLatestState, mockSaveState, mockSaveWithRebase, mockBuildInitialState,
  mockJoinProjectChannel, channelApi,
  mockListTasks, mockCreateTask, mockSetTaskStatus,
  mockSummarize, captured,
} = vi.hoisted(() => {
  const channelApi = {
    sendPlayhead: vi.fn(),
    sendTransport: vi.fn(),
    sendActivity: vi.fn(),
    leave: vi.fn(),
  }
  return {
    mockMemberMaybeSingle: vi.fn(),
    mockVideosOrder: vi.fn(),
    mockSegmentsOrder: vi.fn(),
    mockSignedUrls: vi.fn(),
    mockLoadLatestState: vi.fn(),
    mockSaveState: vi.fn(),
    mockSaveWithRebase: vi.fn(),
    mockBuildInitialState: vi.fn(),
    mockJoinProjectChannel: vi.fn(() => channelApi),
    channelApi,
    mockListTasks: vi.fn(),
    mockCreateTask: vi.fn(),
    mockSetTaskStatus: vi.fn(),
    mockSummarize: vi.fn(),
    captured: { creator: null, helper: null },
  }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    from: vi.fn((table) => {
      if (table === 'project_members') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockMemberMaybeSingle })) })),
          })),
        }
      }
      if (table === 'videos') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({ eq: vi.fn(() => ({ order: mockVideosOrder })) })),
          })),
        }
      }
      if (table === 'segments') {
        return {
          select: vi.fn(() => ({ in: vi.fn(() => ({ order: mockSegmentsOrder })) })),
        }
      }
      return {}
    }),
    storage: { from: vi.fn(() => ({ createSignedUrls: mockSignedUrls })) },
  },
}))

vi.mock('../lib/editor/stateStore', () => ({
  loadLatestState: mockLoadLatestState,
  saveState: mockSaveState,
  saveWithRebase: mockSaveWithRebase,
  buildInitialState: mockBuildInitialState,
  rootSegmentId: (id) => id,
}))

vi.mock('../lib/editor/projectChannel', () => ({
  joinProjectChannel: mockJoinProjectChannel,
}))

vi.mock('../lib/editor/tasksApi', () => ({
  listTasks: mockListTasks,
  createTask: mockCreateTask,
  setTaskStatus: mockSetTaskStatus,
}))

vi.mock('../lib/editor/projectOverview', () => ({
  summarizeEditStateChange: mockSummarize,
}))

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1' }, session: {} }),
}))

vi.mock('../utils/announcer', () => ({ announce: vi.fn() }))

vi.mock('../components/editor/CreatorDevice', () => ({
  default: (props) => {
    captured.creator = props
    return <div>creator device</div>
  },
}))

vi.mock('../components/editor/HelperDevice', () => ({
  default: (props) => {
    captured.helper = props
    return <div>helper device</div>
  },
}))

import EditorPage from './EditorPage'
import { announce } from '../utils/announcer'

const VIDEOS = [
  {
    id: 'v1', original_name: 'kitchen.mp4', status: 'ready',
    duration_seconds: 12, storage_path: 'p1/v1/original.mp4',
    created_at: '2026-06-01T00:00:00Z',
  },
]

const SEGMENTS = [
  {
    id: 's1', video_id: 'v1', idx: 1, start_seconds: 0, end_seconds: 6,
    descriptions: [
      { level: 1, text: 'Someone stirs a pot.' },
      { level: 2, text: 'A person in a blue apron stirs a pot.' },
      { level: 3, text: 'Static shot, overexposed.' },
    ],
  },
  {
    id: 's2', video_id: 'v1', idx: 2, start_seconds: 6, end_seconds: 12,
    descriptions: [{ level: 1, text: 'They taste the food.' }],
  },
]

const STATE_V1 = {
  clips: [
    { id: 's1', sourceId: 'v1', name: 'Scene 1', startTime: 0, endTime: 6, trimStart: 0, trimEnd: 0 },
    { id: 's2', sourceId: 'v1', name: 'Scene 2', startTime: 6, endTime: 12, trimStart: 0, trimEnd: 0 },
  ],
  captions: [],
  textOverlays: [],
  colour: {},
}

const STATE_V2 = { ...STATE_V1, clips: [STATE_V1.clips[1]] }

const SUMMARY = {
  actionText: 'deleted scene 1',
  shortText: 'Your collaborator deleted scene 1',
  overviewText: 'Current project overview: 1 clip, 6 sec total length.',
  promptText: 'Check the timeline to confirm the updated sequence.',
  announcement: 'Your collaborator deleted scene 1. Check the timeline to confirm the updated sequence.',
}

function renderPage(projectId = 'p1') {
  return render(
    <MemoryRouter initialEntries={[`/projects/${projectId}/edit`]}>
      <Routes>
        <Route path="/projects/:projectId/edit" element={<EditorPage />} />
      </Routes>
    </MemoryRouter>
  )
}

function channelOpts() {
  return mockJoinProjectChannel.mock.calls[0][1]
}

beforeEach(() => {
  vi.clearAllMocks()
  captured.creator = null
  captured.helper = null
  mockMemberMaybeSingle.mockResolvedValue({ data: { role: 'creator' }, error: null })
  mockVideosOrder.mockResolvedValue({ data: VIDEOS, error: null })
  mockSegmentsOrder.mockResolvedValue({ data: SEGMENTS, error: null })
  mockSignedUrls.mockResolvedValue({
    data: [{ path: 'p1/v1/original.mp4', signedUrl: 'https://signed/original', error: null }],
    error: null,
  })
  mockLoadLatestState.mockResolvedValue({ version: 1, state: STATE_V1 })
  mockListTasks.mockResolvedValue([])
  mockSummarize.mockReturnValue(SUMMARY)
})

describe('EditorPage', () => {
  it('renders the creator device for the project owner role', async () => {
    const { unmount } = renderPage()

    expect(await screen.findByText('creator device')).toBeInTheDocument()
    await waitFor(() => expect(mockJoinProjectChannel).toHaveBeenCalled())

    expect(captured.creator).toMatchObject({
      role: 'creator',
      projectId: 'p1',
      user: { id: 'u1' },
      state: STATE_V1,
      version: 1,
      sources: [{ id: 'v1', name: 'kitchen.mp4', src: 'https://signed/original', duration: 12 }],
      descriptions: {
        s1: {
          1: 'Someone stirs a pot.',
          2: 'A person in a blue apron stirs a pot.',
          3: 'Static shot, overexposed.',
        },
        s2: { 1: 'They taste the food.' },
      },
      tasks: [],
      remote: { playhead: null, transport: null, activity: null },
      syncDown: false,
    })
    expect(typeof captured.creator.applyAndSave).toBe('function')
    expect(typeof captured.creator.onCreateTask).toBe('function')
    expect(typeof captured.creator.onSetTaskStatus).toBe('function')
    expect(typeof captured.creator.channel.sendPlayhead).toBe('function')
    expect(typeof captured.creator.channel.sendTransport).toBe('function')
    expect(typeof captured.creator.channel.sendActivity).toBe('function')

    unmount()
    expect(channelApi.leave).toHaveBeenCalled()
  })

  it('renders the helper device for helpers', async () => {
    mockMemberMaybeSingle.mockResolvedValue({ data: { role: 'helper' }, error: null })

    renderPage()

    expect(await screen.findByText('helper device')).toBeInTheDocument()
    expect(captured.helper.role).toBe('helper')
  })

  it('builds and saves version 1 when no state exists', async () => {
    mockLoadLatestState.mockResolvedValue(null)
    mockBuildInitialState.mockReturnValue(STATE_V1)
    mockSaveState.mockResolvedValue({ ok: true, version: 1 })

    renderPage()

    expect(await screen.findByText('creator device')).toBeInTheDocument()
    expect(mockBuildInitialState).toHaveBeenCalledWith(VIDEOS, SEGMENTS)
    expect(mockSaveState).toHaveBeenCalledWith(expect.anything(), 'p1', 'u1', STATE_V1, 0)
    expect(captured.creator.version).toBe(1)
    expect(captured.creator.state).toEqual(STATE_V1)
  })

  it('applies a newer remote state and announces the change summary', async () => {
    renderPage()
    await screen.findByText('creator device')
    await waitFor(() => expect(mockJoinProjectChannel).toHaveBeenCalled())

    act(() => {
      channelOpts().onStateInsert({ version: 2, state: STATE_V2, updated_by: 'u2' })
    })

    expect(mockSummarize).toHaveBeenCalledWith(STATE_V1, STATE_V2, 'Your collaborator')
    expect(announce).toHaveBeenCalledWith(SUMMARY.announcement)
    expect(await screen.findByText(SUMMARY.shortText)).toBeInTheDocument()
    await waitFor(() => {
      expect(captured.creator.state).toEqual(STATE_V2)
      expect(captured.creator.version).toBe(2)
    })
  })

  it('ignores its own echo', async () => {
    renderPage()
    await screen.findByText('creator device')
    await waitFor(() => expect(mockJoinProjectChannel).toHaveBeenCalled())

    act(() => {
      // own write echoed back
      channelOpts().onStateInsert({ version: 2, state: STATE_V2, updated_by: 'u1' })
      // stale version from someone else
      channelOpts().onStateInsert({ version: 1, state: STATE_V2, updated_by: 'u2' })
    })

    expect(mockSummarize).not.toHaveBeenCalled()
    expect(announce).not.toHaveBeenCalled()
    expect(captured.creator.state).toEqual(STATE_V1)
    expect(captured.creator.version).toBe(1)
  })

  it('announces presence joins', async () => {
    renderPage()
    await screen.findByText('creator device')
    await waitFor(() => expect(mockJoinProjectChannel).toHaveBeenCalled())

    act(() => {
      channelOpts().onPresence({
        u1: [{ userId: 'u1', role: 'creator' }],
        u2: [{ userId: 'u2', role: 'helper' }],
      })
    })

    expect(announce).toHaveBeenCalledWith('Your helper joined the editor')
  })

  it('announces a double conflict assertively and resyncs to the latest state', async () => {
    renderPage()
    await screen.findByText('creator device')
    await waitFor(() => expect(mockJoinProjectChannel).toHaveBeenCalled())

    mockSaveWithRebase.mockResolvedValue({ ok: false, conflict: true })
    mockLoadLatestState.mockResolvedValue({ version: 3, state: STATE_V2 })

    await act(async () => {
      await captured.creator.applyAndSave((s) => s)
    })

    expect(announce).toHaveBeenCalledWith(
      "Your change conflicted with your helper's — the timeline was updated",
      { assertive: true }
    )
    expect(captured.creator.state).toEqual(STATE_V2)
    expect(captured.creator.version).toBe(3)
  })

  it('shows a visible alert banner and announces when live sync errors', async () => {
    renderPage()
    await screen.findByText('creator device')
    await waitFor(() => expect(mockJoinProjectChannel).toHaveBeenCalled())

    act(() => {
      channelOpts().onError({ status: 'CHANNEL_ERROR' })
    })

    expect(await screen.findByRole('alert')).toHaveTextContent(/live sync is unavailable/i)
    expect(announce).toHaveBeenCalledWith(
      expect.stringMatching(/live sync is unavailable/i),
      { assertive: true }
    )
    await waitFor(() => expect(captured.creator.syncDown).toBe(true))
  })

  it('shows an error with a back link for non-members', async () => {
    mockMemberMaybeSingle.mockResolvedValue({ data: null, error: null })

    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent(/not found, or you are not a member/i)
    expect(screen.getByRole('link', { name: 'Back to project' })).toBeInTheDocument()
    expect(mockJoinProjectChannel).not.toHaveBeenCalled()
  })

  it('shows the load error and announces it assertively when the state load throws', async () => {
    mockLoadLatestState.mockRejectedValue(new Error('state_load_failed: boom'))

    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the editor — try again")
    expect(announce).toHaveBeenCalledWith("Couldn't load the editor — try again", { assertive: true })
  })
})
