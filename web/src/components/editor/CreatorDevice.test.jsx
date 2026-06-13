import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { mockAnnounce, mockServerPost, mockPlayEarcon, ttsMock, a11yState, engineMock } = vi.hoisted(() => ({
  mockAnnounce: vi.fn(),
  mockServerPost: vi.fn(),
  mockPlayEarcon: vi.fn(),
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
vi.mock('../../utils/earcon', () => ({ playEarcon: mockPlayEarcon }))
vi.mock('../../services/ttsService', () => ({ default: ttsMock }))
vi.mock('../../contexts/AccessibilityContext', () => ({
  useAccessibility: () => a11yState,
}))
vi.mock('../../hooks/useSpeechRecognition', () => ({
  default: () => ({ isListening: false, isPreparing: false, toggleListening: vi.fn() }),
}))
// Keep the real computeClipLayout (the split source-time mapping depends on it);
// mock only the engine hook so jsdom never has to play real media.
vi.mock('../../hooks/usePlaybackEngine', async (importOriginal) => ({
  ...(await importOriginal()),
  default: () => engineMock,
}))

import CreatorDevice from './CreatorDevice'

const STATE = {
  clips: [
    { id: 's1', sourceId: 'v1', name: 'Scene 1', startTime: 0, endTime: 6, trimStart: 0, trimEnd: 0 },
    { id: 's2', sourceId: 'v1', name: 'Scene 2', startTime: 6, endTime: 12, trimStart: 0, trimEnd: 0 },
    { id: 's3', sourceId: 'v2', name: 'Scene 3', startTime: 0, endTime: 4, trimStart: 0, trimEnd: 0 },
  ],
  captions: [],
  textOverlays: [],
  colour: {},
}

const DESCRIPTIONS = {
  s1: {
    1: 'A person stirs a pot.',
    2: 'Level two for scene one.',
    3: 'Level three for scene one.',
  },
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
  render(<CreatorDevice {...props} />)
  return props
}

async function openModal(buttonName) {
  await userEvent.click(screen.getByRole('button', { name: buttonName }))
}

beforeEach(() => {
  vi.clearAllMocks()
  a11yState.audioEnabled = false
  engineMock.edlTime = 0
  engineMock.currentClipIndex = 0
  engineMock.activeSourceId = 'v1'
  engineMock.totalDuration = 16
})

describe('CreatorDevice — exploration', () => {
  it('(a) navigating to the next scene announces its name and the description at the current detail level', async () => {
    renderDevice()

    await userEvent.click(screen.getByRole('button', { name: /next scene: scene 2/i }))

    expect(mockAnnounce).toHaveBeenCalledWith('Scene 2 of 3. Scene 2.')
    expect(mockAnnounce).toHaveBeenCalledWith(
      expect.stringMatching(/^Detail level 1\. .*They taste the food\./)
    )
    expect(mockPlayEarcon).toHaveBeenCalledWith(880, 50)
    // navigation seeks the playback engine to the scene's timeline offset
    expect(engineMock.seekEdl).toHaveBeenCalledWith(6)
  })

  it('(b) detail level up/down re-announces the description at the new level', async () => {
    renderDevice()

    await userEvent.click(screen.getByRole('button', { name: /more detail/i }))
    expect(mockAnnounce).toHaveBeenCalledWith(
      expect.stringMatching(/^Detail level 2\. .*Level two for scene one\./)
    )
    expect(mockPlayEarcon).toHaveBeenCalledWith(440, 50)

    mockAnnounce.mockClear()
    await userEvent.click(screen.getByRole('button', { name: /less detail/i }))
    expect(mockAnnounce).toHaveBeenCalledWith(
      expect.stringMatching(/^Detail level 1\. .*A person stirs a pot\./)
    )
  })

  it('(i) the keyboard map matches the probe: arrows navigate scenes and detail, Escape closes the edit panel', async () => {
    renderDevice()

    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(mockAnnounce).toHaveBeenCalledWith('Scene 2 of 3. Scene 2.')

    fireEvent.keyDown(document.body, { key: 'ArrowUp' })
    expect(mockAnnounce).toHaveBeenCalledWith(expect.stringMatching(/^Detail level 2\./))

    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    expect(mockAnnounce).toHaveBeenCalledWith(expect.stringMatching(/^Detail level 1\./))

    fireEvent.keyDown(document.body, { key: 'ArrowLeft' })
    expect(mockAnnounce).toHaveBeenCalledWith('Scene 1 of 3. Scene 1.')

    // Escape closes the edit panel
    await openModal(/edit this clip yourself/i)
    expect(screen.getByRole('dialog', { name: /edit clip: scene 1/i })).toBeInTheDocument()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /edit clip/i })).not.toBeInTheDocument()
    )
    expect(mockAnnounce).toHaveBeenCalledWith('Edit panel closed.')
  })

  it('(j) Space and the play button start playback and send a transport event; pause sends pause', async () => {
    const props = renderDevice()

    fireEvent.keyDown(document.body, { key: ' ' })
    expect(engineMock.play).toHaveBeenCalled()
    await waitFor(() =>
      expect(props.channel.sendTransport).toHaveBeenCalledWith({ action: 'play', time: 0 })
    )
    expect(mockAnnounce).toHaveBeenCalledWith('Playing.')

    await userEvent.click(screen.getByRole('button', { name: /pause playback/i }))
    expect(engineMock.pause).toHaveBeenCalled()
    await waitFor(() =>
      expect(props.channel.sendTransport).toHaveBeenCalledWith({ action: 'pause', time: 0 })
    )
  })

  it('(j) broadcasts the playhead on the ~2s cadence', () => {
    const realSetInterval = globalThis.setInterval
    const cadenceCbs = []
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation((cb, ms, ...args) => {
      if (ms === 2000) {
        cadenceCbs.push(cb)
        return 0
      }
      return realSetInterval(cb, ms, ...args)
    })
    try {
      const props = renderDevice()
      expect(cadenceCbs.length).toBeGreaterThan(0)
      act(() => {
        cadenceCbs.forEach((cb) => cb())
      })
      expect(props.channel.sendPlayhead).toHaveBeenCalledWith({
        isPlaying: false,
        time: 0,
        segmentId: 's1',
      })
    } finally {
      spy.mockRestore()
    }
  })
})

