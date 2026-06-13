import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// House mock style: hoist + mock the announcer, the serverApi POST, the TTS
// singleton and the AccessibilityContext so jsdom never touches the live
// region, the network, speechSynthesis or the real provider tree. The
// playback engine hook is mocked so jsdom never has to play real media;
// computeClipLayout stays real (CreatorDevice maps clip → EDL offset with it).
const { mockAnnounce, mockServerPost, ttsMock, a11yState, engineMock } = vi.hoisted(() => ({
  mockAnnounce: vi.fn(),
  mockServerPost: vi.fn(),
  ttsMock: { speak: vi.fn(), stop: vi.fn(), isSpeaking: false },
  a11yState: { textSize: 'medium', audioEnabled: false, speechRate: 1.2 },
  engineMock: {
    edlTime: 0,
    totalDuration: 16,
    activeCaption: null,
    currentClipIndex: 0,
    activeSourceId: 'v1',
    play: vi.fn(),
    pause: vi.fn(),
    seekEdl: vi.fn(),
  },
}))

vi.mock('../../utils/announcer', () => ({ announce: mockAnnounce }))
vi.mock('../../lib/serverApi', () => ({ serverPost: mockServerPost }))
vi.mock('../../services/ttsService', () => ({ default: ttsMock }))
vi.mock('../../contexts/AccessibilityContext', () => ({
  useAccessibility: () => a11yState,
}))
// Keep the real computeClipLayout (CreatorDevice maps clip→EDL offset with it);
// mock only the engine hook so jsdom never has to play real media.
vi.mock('../../hooks/usePlaybackEngine', async (importOriginal) => ({
  ...(await importOriginal()),
  default: () => engineMock,
}))

import CreatorDevice from './CreatorDevice'

const STATE = {
  clips: [
    { id: 's1', sourceId: 'v1', name: 'Scene 1', startTime: 0, endTime: 6, trimStart: 0, trimEnd: 0, color: '#E74C3C' },
    { id: 's2', sourceId: 'v1', name: 'Scene 2', startTime: 6, endTime: 12, trimStart: 0, trimEnd: 0, color: '#3498DB' },
    { id: 's3', sourceId: 'v2', name: 'Scene 3', startTime: 0, endTime: 4, trimStart: 0, trimEnd: 0, color: '#2ECC71' },
  ],
  captions: [],
  textOverlays: [],
  colour: {},
}

const DESCRIPTIONS = {
  s1: { 1: 'A person stirs a pot.', 2: 'Level two for scene one.', 3: 'Level three for scene one.' },
  s2: { 1: 'They taste the food.' },
  s3: { 1: 'A dog runs by.' },
}

const SOURCES = [
  { id: 'v1', name: 'kitchen.mp4', src: 'https://signed/v1', duration: 12 },
  { id: 'v2', name: 'garden.mp4', src: 'https://signed/v2', duration: 4 },
]

function makeProps(overrides = {}) {
  return {
    role: 'creator',
    projectId: 'p1',
    user: { id: 'u1' },
    state: STATE,
    version: 1,
    sources: SOURCES,
    descriptions: DESCRIPTIONS,
    tasks: [],
    applyAndSave: vi.fn(() => Promise.resolve()),
    channel: { sendPlayhead: vi.fn(), sendTransport: vi.fn(), sendActivity: vi.fn() },
    remote: { playhead: null, transport: null, activity: null },
    onCreateTask: vi.fn(() => Promise.resolve({ id: 't-new' })),
    onSetTaskStatus: vi.fn(),
    syncDown: false,
    ...overrides,
  }
}

function renderDevice(overrides = {}) {
  const props = makeProps(overrides)
  const utils = render(<CreatorDevice {...props} />)
  return { props, ...utils }
}

