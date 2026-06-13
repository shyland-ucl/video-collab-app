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

// Keep the real rootSegmentId and SCENE_COLORS — the page's merge logic
// depends on real split-id stripping and the real colour palette.
vi.mock('../lib/editor/stateStore', async (importOriginal) => ({
  ...(await importOriginal()),
  loadLatestState: mockLoadLatestState,
  saveState: mockSaveState,
  saveWithRebase: mockSaveWithRebase,
  buildInitialState: mockBuildInitialState,
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
import { AccessibilityProvider } from '../contexts/AccessibilityContext'
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

const STATE_V3 = { ...STATE_V1, clips: [{ ...STATE_V1.clips[0], name: 'Scene renamed' }] }

// Fixtures for the ready-segment merge tests (Fix 2).
const G_SEGMENTS = [
  { id: 'g1', video_id: 'v1', idx: 1, start_seconds: 0, end_seconds: 6, descriptions: [] },
  { id: 'g2', video_id: 'v1', idx: 2, start_seconds: 6, end_seconds: 12, descriptions: [] },
]

const G_STATE = {
  clips: [
    {
      id: 'g1', sourceId: 'v1', name: 'Scene 1', startTime: 0, endTime: 6,
      trimStart: 0, trimEnd: 0, color: '#E74C3C', muted: false,
    },
  ],
  captions: [],
  textOverlays: [],
  colour: {},
}

const SUMMARY = {
  actionText: 'deleted scene 1',
  shortText: 'Your collaborator deleted scene 1',
  overviewText: 'Current project overview: 1 clip, 6 sec total length.',
  promptText: 'Check the timeline to confirm the updated sequence.',
  announcement: 'Your collaborator deleted scene 1. Check the timeline to confirm the updated sequence.',
}

function renderPage(projectId = 'p1', search = '') {
  return render(
    <AccessibilityProvider>
      <MemoryRouter initialEntries={[`/projects/${projectId}/edit${search}`]}>
        <Routes>
          <Route path="/projects/:projectId/edit" element={<EditorPage />} />
        </Routes>
      </MemoryRouter>
    </AccessibilityProvider>
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

  it('passes the ?video= query param down to the creator device as initialVideoId', async () => {
    renderPage('p1', '?video=v2')

    expect(await screen.findByText('creator device')).toBeInTheDocument()
    await waitFor(() => expect(captured.creator.initialVideoId).toBe('v2'))
  })

  it('passes initialVideoId=null when no ?video= is present', async () => {
    renderPage()

    expect(await screen.findByText('creator device')).toBeInTheDocument()
    await waitFor(() => expect(captured.creator.initialVideoId).toBeNull())
  })

  it('renders the editor main as a full-height flex column so the device scrolls, not the page', async () => {
    renderPage()
    await screen.findByText('creator device')

    // The pinned-video/scroll behaviour depends on the editor <main> being a
    // height-constrained flex column (the device fills it; ITS inner regions
    // scroll). Guard the layout so it can't silently regress to `p-4` only.
    const main = document.getElementById('main')
    expect(main).toBeTruthy()
    expect(main.className).toContain('flex')
    expect(main.className).toContain('flex-col')
    expect(main.className).toContain('overflow-hidden')
    expect(main.className).toMatch(/fixed|h-screen|h-full/)
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

  it('end-to-end: a REMOTE colour insert announces on the creator using the REAL summarizer (colour branch + announce gate)', async () => {
    // Every other test stubs summarizeEditStateChange via mockSummarize, so the
    // real colour branch and the page's `if (summary.announcement)` gate are
    // never exercised together. Here we delegate the mock to the REAL impl so
    // the full path runs: colour diff → summarizeVisualAdjustment wording →
    // announce(). vi.importActual bypasses the module mock for the real fn.
    const actual = await vi.importActual('../lib/editor/projectOverview')
    mockSummarize.mockImplementation(actual.summarizeEditStateChange)

    renderPage()
    await screen.findByText('creator device')
    await waitFor(() => expect(mockJoinProjectChannel).toHaveBeenCalled())

    // Colour-only diff: prev colour {} → next colour { s1: { brightness: 30 } },
    // clips otherwise identical. updated_by is the OTHER user so it is not an
    // own-echo. (s1 is the rootSegmentId of clip s1.)
    const COLOUR_STATE = { ...STATE_V1, colour: { s1: { brightness: 30 } } }
    act(() => {
      channelOpts().onStateInsert({ version: 2, state: COLOUR_STATE, updated_by: 'u2' })
    })

    // The real summarizer announced the colour change with the helper/probe
    // wording (matching summarizeVisualAdjustment): brightness + the review prompt.
    const expected = actual.summarizeVisualAdjustment('brightness', 30, 'Your collaborator')
    expect(announce).toHaveBeenCalledWith(expected.announcement)
    expect(announce).toHaveBeenCalledWith(
      expect.stringMatching(/brightness/i)
    )
    expect(announce).toHaveBeenCalledWith(
      expect.stringMatching(/review the video frame to confirm the visual change/i)
    )
    await waitFor(() => expect(captured.creator.state).toEqual(COLOUR_STATE))
  })

  it('end-to-end: a colour insert echoed from the current user is NOT announced (own-echo)', async () => {
    const actual = await vi.importActual('../lib/editor/projectOverview')
    mockSummarize.mockImplementation(actual.summarizeEditStateChange)

    renderPage()
    await screen.findByText('creator device')
    await waitFor(() => expect(mockJoinProjectChannel).toHaveBeenCalled())

    const COLOUR_STATE = { ...STATE_V1, colour: { s1: { brightness: 30 } } }
    act(() => {
      // updated_by === current user (u1) — the creator must not announce its own
      // colour grade; only the helper's remote change is announced.
      channelOpts().onStateInsert({ version: 2, state: COLOUR_STATE, updated_by: 'u1' })
    })

    expect(mockSummarize).not.toHaveBeenCalled()
    expect(announce).not.toHaveBeenCalled()
    expect(captured.creator.state).toEqual(STATE_V1)
    expect(captured.creator.version).toBe(1)
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

  it('announces a helper task-status UPDATE to the creator naming the task text AND segment (Fix C)', async () => {
    renderPage()
    await screen.findByText('creator device')
    await waitFor(() => expect(mockJoinProjectChannel).toHaveBeenCalled())

    act(() => {
      channelOpts().onTaskChange({
        eventType: 'UPDATE',
        task: { id: 't1', text: 'trim the intro', segment_label: 'Scene 3', status: 'done' },
      })
    })

    // The announce names the task (text + segment), not the old terse
    // "Your helper marked a task done".
    expect(announce).toHaveBeenCalledWith(
      'Your helper finished the task for Scene 3. Task: trim the intro'
    )
    expect(announce).not.toHaveBeenCalledWith(expect.stringMatching(/marked a task/i))
  })

  it('maps needs_discussion / cant_do to the probe wording on a task UPDATE (Fix C)', async () => {
    renderPage()
    await screen.findByText('creator device')
    await waitFor(() => expect(mockJoinProjectChannel).toHaveBeenCalled())

    act(() => {
      channelOpts().onTaskChange({
        eventType: 'UPDATE',
        task: { id: 't2', text: 'brighten this shot', segment_label: 'Scene 1', status: 'needs_discussion' },
      })
    })
    expect(announce).toHaveBeenCalledWith(
      'Your helper needs discussion the task for Scene 1. Task: brighten this shot'
    )

    act(() => {
      channelOpts().onTaskChange({
        eventType: 'UPDATE',
        task: { id: 't3', text: 'add music', segment_label: 'Scene 2', status: 'cant_do' },
      })
    })
    expect(announce).toHaveBeenCalledWith(
      'Your helper cannot complete the task for Scene 2. Task: add music'
    )
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

  it('persists a clean non-rebasable save via saveState (not saveWithRebase) and announces', async () => {
    renderPage()
    await screen.findByText('creator device')
    await waitFor(() => expect(mockJoinProjectChannel).toHaveBeenCalled())

    mockSaveState.mockResolvedValue({ ok: true, version: 2 })

    await act(async () => {
      await captured.creator.applyAndSave(() => STATE_V2, 'Undo', { rebasable: false })
    })

    expect(mockSaveWithRebase).not.toHaveBeenCalled()
    expect(mockSaveState).toHaveBeenCalledWith(expect.anything(), 'p1', 'u1', STATE_V2, 1)
    expect(announce).toHaveBeenCalledWith('Undo')
    expect(captured.creator.state).toEqual(STATE_V2)
    expect(captured.creator.version).toBe(2)
  })

  it('does NOT rebase a non-rebasable save on conflict — resyncs to latest instead of clobbering with the stale snapshot', async () => {
    renderPage()
    await screen.findByText('creator device')
    await waitFor(() => expect(mockJoinProjectChannel).toHaveBeenCalled())

    // Non-rebasable saves go straight through saveState (NOT saveWithRebase).
    // The first save conflicts; the page must resync to the remote winner and
    // must never reapply the state-replacing opFn onto remote state.
    mockSaveState.mockResolvedValue({ ok: false, conflict: true })
    mockLoadLatestState.mockResolvedValue({ version: 3, state: STATE_V2 })

    // A state-REPLACING opFn that ignores its input (undo/redo shape). If the
    // page reapplied it on remote state, STATE_V3 (the stale snapshot) would win.
    const staleSnapshot = STATE_V3
    await act(async () => {
      await captured.creator.applyAndSave(() => staleSnapshot, 'Undo', { rebasable: false })
    })

    // saveWithRebase was bypassed entirely; only the first saveState ran.
    expect(mockSaveWithRebase).not.toHaveBeenCalled()
    expect(mockSaveState).toHaveBeenCalledTimes(1)
    expect(mockSaveState).toHaveBeenCalledWith(expect.anything(), 'p1', 'u1', staleSnapshot, 1)

    // Conflict announced assertively, latest refetched + applied, undo dropped.
    expect(announce).toHaveBeenCalledWith(
      "Your change conflicted with your helper's — the timeline was updated",
      { assertive: true }
    )
    expect(announce).not.toHaveBeenCalledWith('Undo')
    expect(captured.creator.state).toEqual(STATE_V2)
    expect(captured.creator.version).toBe(3)
    // The stale snapshot did NOT become the saved/visible state.
    expect(captured.creator.state).not.toEqual(staleSnapshot)
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

  it('does not regress to an older version when a newer remote insert lands mid-save', async () => {
    renderPage()
    await screen.findByText('creator device')
    await waitFor(() => expect(mockJoinProjectChannel).toHaveBeenCalled())

    let resolveSave
    mockSaveWithRebase.mockReturnValue(new Promise((resolve) => { resolveSave = resolve }))

    let savePromise
    act(() => {
      savePromise = captured.creator.applyAndSave(() => STATE_V2)
    })

    // While the save is in flight, a newer remote version arrives.
    act(() => {
      channelOpts().onStateInsert({ version: 3, state: STATE_V3, updated_by: 'u2' })
    })
    await waitFor(() => expect(captured.creator.version).toBe(3))

    // The save resolves with an OLDER version — it must not be applied.
    await act(async () => {
      resolveSave({ ok: true, version: 2, state: STATE_V2 })
      await savePromise
    })

    expect(captured.creator.version).toBe(3)
    expect(captured.creator.state).toEqual(STATE_V3)
  })

  it('does not revert a failed save over a newer remote state that landed mid-save', async () => {
    renderPage()
    await screen.findByText('creator device')
    await waitFor(() => expect(mockJoinProjectChannel).toHaveBeenCalled())

    let resolveSave
    mockSaveWithRebase.mockReturnValue(new Promise((resolve) => { resolveSave = resolve }))

    let savePromise
    act(() => {
      savePromise = captured.creator.applyAndSave(() => STATE_V2)
    })
    act(() => {
      channelOpts().onStateInsert({ version: 3, state: STATE_V3, updated_by: 'u2' })
    })

    await act(async () => {
      resolveSave({ ok: false })
      await savePromise
    })

    expect(announce).toHaveBeenCalledWith("That change didn't save — try again", { assertive: true })
    expect(captured.creator.version).toBe(3)
    expect(captured.creator.state).toEqual(STATE_V3)
  })

  it('reverts the optimistic state when a save fails and nothing newer arrived', async () => {
    renderPage()
    await screen.findByText('creator device')
    await waitFor(() => expect(mockJoinProjectChannel).toHaveBeenCalled())

    mockSaveWithRebase.mockResolvedValue({ ok: false })

    await act(async () => {
      await captured.creator.applyAndSave(() => STATE_V2)
    })

    expect(announce).toHaveBeenCalledWith("That change didn't save — try again", { assertive: true })
    expect(captured.creator.version).toBe(1)
    expect(captured.creator.state).toEqual(STATE_V1)
  })

  it('does not save an empty v1 when there are no segments and shows the no-scenes message', async () => {
    mockVideosOrder.mockResolvedValue({ data: [], error: null })
    mockLoadLatestState.mockResolvedValue(null)

    renderPage()

    expect(await screen.findByText('creator device')).toBeInTheDocument()
    expect(mockSaveState).not.toHaveBeenCalled()
    expect(mockBuildInitialState).not.toHaveBeenCalled()
    const status = screen.getByText(/no scenes yet — upload a video and wait for it to finish processing/i)
    expect(status).toHaveAttribute('role', 'status')
    expect(captured.creator.state.clips).toEqual([])
  })

  it('appends newly ready segments missing from an existing state and saves one new version', async () => {
    mockSegmentsOrder.mockResolvedValue({ data: G_SEGMENTS, error: null })
    mockLoadLatestState.mockResolvedValue({ version: 1, state: G_STATE })
    mockSaveState.mockResolvedValue({ ok: true, version: 2 })

    renderPage()

    expect(await screen.findByText('creator device')).toBeInTheDocument()
    expect(mockSaveState).toHaveBeenCalledTimes(1)
    expect(mockSaveState).toHaveBeenCalledWith(expect.anything(), 'p1', 'u1', expect.anything(), 1)
    const savedState = mockSaveState.mock.calls[0][3]
    expect(savedState.clips.map((c) => c.id)).toEqual(['g1', 'g2'])
    expect(savedState.clips[1]).toEqual({
      id: 'g2', sourceId: 'v1', name: 'Scene 2', startTime: 6, endTime: 12,
      trimStart: 0, trimEnd: 0, color: '#3498DB', muted: false,
    })
    await waitFor(() => expect(captured.creator.version).toBe(2))
    expect(captured.creator.state.clips).toHaveLength(2)
  })

  it('does not re-append a segment whose id is in deletedSegmentIds (tombstone skip on load)', async () => {
    // State has g1 already deleted (tombstoned); the DB still lists g1 in segments.
    // mergeNewSegments must skip g1 because it is in deletedSegmentIds — no saveState call.
    const tombstonedState = {
      ...G_STATE,
      clips: [],               // g1 was deleted — no clips remain
      deletedSegmentIds: ['g1'],
    }
    mockSegmentsOrder.mockResolvedValue({ data: [G_SEGMENTS[0]], error: null })
    mockLoadLatestState.mockResolvedValue({ version: 2, state: tombstonedState })

    renderPage()

    expect(await screen.findByText('creator device')).toBeInTheDocument()
    // mergeNewSegments found no missing segments (g1 is tombstoned) — no save.
    expect(mockSaveState).not.toHaveBeenCalled()
    // The tombstoned segment must not appear in the displayed clips.
    expect(captured.creator.state.clips.map((c) => c.id)).not.toContain('g1')
  })

  it('treats split-derived clips as covering their root segment (no duplicate append)', async () => {
    mockSegmentsOrder.mockResolvedValue({ data: [G_SEGMENTS[0]], error: null })
    mockLoadLatestState.mockResolvedValue({
      version: 2,
      state: { ...G_STATE, clips: [{ ...G_STATE.clips[0], id: 'g1-split-123-a' }] },
    })

    renderPage()

    expect(await screen.findByText('creator device')).toBeInTheDocument()
    expect(mockSaveState).not.toHaveBeenCalled()
    expect(captured.creator.state.clips.map((c) => c.id)).toEqual(['g1-split-123-a'])
  })

  it('keeps the previous signed URL when a refresh fails', async () => {
    // Capture the page's long intervals (URL refresh, ready poll) without
    // faking ALL timers — RTL's waitFor relies on real ones.
    const realSetInterval = globalThis.setInterval
    const longIntervals = []
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation((cb, ms, ...args) => {
      if (ms >= 60000) {
        longIntervals.push({ cb, ms })
        return 0
      }
      return realSetInterval(cb, ms, ...args)
    })
    try {
      renderPage()
      expect(await screen.findByText('creator device')).toBeInTheDocument()
      expect(captured.creator.sources[0].src).toBe('https://signed/original')

      const refresh = longIntervals.find((i) => i.ms === 50 * 60 * 1000) // URL_REFRESH_MS
      expect(refresh).toBeTruthy()

      mockSignedUrls.mockResolvedValue({ data: null, error: { message: 'boom' } })
      await act(async () => {
        await refresh.cb()
      })

      expect(mockSignedUrls).toHaveBeenCalledTimes(2)
      expect(captured.creator.sources[0].src).toBe('https://signed/original')
    } finally {
      spy.mockRestore()
    }
  })

  it('shows the load error and announces it assertively when the state load throws', async () => {
    mockLoadLatestState.mockRejectedValue(new Error('state_load_failed: boom'))

    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the editor — try again")
    expect(announce).toHaveBeenCalledWith("Couldn't load the editor — try again", { assertive: true })
  })
})