describe('CreatorDevice — Edit Myself', () => {
  it('(c) delete routes through applyAndSave with an opFn that removes the clip, naming the scene', async () => {
    const props = renderDevice()

    await openModal(/edit this clip yourself/i)
    expect(mockAnnounce).toHaveBeenCalledWith('Edit panel opened.')
    await userEvent.click(screen.getByRole('button', { name: /delete this clip/i }))

    expect(props.applyAndSave).toHaveBeenCalledTimes(1)
    const [opFn, announceText] = props.applyAndSave.mock.calls[0]
    expect(announceText).toBe('Deleted clip: Scene 1')
    const next = opFn(STATE)
    expect(next.clips.map((c) => c.id)).toEqual(['s2', 's3'])
    expect(STATE.clips).toHaveLength(3) // pure — never mutates
  })

  it('(d) split is disabled while the playhead sits at the scene boundary (characterized from the probe)', async () => {
    renderDevice() // engine edlTime = 0 — not strictly inside Scene 1

    await openModal(/edit this clip yourself/i)
    expect(screen.getByRole('button', { name: /split this clip/i })).toBeDisabled()
  })

  it('(d) split at a mid-scene playhead splits at the mapped source time', async () => {
    engineMock.edlTime = 2.5
    const props = renderDevice()

    await openModal(/edit this clip yourself/i)
    const splitBtn = screen.getByRole('button', { name: /split this clip/i })
    expect(splitBtn).toBeEnabled()
    await userEvent.click(splitBtn)

    const [opFn, announceText] = props.applyAndSave.mock.calls[0]
    expect(announceText).toBe('Split Scene 1 at 2.5 seconds')
    const next = opFn(STATE)
    expect(next.clips).toHaveLength(4)
    expect(next.clips[0]).toMatchObject({ id: 's1', startTime: 0, endTime: 2.5 })
    expect(next.clips[1]).toMatchObject({ startTime: 2.5, endTime: 6 })
    expect(next.clips[1].id).toMatch(/^s1-split-/)
  })

  it('adds a caption to the current scene through applyAndSave', async () => {
    const props = renderDevice()

    await openModal(/edit this clip yourself/i)
    // Let the panel's delayed initial focus (useRootInert, 100ms) land before
    // typing — otherwise it steals focus mid-keystroke (probe-identical timing).
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /close edit actions/i })).toHaveFocus()
    )
    await userEvent.click(screen.getByRole('button', { name: /add a caption to this scene/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /caption text/i }), 'hello there')
    await userEvent.click(screen.getByRole('button', { name: /save caption/i }))

    const [opFn, announceText] = props.applyAndSave.mock.calls[0]
    expect(announceText).toBe('Added caption: "hello there"')
    const next = opFn(STATE)
    expect(next.captions).toHaveLength(1)
    expect(next.captions[0]).toMatchObject({ sceneId: 's1', text: 'hello there' })
  })

  it('undo replays the pre-edit state through applyAndSave (local stacks survive the port)', async () => {
    const props = renderDevice()

    await openModal(/edit this clip yourself/i)
    await userEvent.click(screen.getByRole('button', { name: /delete this clip/i }))

    await openModal(/edit this clip yourself/i)
    const undoBtn = screen.getByRole('button', { name: /undo last edit/i })
    expect(undoBtn).toBeEnabled()
    await userEvent.click(undoBtn)

    expect(props.applyAndSave).toHaveBeenCalledTimes(2)
    const [opFn, announceText] = props.applyAndSave.mock.calls[1]
    expect(announceText).toBe('Undo')
    // state-replacing opFn: returns the snapshot regardless of input
    expect(opFn({ clips: [], captions: [] })).toEqual(STATE)
  })
})