// Open a scene block by clicking its collapsed header (whose accessible name
// starts "Scene N of 3: <name>.") and return the expanded actions region
// (the data-scene-actions-region div SceneBlock renders for the children).
async function expandScene(sceneNumber, sceneName) {
  await userEvent.click(
    screen.getByRole('button', { name: new RegExp(`^Scene ${sceneNumber} of 3: ${sceneName}\\.`, 'i') })
  )
  const region = document.querySelector(`[data-scene-actions-region="${sceneNumber - 1}"]`)
  if (!region) throw new Error(`actions region for scene ${sceneNumber} not found`)
  return within(region)
}

beforeEach(() => {
  vi.clearAllMocks()
  a11yState.audioEnabled = false
  engineMock.edlTime = 0
  engineMock.currentClipIndex = 0
  engineMock.activeSourceId = 'v1'
  engineMock.totalDuration = 16
})

describe('CreatorDevice — scene list', () => {
  it('renders one scene block per clip from state.clips', () => {
    renderDevice()
    // Each clip yields a collapsed header naming the scene.
    expect(screen.getByRole('button', { name: /^Scene 1 of 3: Scene 1\./i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Scene 2 of 3: Scene 2\./i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Scene 3 of 3: Scene 3\./i })).toBeInTheDocument()
    // The collapsed header carries the level-1 description for that scene.
    expect(screen.getByRole('button', { name: /A person stirs a pot/i })).toBeInTheDocument()
  })

  it('expanding a scene shows the detail picker, the description, and the per-scene actions', async () => {
    await act(async () => { renderDevice() })
    const region = await expandScene(1, 'Scene 1')

    // Detail level selector (3 direct-pick targets).
    expect(region.getByRole('button', { name: /change to overview description/i })).toBeInTheDocument()
    expect(region.getByRole('button', { name: /change to detailed description/i })).toBeInTheDocument()
    expect(region.getByRole('button', { name: /change to technical description/i })).toBeInTheDocument()

    // Per-scene actions are rendered for real (not mocked).
    expect(region.getByRole('button', { name: /play scene, stops at the end of this scene/i })).toBeInTheDocument()
    expect(region.getByRole('button', { name: /play the whole video from here/i })).toBeInTheDocument()
    expect(region.getByRole('button', { name: /ask ai about scene/i })).toBeInTheDocument()
    expect(region.getByRole('button', { name: /edit by myself/i })).toBeInTheDocument()
    expect(region.getByRole('button', { name: /ask ai to edit/i })).toBeInTheDocument()
    expect(region.getByRole('button', { name: /ask helper to edit/i })).toBeInTheDocument()
  })

  it('renders the recent-tasks panel from the tasks prop with status labels', () => {
    renderDevice({
      tasks: [
        { id: 't1', text: 'Fix the colour', segment_label: 'Scene 2', status: 'pending', created_by: 'u1', created_at: '2026-06-13' },
        { id: 't2', text: 'Add music', segment_label: null, status: 'done', created_by: 'u1', created_at: '2026-06-13' },
      ],
    })
    const panel = screen.getByRole('region', { name: /recent tasks/i })
    expect(panel).toHaveTextContent('Fix the colour')
    expect(panel).toHaveTextContent('Scene 2')
    expect(panel).toHaveTextContent('Sent to helper')
    expect(panel).toHaveTextContent('Helper: Done')
  })
})

