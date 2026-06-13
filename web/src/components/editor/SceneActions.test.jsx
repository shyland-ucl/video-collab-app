import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// House mock style (see CreatorDevice.test.jsx / SceneBlockList.test.jsx):
// hoist + mock the announcer, the serverApi POST, the TTS singleton and the
// AccessibilityContext so jsdom never touches the live region, the network,
// speechSynthesis or the real provider tree.
const { mockAnnounce, mockServerPost, ttsMock, a11yState } = vi.hoisted(() => ({
  mockAnnounce: vi.fn(),
  mockServerPost: vi.fn(),
  ttsMock: { speak: vi.fn(), stop: vi.fn(), isSpeaking: false },
  a11yState: { textSize: 'medium', audioEnabled: false, speechRate: 1.2 },
}))

vi.mock('../../utils/announcer', () => ({ announce: mockAnnounce }))
vi.mock('../../lib/serverApi', () => ({ serverPost: mockServerPost }))
vi.mock('../../services/ttsService', () => ({ default: ttsMock }))
vi.mock('../../contexts/AccessibilityContext', () => ({
  useAccessibility: () => a11yState,
}))

import SceneActions from './SceneActions'
import { applyOperation } from '../../lib/editor/sceneEditOps'

// The app clip shape (camelCase) — what Task 3 maps the rendered snake_case
// scene back to (via a clipsById map keyed on scene.id) before handing it here.
const CLIP = { id: 's1', sourceId: 'v1', name: 'Scene 1', startTime: 0, endTime: 6, trimStart: 0, trimEnd: 0 }

// Fixture timeline state the captured opFns run against.
const STATE = {
  clips: [
    { id: 's1', sourceId: 'v1', name: 'Scene 1', startTime: 0, endTime: 6, trimStart: 0, trimEnd: 0 },
    { id: 's2', sourceId: 'v1', name: 'Scene 2', startTime: 6, endTime: 12, trimStart: 0, trimEnd: 0 },
  ],
  captions: [],
  textOverlays: [],
  colour: {},
}

const DESCRIPTIONS = {
  s1: { 1: 'A person stirs a pot.', 2: 'Level two.', 3: 'Level three.' },
}

function makeProps(overrides = {}) {
  return {
    clip: CLIP,
    projectId: 'p1',
    level: 1,
    onLevelChange: vi.fn(),
    descriptions: DESCRIPTIONS,
    isPlaying: false,
    isActiveScene: false,
    onPlayScene: vi.fn(),
    onPlayFromHere: vi.fn(),
    onPause: vi.fn(),
    applyAndSave: vi.fn(() => Promise.resolve()),
    onCreateTask: vi.fn(() => Promise.resolve({ id: 't1' })),
    ...overrides,
  }
}

function renderActions(overrides = {}) {
  const props = makeProps(overrides)
  const utils = render(<SceneActions {...props} />)
  return { props, ...utils }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SceneActions — play controls', () => {
  it('"Play this scene" calls onPlayScene(clip) (bounded)', async () => {
    const { props } = renderActions()
    await userEvent.click(screen.getByRole('button', { name: /play scene, stops at the end of this scene/i }))
    expect(props.onPlayScene).toHaveBeenCalledWith(CLIP)
    expect(props.onPlayFromHere).not.toHaveBeenCalled()
  })

  it('"Play from here" calls onPlayFromHere(clip) (unbounded)', async () => {
    const { props } = renderActions()
    await userEvent.click(screen.getByRole('button', { name: /play the whole video from here/i }))
    expect(props.onPlayFromHere).toHaveBeenCalledWith(CLIP)
    expect(props.onPlayScene).not.toHaveBeenCalled()
  })

  it('while playing, the from-here button toggles to Pause → onPause', async () => {
    const { props } = renderActions({ isPlaying: true })
    await userEvent.click(screen.getByRole('button', { name: /double tap to pause/i }))
    expect(props.onPause).toHaveBeenCalled()
    expect(props.onPlayFromHere).not.toHaveBeenCalled()
  })

  it('when this scene is the active (bounded) playing scene, the scene button pauses it', async () => {
    const { props } = renderActions({ isPlaying: true, isActiveScene: true })
    await userEvent.click(screen.getByRole('button', { name: /pause this scene/i }))
    expect(props.onPause).toHaveBeenCalled()
    expect(props.onPlayScene).not.toHaveBeenCalled()
  })
})

describe('SceneActions — edit by myself', () => {
  it('Delete calls applyAndSave with an opFn that removes the clip BY ID + names the scene', async () => {
    const { props } = renderActions()
    await userEvent.click(screen.getByRole('button', { name: /edit by myself/i }))
    await userEvent.click(screen.getByRole('button', { name: /delete this clip/i }))

    expect(props.applyAndSave).toHaveBeenCalledTimes(1)
    const [opFn, announceText] = props.applyAndSave.mock.calls[0]
    // Run the captured opFn against the fixture state: s1 is removed by id.
    const next = opFn(STATE)
    expect(next.clips.map((c) => c.id)).toEqual(['s2'])
    expect(next.clips.find((c) => c.id === 's1')).toBeUndefined()
    // Announce text names the scene.
    expect(announceText).toMatch(/Scene 1/)
  })

  it('Undo applies a non-rebasable state-replacing op', async () => {
    const { props } = renderActions()
    await userEvent.click(screen.getByRole('button', { name: /edit by myself/i }))
    // Seed the undo stack with a panel-preserving edit (Split keeps the panel
    // open; Delete closes it). The real applyAndSave invokes the opFn, which
    // captures the pre-image; the spy here doesn't, but the contract under
    // test is only the non-rebasable replacement.
    await userEvent.click(screen.getByRole('button', { name: /split this clip/i }))
    props.applyAndSave.mockClear()

    await userEvent.click(screen.getByRole('button', { name: /undo last edit/i }))
    expect(props.applyAndSave).toHaveBeenCalledTimes(1)
    const [, , opts] = props.applyAndSave.mock.calls[0]
    expect(opts).toEqual(expect.objectContaining({ rebasable: false }))
  })
})

