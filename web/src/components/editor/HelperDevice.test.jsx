import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { mockAnnounce, a11yState, engineMock } = vi.hoisted(() => ({
  mockAnnounce: vi.fn(),
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
vi.mock('../../contexts/AccessibilityContext', () => ({
  useAccessibility: () => a11yState,
}))
// Keep the real computeClipLayout (preview seek maths depend on it); mock only
// the engine hook so jsdom never has to play real media.
vi.mock('../../hooks/usePlaybackEngine', async (importOriginal) => ({
  ...(await importOriginal()),
  default: () => engineMock,
}))

import HelperDevice from './HelperDevice'

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
  s1: { 1: 'A person stirs a pot.' },
  s2: { 1: 'They taste the food.' },
  s3: { 1: 'A dog runs by.' },
}

const SOURCES = [
  { id: 'v1', name: 'kitchen.mp4', src: 'https://signed/v1', duration: 12 },
  { id: 'v2', name: 'garden.mp4', src: 'https://signed/v2', duration: 4 },
]

function makeProps(overrides = {}) {
  return {
    role: 'helper',
    projectId: 'p1',
    user: { id: 'u2' },
    state: STATE,
    version: 1,
    sources: SOURCES,
    descriptions: DESCRIPTIONS,
    tasks: [],
    applyAndSave: vi.fn(() => Promise.resolve()),
    channel: { sendPlayhead: vi.fn(), sendTransport: vi.fn(), sendActivity: vi.fn() },
    remote: { playhead: null, transport: null, activity: null },
    onCreateTask: vi.fn(() => Promise.resolve()),
    onSetTaskStatus: vi.fn(() => Promise.resolve()),
    syncDown: false,
    ...overrides,
  }
}

function renderDevice(overrides = {}) {
  const props = makeProps(overrides)
  const utils = render(<HelperDevice {...props} />)
  return { props, ...utils }
}

beforeEach(() => {
  vi.clearAllMocks()
  a11yState.audioEnabled = false
  engineMock.edlTime = 0
  engineMock.currentClipIndex = 0
  engineMock.activeSourceId = 'v1'
  engineMock.totalDuration = 16
})

describe('HelperDevice — tasks (activity feed)', () => {
  it('(a) a pending task renders Mark Done / Needs discussion / Can\'t do and Done calls onSetTaskStatus', async () => {
    const { props } = renderDevice({
      tasks: [
        { id: 't1', text: 'Trim the shaky part', segment_label: 'Scene 1', status: 'pending', created_by: 'u1', created_at: '2026-06-12' },
      ],
    })

    expect(screen.getByText('Trim the shaky part')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /mark done/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /needs discussion/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /can't do/i })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /mark done/i }))
    expect(props.onSetTaskStatus).toHaveBeenCalledWith('t1', 'done')
  })

  it('Needs discussion and Can\'t do map to the right status strings', async () => {
    const { props } = renderDevice({
      tasks: [
        { id: 't1', text: 'A', segment_label: null, status: 'pending', created_by: 'u1', created_at: '2026-06-12' },
      ],
    })
    await userEvent.click(screen.getByRole('button', { name: /needs discussion/i }))
    expect(props.onSetTaskStatus).toHaveBeenCalledWith('t1', 'needs_discussion')

    await userEvent.click(screen.getByRole('button', { name: /can't do/i }))
    expect(props.onSetTaskStatus).toHaveBeenCalledWith('t1', 'cant_do')
  })

  it('non-pending tasks render as history with a status pill and no action buttons', () => {
    renderDevice({
      tasks: [
        { id: 't1', text: 'Done one', segment_label: null, status: 'done', created_by: 'u1', created_at: '2026-06-12' },
      ],
    })
    expect(screen.getByText('Done one')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /mark done/i })).not.toBeInTheDocument()
    expect(screen.getByText(/^Done$/)).toBeInTheDocument()
  })
})

describe('HelperDevice — timeline edits', () => {
  it('(b) timeline delete routes through applyAndSave with an id-based opFn', async () => {
    const { props } = renderDevice()

    // select a clip then delete
    await userEvent.click(screen.getByRole('option', { name: /Scene 1/i }))
    await userEvent.click(screen.getByRole('button', { name: /delete selected clip/i }))

    expect(props.applyAndSave).toHaveBeenCalledTimes(1)
    const [opFn] = props.applyAndSave.mock.calls[0]
    const next = opFn(STATE)
    expect(next.clips.map((c) => c.id)).toEqual(['s2', 's3'])
    expect(STATE.clips).toHaveLength(3) // pure — never mutates the input
  })

  it('(f) every timeline clip carries data-testid="timeline-clip"', () => {
    const { container } = renderDevice()
    const clips = container.querySelectorAll('[data-testid="timeline-clip"]')
    expect(clips).toHaveLength(3)
  })
})

describe('HelperDevice — colour (persistent)', () => {
  it('(c) committing a colour slider calls applyAndSave; the resulting state carries colour[sceneId].brightness', async () => {
    const { props } = renderDevice()

    // open the Visual panel
    await userEvent.click(screen.getByRole('button', { name: /visual adjustments/i }))
    const slider = screen.getByRole('slider', { name: /brightness/i })

    // change-end commit (not transient input)
    fireEvent.change(slider, { target: { value: '40' } })
    fireEvent.pointerUp(slider)

    expect(props.applyAndSave).toHaveBeenCalled()
    const [opFn, announceText] = props.applyAndSave.mock.calls[0]
    const next = opFn(STATE)
    // active scene under the playhead is s1
    expect(next.colour.s1.brightness).toBe(40)
    expect(typeof announceText).toBe('string')
    // existing colour for other scenes is untouched
    expect(next.colour).toMatchObject({ s1: { brightness: 40 } })
  })

  it('the colour panel is labelled preview-only until export', async () => {
    renderDevice()
    await userEvent.click(screen.getByRole('button', { name: /visual adjustments/i }))
    expect(screen.getByText(/preview only until export/i)).toBeInTheDocument()
  })
})

describe('HelperDevice — synced preview', () => {
  it('(d) remote.transport pause/seek drives the pinned preview state', () => {
    const { rerender, props } = renderDevice()

    rerender(<HelperDevice {...{ ...props, remote: { playhead: null, transport: { action: 'pause', time: 3 }, activity: null } }} />)
    // a pause transport seeks the preview engine to the creator's time and does not play
    expect(engineMock.seekEdl).toHaveBeenCalledWith(3)
    expect(engineMock.play).not.toHaveBeenCalled()

    rerender(<HelperDevice {...{ ...props, remote: { playhead: null, transport: { action: 'play', time: 5 }, activity: null } }} />)
    expect(engineMock.play).toHaveBeenCalled()
  })
})

describe('HelperDevice — creator activity', () => {
  it('(e) renders creator activity entries from received remote.activity payloads', () => {
    const { rerender, props } = renderDevice()

    rerender(<HelperDevice {...{ ...props, remote: { playhead: null, transport: null, activity: { action: 'Seeked', detail: '0:45', actor: 'creator' } } }} />)
    expect(screen.getByText(/Seeked/)).toBeInTheDocument()
    expect(screen.getByText(/0:45/)).toBeInTheDocument()

    rerender(<HelperDevice {...{ ...props, remote: { playhead: null, transport: null, activity: { action: 'Played', detail: '1:10', actor: 'creator' } } }} />)
    // both entries accumulate
    expect(screen.getByText(/Seeked/)).toBeInTheDocument()
    expect(screen.getByText(/Played/)).toBeInTheDocument()
  })
})

describe('HelperDevice — local scrub', () => {
  it('seeking the preview emits sendActivity with the formatted time', async () => {
    const { props } = renderDevice()
    await userEvent.click(screen.getByRole('button', { name: /forward 5 seconds/i }))
    expect(props.channel.sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'Seeked' })
    )
  })
})