describe('CreatorDevice — Ask Helper', () => {
  it('(e) submits the task with the current scene label and closes the modal', async () => {
    const props = renderDevice()

    await openModal(/ask helper to edit this clip/i)
    const dialog = screen.getByRole('dialog', { name: 'Ask Helper' })
    expect(dialog).toBeInTheDocument()

    await userEvent.type(screen.getByRole('textbox', { name: /task description/i }), 'Trim the noisy part')
    await userEvent.click(screen.getByRole('button', { name: /send task/i }))

    expect(props.onCreateTask).toHaveBeenCalledWith({
      text: 'Trim the noisy part',
      segmentLabel: 'Scene 1',
    })
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Ask Helper' })).not.toBeInTheDocument()
    )
    await waitFor(() => expect(mockAnnounce).toHaveBeenCalledWith('Sent to helper.'))
  })

  it('renders the recent-tasks panel from the tasks prop with status labels', () => {
    renderDevice({
      tasks: [
        { id: 't1', text: 'Fix the colour', segment_label: 'Scene 2', status: 'pending', created_by: 'u1', created_at: '2026-06-12' },
        { id: 't2', text: 'Add music', segment_label: null, status: 'done', created_by: 'u1', created_at: '2026-06-12' },
      ],
    })

    const panel = screen.getByRole('region', { name: /recent tasks/i })
    expect(panel).toHaveTextContent('Fix the colour')
    expect(panel).toHaveTextContent('Scene 2')
    expect(panel).toHaveTextContent('Sent to helper')
    expect(panel).toHaveTextContent('Add music')
    expect(panel).toHaveTextContent('Helper: Done')
  })
})

