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

import HelperDevice, { colourValuesToTransform } from './HelperDevice'
import { makeTrimOp, COLOUR_SLIDERS } from './EditorTimeline'

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

    // The task text now appears in both the Creator Intent Banner and the Activity Feed.
    expect(screen.getAllByText('Trim the shaky part').length).toBeGreaterThanOrEqual(1)
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
    await userEvent.click(screen.getByRole('button', { name: /^delete:/i }))

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

  it('committing colour on a split clip keys state.colour under the ROOT scene id', async () => {
    // A split timeline: g1 split into g1 (first half) + g1-split-123-a (second).
    const SPLIT_STATE = {
      clips: [
        { id: 'g1', sourceId: 'v1', name: 'Scene 1', startTime: 0, endTime: 3, trimStart: 0, trimEnd: 0, color: '#E74C3C' },
        { id: 'g1-split-123-a', sourceId: 'v1', name: 'Scene 1', startTime: 3, endTime: 6, trimStart: 0, trimEnd: 0, color: '#E74C3C' },
        { id: 's2', sourceId: 'v1', name: 'Scene 2', startTime: 6, endTime: 12, trimStart: 0, trimEnd: 0, color: '#3498DB' },
      ],
      captions: [], textOverlays: [], colour: {},
    }
    // Select the SECOND split half so the colour tool targets 'g1-split-123-a'.
    engineMock.currentClipIndex = 1
    const { props } = renderDevice({ state: SPLIT_STATE })

    await userEvent.click(screen.getByRole('button', { name: /visual adjustments/i }))
    // Select the second split half on the timeline (its label is "Scene 1").
    await userEvent.click(screen.getAllByRole('option', { name: /Scene 1/i })[1])
    const slider = screen.getByRole('slider', { name: /brightness/i })
    fireEvent.change(slider, { target: { value: '25' } })
    fireEvent.pointerUp(slider)

    expect(props.applyAndSave).toHaveBeenCalled()
    const [opFn] = props.applyAndSave.mock.calls[0]
    const next = opFn(SPLIT_STATE)
    // Keyed under the ROOT 'g1', not the raw split id.
    expect(next.colour.g1).toEqual({ brightness: 25 })
    expect(next.colour['g1-split-123-a']).toBeUndefined()
  })

  it('HelperDevice reads active colour by root scene id for EITHER split half', () => {
    const SPLIT_STATE = {
      clips: [
        { id: 'g1', sourceId: 'v1', name: 'Scene 1', startTime: 0, endTime: 3, trimStart: 0, trimEnd: 0, color: '#E74C3C' },
        { id: 'g1-split-123-a', sourceId: 'v1', name: 'Scene 1', startTime: 3, endTime: 6, trimStart: 0, trimEnd: 0, color: '#E74C3C' },
      ],
      captions: [], textOverlays: [],
      // Colour graded on the root scene — both halves should inherit it.
      colour: { g1: { brightness: 100 } },
    }
    // First half active.
    engineMock.currentClipIndex = 0
    const { container, rerender, props } = renderDevice({ state: SPLIT_STATE })
    const firstHalfVideo = container.querySelector('video[style*="brightness"]')
    expect(firstHalfVideo).not.toBeNull()

    // Second half active — same root colour still applies.
    engineMock.currentClipIndex = 1
    rerender(<HelperDevice {...{ ...props, state: SPLIT_STATE }} />)
    const secondHalfVideo = container.querySelector('video[style*="brightness"]')
    expect(secondHalfVideo).not.toBeNull()
  })
})

describe('HelperDevice — Sound panel (mute + volume)', () => {
  it('the Sound toolbar button opens a panel with a mute toggle and a scene-volume slider', async () => {
    renderDevice()
    await userEvent.click(screen.getByRole('button', { name: /show sound panel/i }))
    // Defaults: active tool clip is s1 (playhead at 0), not muted.
    expect(screen.getByRole('button', { name: /mute the original audio for scene 1/i })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: /scene 1 volume/i })).toBeInTheDocument()
  })

  it('the mute toggle calls applyAndSave with a setClipMuted opFn that flips clip.muted', async () => {
    const { props } = renderDevice()
    await userEvent.click(screen.getByRole('button', { name: /show sound panel/i }))
    await userEvent.click(screen.getByRole('button', { name: /mute the original audio for scene 1/i }))

    expect(props.applyAndSave).toHaveBeenCalledTimes(1)
    const [opFn, announceText] = props.applyAndSave.mock.calls[0]
    const next = opFn(STATE)
    // s1 is the active tool clip under the playhead → its muted flag flips true.
    expect(next.clips.find((c) => c.id === 's1').muted).toBe(true)
    // Other clips untouched; input never mutated.
    expect(next.clips.find((c) => c.id === 's2').muted).toBeFalsy()
    expect(STATE.clips.find((c) => c.id === 's1').muted).toBeFalsy()
    expect(announceText).toMatch(/muted scene 1/i)
  })

  it('committing the volume slider calls applyAndSave setting clip.volume on the active scene', async () => {
    const { props } = renderDevice()
    await userEvent.click(screen.getByRole('button', { name: /show sound panel/i }))
    const slider = screen.getByRole('slider', { name: /scene 1 volume/i })

    fireEvent.change(slider, { target: { value: '40' } })
    fireEvent.pointerUp(slider)

    expect(props.applyAndSave).toHaveBeenCalled()
    const [opFn, announceText] = props.applyAndSave.mock.calls[0]
    const next = opFn(STATE)
    expect(next.clips.find((c) => c.id === 's1').volume).toBe(40)
    expect(announceText).toMatch(/scene 1 volume to 40%/i)
  })

  it('a volume commit of 0 announces a mute (probe wording)', async () => {
    const { props } = renderDevice()
    await userEvent.click(screen.getByRole('button', { name: /show sound panel/i }))
    const slider = screen.getByRole('slider', { name: /scene 1 volume/i })

    fireEvent.change(slider, { target: { value: '0' } })
    fireEvent.pointerUp(slider)

    const [opFn, announceText] = props.applyAndSave.mock.calls[0]
    expect(opFn(STATE).clips.find((c) => c.id === 's1').volume).toBe(0)
    expect(announceText).toMatch(/muted scene 1/i)
  })
})