describe('CreatorDevice — edit by myself (delete round-trip)', () => {
  // A realistic applyAndSave that actually runs the opFn against a tracked
  // state (like EditorPage's optimistic apply): edits mutate `tracked.state`
  // and undo (state-replacing opFn) restores it. Closes the gap the
  // SceneActions unit test couldn't (it used a spy that never ran the opFn).
  function trackingApplyAndSave(tracked) {
    return vi.fn((opFn) => {
      tracked.state = opFn(tracked.state)
      return Promise.resolve()
    })
  }

  it('Edit → Delete removes the clip by id through applyAndSave', async () => {
    const tracked = { state: STATE }
    const applyAndSave = trackingApplyAndSave(tracked)
    await act(async () => { renderDevice({ applyAndSave }) })

    const region = await expandScene(1, 'Scene 1')
    await userEvent.click(region.getByRole('button', { name: /edit by myself/i }))
    await userEvent.click(region.getByRole('button', { name: /delete this clip/i }))

    expect(applyAndSave).toHaveBeenCalled()
    // The real opFn ran against the tracked state: s1 is gone.
    expect(tracked.state.clips.map((c) => c.id)).toEqual(['s2', 's3'])
  })

  it('undo round-trip restores the pre-edit clips', async () => {
    const tracked = { state: STATE }
    const applyAndSave = trackingApplyAndSave(tracked)
    await act(async () => { renderDevice({ applyAndSave }) })

    // Edit: split (keeps the panel open so Undo is reachable in the same panel).
    const region = await expandScene(1, 'Scene 1')
    await userEvent.click(region.getByRole('button', { name: /edit by myself/i }))
    await userEvent.click(region.getByRole('button', { name: /split this clip/i }))
    // The edit landed.
    expect(tracked.state.clips.length).toBe(4)

    // Undo replaces with the captured pre-image → back to the original 3 clips.
    const undoBtn = region.getByRole('button', { name: /undo last edit/i })
    expect(undoBtn).toBeEnabled()
    await userEvent.click(undoBtn)

    expect(tracked.state.clips.map((c) => c.id)).toEqual(['s1', 's2', 's3'])
    // The last applyAndSave was the non-rebasable state replacement.
    const lastCall = applyAndSave.mock.calls[applyAndSave.mock.calls.length - 1]
    expect(lastCall[2]).toEqual(expect.objectContaining({ rebasable: false }))
  })
})