describe('CreatorDevice — Ask AI', () => {
  async function askAi(text) {
    await openModal(/ask ai to edit this clip/i)
    await userEvent.type(screen.getByRole('textbox', { name: /task description/i }), text)
    await userEvent.click(screen.getByRole('button', { name: /send task/i }))
  }

  it('(f) happy path: posts the clips payload, shows the DETERMINISTIC sentence, applies on Confirm', async () => {
    mockServerPost.mockResolvedValue({
      op: 'delete',
      target_clip_id: 's2',
      params: {},
      summary: 'I will delete the tasting shot for you.',
    })
    const props = renderDevice()

    await askAi('remove the tasting shot')

    expect(mockServerPost).toHaveBeenCalledWith('/api/projects/p1/ai-edit', {
      request: 'remove the tasting shot',
      clips: [
        { id: 's1', name: 'Scene 1', duration_seconds: 6 },
        { id: 's2', name: 'Scene 2', duration_seconds: 6 },
        { id: 's3', name: 'Scene 3', duration_seconds: 4 },
      ],
    })

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Delete Scene 2?')
    // Gemini's summary is secondary supplementary text
    expect(dialog).toHaveTextContent('I will delete the tasting shot for you.')
    // the ask modal closed when the proposal arrived
    expect(screen.queryByRole('dialog', { name: 'Ask AI' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /confirm/i }))

    expect(props.applyAndSave).toHaveBeenCalledTimes(1)
    const [opFn, announceText] = props.applyAndSave.mock.calls[0]
    expect(announceText).toBe('Deleted Scene 2.')
    expect(opFn(STATE).clips.map((c) => c.id)).toEqual(['s1', 's3'])
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  })

  it('(g) clarification: speaks it, keeps the modal open, opens no confirm dialog', async () => {
    mockServerPost.mockResolvedValue({ clarification: 'Which scene do you mean?' })
    const props = renderDevice()

    await askAi('make it better')

    await waitFor(() => expect(mockAnnounce).toHaveBeenCalledWith('Which scene do you mean?'))
    const dialog = screen.getByRole('dialog', { name: 'Ask AI' })
    expect(dialog).toHaveTextContent('Which scene do you mean?')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(props.applyAndSave).not.toHaveBeenCalled()
  })

  it('cancelling the confirm dialog makes no change', async () => {
    mockServerPost.mockResolvedValue({ op: 'delete', target_clip_id: 's1', params: {}, summary: '' })
    const props = renderDevice()

    await askAi('drop the first scene')
    await screen.findByRole('alertdialog')
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))

    expect(props.applyAndSave).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('rejects a proposal that targets a clip no longer in the timeline', async () => {
    mockServerPost.mockResolvedValue({ op: 'delete', target_clip_id: 'ghost', params: {}, summary: '' })
    const props = renderDevice()

    await askAi('delete the old scene')

    await waitFor(() =>
      expect(mockAnnounce).toHaveBeenCalledWith(
        expect.stringMatching(/doesn't match the current timeline/i),
        { assertive: true }
      )
    )
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(props.applyAndSave).not.toHaveBeenCalled()
  })
})

describe('CreatorDevice — VQA', () => {
  it('(h) sends the question to the segment VQA endpoint and announces the answer', async () => {
    mockServerPost.mockResolvedValue({ answer: 'The pot is red.' })
    renderDevice()

    await openModal(/ask a question about this scene/i)
    const dialog = screen.getByRole('dialog', { name: 'Ask About This Scene' })
    expect(dialog).toBeInTheDocument()

    await userEvent.type(screen.getByRole('textbox', { name: /your question/i }), 'What colour is the pot?')
    await userEvent.click(screen.getByRole('button', { name: /send question/i }))

    expect(mockServerPost).toHaveBeenCalledWith('/api/segments/s1/vqa', {
      question: 'What colour is the pot?',
    })
    await waitFor(() => expect(mockAnnounce).toHaveBeenCalledWith('The pot is red.'))
    expect(screen.getByRole('dialog', { name: 'Ask About This Scene' })).toHaveTextContent(
      'The pot is red.'
    )
  })

  it('maps a split-derived clip back to its root segment id', async () => {
    mockServerPost.mockResolvedValue({ answer: 'Yes.' })
    renderDevice({
      state: {
        ...STATE,
        clips: [
          { id: 's1-split-1700000000000-0', sourceId: 'v1', name: 'Scene 1', startTime: 0, endTime: 3, trimStart: 0, trimEnd: 0 },
        ],
      },
    })

    await openModal(/ask a question about this scene/i)
    await userEvent.type(screen.getByRole('textbox', { name: /your question/i }), 'Is it day?')
    await userEvent.click(screen.getByRole('button', { name: /send question/i }))

    expect(mockServerPost).toHaveBeenCalledWith('/api/segments/s1/vqa', { question: 'Is it day?' })
  })
})