describe('EditorTimeline — trim opFn (makeTrimOp factory)', () => {
  // The trim opFn is keyboard/pointer-driven on slider handles inside the
  // selected clip (pointer capture is not reliable in jsdom), so the component
  // delegates to this exported pure factory and we exercise the real maths here.
  const fixture = () => ({
    clips: [
      { id: 'a', sourceId: 'v1', name: 'A', startTime: 0, endTime: 6, trimStart: 0, trimEnd: 0, color: '#000' },
      { id: 'b', sourceId: 'v1', name: 'B', startTime: 6, endTime: 12, trimStart: 0, trimEnd: 0, color: '#111' },
    ],
    captions: [], textOverlays: [], colour: {},
  })

  it('(a) targets the clip by id regardless of clip order', () => {
    const op = makeTrimOp('b', 'left', +1)
    // A reordered/rebased state where b is now first — id targeting must still hit b.
    const reordered = fixture()
    reordered.clips = [reordered.clips[1], reordered.clips[0]]
    const next = op(reordered)
    expect(next.clips.find((c) => c.id === 'b').trimStart).toBe(0.5)
    expect(next.clips.find((c) => c.id === 'a').trimStart).toBe(0)
  })

  it('(b) applies the 0.5s step on each edge', () => {
    const s = fixture()
    const afterLeft = makeTrimOp('a', 'left', +1)(s)
    expect(afterLeft.clips[0].trimStart).toBe(0.5)
    const afterRight = makeTrimOp('a', 'right', +1)(afterLeft)
    expect(afterRight.clips[0].trimEnd).toBe(0.5)
  })

  it('(b) clamps to a 0 floor — untrimming past 0 cannot go negative', () => {
    const s = fixture()
    const next = makeTrimOp('a', 'left', -1)(s) // trimStart already 0
    expect(next.clips[0].trimStart).toBe(0)
  })

  it('leaves at least 0.5s of clip — trimStart cannot eat the whole 6s clip', () => {
    let s = fixture() // clip a is 6s long
    const op = makeTrimOp('a', 'left', +1)
    for (let i = 0; i < 20; i++) s = op(s) // try to trim 10s off a 6s clip
    // dur - trimEnd - 0.5 = 6 - 0 - 0.5 = 5.5 is the ceiling.
    expect(s.clips[0].trimStart).toBe(5.5)
  })

  it('is a no-op (returns state unchanged) when the id is gone', () => {
    const s = fixture()
    expect(makeTrimOp('missing', 'left', +1)(s)).toBe(s)
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

describe('colourValuesToTransform — rotate', () => {
  it('returns undefined when zoom and rotate are both neutral', () => {
    expect(colourValuesToTransform(undefined)).toBeUndefined()
    expect(colourValuesToTransform({})).toBeUndefined()
    expect(colourValuesToTransform({ zoom: 100, rotate: 0 })).toBeUndefined()
  })

  it('appends rotate() when rotate !== 0 (probe editStateView mapping)', () => {
    expect(colourValuesToTransform({ zoom: 100, rotate: 90 })).toBe('scale(1.000) rotate(90deg)')
    expect(colourValuesToTransform({ rotate: -45 })).toBe('scale(1.000) rotate(-45deg)')
  })

  it('combines zoom scale with rotate', () => {
    expect(colourValuesToTransform({ zoom: 150, rotate: 15 })).toBe('scale(1.500) rotate(15deg)')
  })

  it('keeps zoom-only output unchanged (no rotate term) when rotate is 0', () => {
    expect(colourValuesToTransform({ zoom: 200, rotate: 0 })).toBe('scale(2.000)')
  })
})

describe('EditorTimeline — COLOUR_SLIDERS includes rotate', () => {
  it('exposes a rotate slider spanning -180..180 step 15', () => {
    const rotate = COLOUR_SLIDERS.find((s) => s.id === 'rotate')
    expect(rotate).toMatchObject({ id: 'rotate', min: -180, max: 180, step: 15, suffix: '°' })
  })
})