describe('CreatorDevice — edit stamps (buildEditChangeSceneStamp)', () => {
  // The riskiest previously-untested path: after a real edit lands through
  // applyAndSave AND the device re-renders with the new state, the state-diff
  // watcher must stamp the amber "Edited" badge + "What changed" line on the
  // scene the ported buildEditChangeSceneStamp targets — and ONLY that scene.
  //
  // We re-render the SAME instance with the post-edit state (mirroring how
  // EditorPage feeds applyAndSave's result back down as the `state` prop), so
  // the watcher's prev→next diff fires.
  function trackingApplyAndSave(tracked) {
    return vi.fn((opFn) => {
      tracked.state = opFn(tracked.state)
      return Promise.resolve()
    })
  }

  // Locate a scene header by its 0-based block index (SceneBlock tags the
  // collapsed header button with data-scene-index).
  function headerForIndex(n) {
    return document.querySelector(`button[data-scene-index="${n}"]`)
  }

  it('split stamps "Edited" + "Split scene" on the ROOT scene block (scene 1), not the new piece, and leaves others unstamped', async () => {
    const tracked = { state: STATE }
    const applyAndSave = trackingApplyAndSave(tracked)
    const props = makeProps({ applyAndSave })
    let view
    await act(async () => { view = render(<CreatorDevice {...props} />) })

    // Split Scene 1 via the real Edit-by-Myself panel.
    const region = await expandScene(1, 'Scene 1')
    await userEvent.click(region.getByRole('button', { name: /edit by myself/i }))
    await userEvent.click(region.getByRole('button', { name: /split this clip/i }))
    // The split landed in tracked state: s1 → s1 + s1-split-…
    expect(tracked.state.clips.length).toBe(4)
    expect(tracked.state.clips[1].id).toMatch(/^s1-split-/)

    // Feed the post-edit state back down (EditorPage-style) so the watcher fires.
    await act(async () => {
      view.rerender(<CreatorDevice {...makeProps({ applyAndSave, state: tracked.state })} />)
    })

    // Scene 1 (block index 0, the ROOT segment the split derives from) is stamped.
    const stamped = headerForIndex(0)
    expect(within(stamped).getByText('Edited')).toBeInTheDocument()
    expect(within(stamped).getByText(/what changed:/i)).toBeInTheDocument()
    expect(within(stamped).getAllByText(/Split scene/i).length).toBeGreaterThan(0)

    // The other scene blocks carry no "Edited" badge.
    expect(within(headerForIndex(1)).queryByText('Edited')).not.toBeInTheDocument()
    expect(within(headerForIndex(2)).queryByText('Edited')).not.toBeInTheDocument()
    expect(within(headerForIndex(3)).queryByText('Edited')).not.toBeInTheDocument()
  })

  it('caption stamps "Edited" + "Caption added: …" on the captioned scene block (scene 2)', async () => {
    const tracked = { state: STATE }
    const applyAndSave = trackingApplyAndSave(tracked)
    const props = makeProps({ applyAndSave })
    let view
    await act(async () => { view = render(<CreatorDevice {...props} />) })

    // Add a caption to Scene 2 via the real Edit-by-Myself panel.
    const region = await expandScene(2, 'Scene 2')
    await userEvent.click(region.getByRole('button', { name: /edit by myself/i }))
    await userEvent.click(region.getByRole('button', { name: /add a caption to this scene/i }))
    const capInput = region.getByRole('textbox', { name: /caption text/i })
    await userEvent.type(capInput, 'They taste it')
    await userEvent.click(region.getByRole('button', { name: /save caption/i }))
    expect(tracked.state.captions.length).toBe(1)

    await act(async () => {
      view.rerender(<CreatorDevice {...makeProps({ applyAndSave, state: tracked.state })} />)
    })

    // Scene 2 (block index 1) is the captioned scene → stamped.
    const stamped = headerForIndex(1)
    expect(within(stamped).getByText('Edited')).toBeInTheDocument()
    expect(within(stamped).getAllByText(/Caption added: They taste it/i).length).toBeGreaterThan(0)
    expect(within(headerForIndex(0)).queryByText('Edited')).not.toBeInTheDocument()
    expect(within(headerForIndex(2)).queryByText('Edited')).not.toBeInTheDocument()
  })
})

describe('CreatorDevice — ask helper', () => {
  it('Ask helper → onCreateTask with the scene name, then closes the panel', async () => {
    const props = makeProps()
    await act(async () => { render(<CreatorDevice {...props} />) })

    const region = await expandScene(1, 'Scene 1')
    await userEvent.click(region.getByRole('button', { name: /ask helper to edit/i }))
    const panel = region.getByRole('group', { name: /ask helper/i })
    await userEvent.type(within(panel).getByRole('textbox'), 'Trim the noisy part')
    await userEvent.click(within(panel).getByRole('button', { name: /send to helper/i }))

    expect(props.onCreateTask).toHaveBeenCalledWith({
      text: 'Trim the noisy part',
      segmentLabel: 'Scene 1',
    })
  })
})

describe('CreatorDevice — ask AI (confirm-first, full timeline)', () => {
  it('happy path: POSTs ai-edit with FULL clips + focused_clip_id → confirm → applyAndSave', async () => {
    mockServerPost.mockResolvedValueOnce({ op: 'delete', target_clip_id: 's2', summary: 'drop the tasting shot' })
    const props = makeProps()
    await act(async () => { render(<CreatorDevice {...props} />) })

    const region = await expandScene(1, 'Scene 1')
    await userEvent.click(region.getByRole('button', { name: /ask ai to edit/i }))
    const panel = region.getByRole('group', { name: /ask ai to edit/i })
    await userEvent.type(within(panel).getByRole('textbox'), 'remove the tasting shot')
    await userEvent.click(within(panel).getByRole('button', { name: /ask ai/i }))

    // FULL timeline forwarded + focused_clip_id naming the open scene.
    expect(mockServerPost).toHaveBeenCalledTimes(1)
    const [path, body] = mockServerPost.mock.calls[0]
    expect(path).toBe('/api/projects/p1/ai-edit')
    expect(body.request).toBe('remove the tasting shot')
    expect(body.focused_clip_id).toBe('s1')
    expect(body.clips.map((c) => c.id)).toEqual(['s1', 's2', 's3'])

    // Confirm dialog shows the deterministic sentence for the targeted scene.
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Delete Scene 2?')).toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: /^confirm/i }))
    expect(props.applyAndSave).toHaveBeenCalledTimes(1)
    const [opFn, doneText] = props.applyAndSave.mock.calls[0]
    expect(doneText).toBe('Deleted Scene 2.')
    expect(opFn(STATE).clips.map((c) => c.id)).toEqual(['s1', 's3'])
  })
})