describe('SceneActions — ask helper', () => {
  it('submit calls onCreateTask({ text, segmentLabel: clip.name })', async () => {
    const { props } = renderActions()
    await userEvent.click(screen.getByRole('button', { name: /ask helper to edit/i }))
    const panel = screen.getByRole('group', { name: /ask helper/i })
    await userEvent.type(within(panel).getByRole('textbox'), 'brighten this shot')
    await userEvent.click(within(panel).getByRole('button', { name: /send to helper/i }))

    expect(props.onCreateTask).toHaveBeenCalledWith({
      text: 'brighten this shot',
      segmentLabel: 'Scene 1',
    })
  })
})

describe('SceneActions — ask AI to edit (confirm-first)', () => {
  it('happy path: POSTs ai-edit → ConfirmAiEditDialog shows the deterministic sentence → Confirm → applyAndSave with a working opFn', async () => {
    mockServerPost.mockResolvedValueOnce({ op: 'delete', target_clip_id: 's1', summary: 'remove the intro' })
    const { props } = renderActions()

    await userEvent.click(screen.getByRole('button', { name: /ask ai to edit/i }))
    const panel = screen.getByRole('group', { name: /ask ai to edit/i })
    await userEvent.type(within(panel).getByRole('textbox'), 'remove this scene')
    await userEvent.click(within(panel).getByRole('button', { name: /ask ai/i }))

    // POST to the project ai-edit endpoint with { request, clips }.
    expect(mockServerPost).toHaveBeenCalledTimes(1)
    const [path, body] = mockServerPost.mock.calls[0]
    expect(path).toBe('/api/projects/p1/ai-edit')
    expect(body.request).toBe('remove this scene')
    expect(Array.isArray(body.clips)).toBe(true)

    // The modal ConfirmAiEditDialog shows the DETERMINISTIC sentence.
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Delete Scene 1?')).toBeInTheDocument()

    // Confirm → applyAndSave with the proposal opFn.
    await userEvent.click(within(dialog).getByRole('button', { name: /^confirm/i }))
    expect(props.applyAndSave).toHaveBeenCalledTimes(1)
    const [opFn, doneText] = props.applyAndSave.mock.calls[0]
    expect(doneText).toBe('Deleted Scene 1.')
    const next = opFn(STATE)
    expect(next.clips.map((c) => c.id)).toEqual(['s2'])
  })

  it('clarification: speaks/announces it, keeps the panel open, opens no dialog', async () => {
    a11yState.audioEnabled = true
    mockServerPost.mockResolvedValueOnce({ clarification: 'Which scene do you mean?' })
    renderActions()

    await userEvent.click(screen.getByRole('button', { name: /ask ai to edit/i }))
    const panel = screen.getByRole('group', { name: /ask ai to edit/i })
    await userEvent.type(within(panel).getByRole('textbox'), 'edit it')
    await userEvent.click(within(panel).getByRole('button', { name: /ask ai/i }))

    await screen.findByText('Which scene do you mean?')
    expect(mockAnnounce).toHaveBeenCalledWith('Which scene do you mean?')
    expect(ttsMock.speak).toHaveBeenCalled()
    // No confirm dialog; the panel stays open.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: /ask ai to edit/i })).toBeInTheDocument()
    a11yState.audioEnabled = false
  })
})

describe('SceneActions — VQA (Ask AI about scene)', () => {
  it('POSTs to the segment vqa endpoint (rootSegmentId) and announces the answer', async () => {
    mockServerPost.mockResolvedValueOnce({ answer: 'She is stirring soup.' })
    renderActions()

    await userEvent.click(screen.getByRole('button', { name: /ask ai about scene/i }))
    const panel = screen.getByRole('group', { name: /ask ai about scene/i })
    await userEvent.type(within(panel).getByRole('textbox'), 'what is she doing?')
    await userEvent.click(within(panel).getByRole('button', { name: /^ask$/i }))

    expect(mockServerPost).toHaveBeenCalledTimes(1)
    const [path, body] = mockServerPost.mock.calls[0]
    expect(path).toBe('/api/segments/s1/vqa')
    expect(body).toEqual({ question: 'what is she doing?' })

    await screen.findByText('She is stirring soup.')
    expect(mockAnnounce).toHaveBeenCalledWith('She is stirring soup.')
  })

  it('VQA uses rootSegmentId for a split clip id', async () => {
    mockServerPost.mockResolvedValueOnce({ answer: 'A dog.' })
    renderActions({ clip: { ...CLIP, id: 's1-split-123-0' } })

    await userEvent.click(screen.getByRole('button', { name: /ask ai about scene/i }))
    const panel = screen.getByRole('group', { name: /ask ai about scene/i })
    await userEvent.type(within(panel).getByRole('textbox'), 'q?')
    await userEvent.click(within(panel).getByRole('button', { name: /^ask$/i }))

    expect(mockServerPost.mock.calls[0][0]).toBe('/api/segments/s1/vqa')
  })
})