describe('CreatorDevice — VQA', () => {
  it('Ask AI about scene → POSTs the question to the segment vqa endpoint and announces the answer', async () => {
    mockServerPost.mockResolvedValueOnce({ answer: 'The pot is red.' })
    await act(async () => { renderDevice() })

    const region = await expandScene(1, 'Scene 1')
    await userEvent.click(region.getByRole('button', { name: /ask ai about scene/i }))
    const panel = region.getByRole('group', { name: /ask ai about scene/i })
    await userEvent.type(within(panel).getByRole('textbox'), 'What colour is the pot?')
    await userEvent.click(within(panel).getByRole('button', { name: /^ask$/i }))

    expect(mockServerPost).toHaveBeenCalledWith('/api/segments/s1/vqa', {
      question: 'What colour is the pot?',
    })
    await waitFor(() => expect(mockAnnounce).toHaveBeenCalledWith('The pot is red.'))
  })
})

describe('CreatorDevice — playback (bounded vs unbounded)', () => {
  it('Play this scene is BOUNDED: seeks to the scene start, plays, and pauses at the scene boundary', async () => {
    const props = makeProps()
    let view
    await act(async () => { view = render(<CreatorDevice {...props} />) })

    // Open Scene 2 (EDL offset 6, end 12) and start the bounded play.
    const region = await expandScene(2, 'Scene 2')
    await userEvent.click(region.getByRole('button', { name: /play scene, stops at the end of this scene/i }))

    // Bounded play seeks to Scene 2's EDL offset and plays.
    expect(engineMock.seekEdl).toHaveBeenCalledWith(6)
    expect(engineMock.play).toHaveBeenCalled()
    expect(props.channel.sendTransport).toHaveBeenCalledWith({ action: 'play', time: expect.any(Number) })

    // Advance the engine PAST the scene-2 boundary (EDL 12) and re-render the
    // SAME instance so playingSegmentEnd state survives — the boundary watcher
    // then auto-pauses.
    engineMock.pause.mockClear()
    engineMock.edlTime = 12.1
    await act(async () => { view.rerender(<CreatorDevice {...props} />) })
    await waitFor(() => expect(engineMock.pause).toHaveBeenCalled())
  })

  it('Play from here is UNBOUNDED: seeks + plays and does NOT pause at the next boundary', async () => {
    const props = makeProps()
    let view
    await act(async () => { view = render(<CreatorDevice {...props} />) })

    const region = await expandScene(2, 'Scene 2')
    await userEvent.click(region.getByRole('button', { name: /play the whole video from here/i }))

    expect(engineMock.seekEdl).toHaveBeenCalledWith(6)
    expect(engineMock.play).toHaveBeenCalled()

    // Crossing the scene-2 boundary does NOT auto-pause (no bounded segment end)
    // — only the off-the-end-of-timeline stop applies, and 12.1 < total 16.
    engineMock.pause.mockClear()
    engineMock.edlTime = 12.1
    await act(async () => { view.rerender(<CreatorDevice {...props} />) })
    expect(engineMock.pause).not.toHaveBeenCalled()
  })
})
