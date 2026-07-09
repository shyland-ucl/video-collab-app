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

// Mock the speech-recognition hook so jsdom never touches the Web Speech API.
// VoiceComposer (used by all three composers) is the only consumer; we return
// an idle, no-op shape so the text-input path the existing tests drive is
// unaffected and the mic button still renders. We capture each mount's options
// (keyed by announcement, which is per-surface) so a test can drive a voice
// `onResult` into a specific composer (e.g. the Ask-Helper task composer).
const speechHook = vi.hoisted(() => ({ byAnnouncement: {} }))
vi.mock('../../hooks/useSpeechRecognition', () => ({
  default: (options) => {
    if (options?.announcement) speechHook.byAnnouncement[options.announcement] = options
    return { isListening: false, isPreparing: false, toggleListening: vi.fn() }
  },
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
    index: 0,
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
  speechHook.byAnnouncement = {}
})

describe('SceneActions — play controls', () => {
  it('"Play this scene" calls onPlayScene(clip) (bounded)', async () => {
    const { props } = renderActions()
    await userEvent.click(screen.getByRole('button', { name: /play scene 1, stops at the end of this scene/i }))
    expect(props.onPlayScene).toHaveBeenCalledWith(CLIP)
    expect(props.onPlayFromHere).not.toHaveBeenCalled()
  })

  it('the Play-this-scene aria-label includes the scene number (Fix E)', () => {
    renderActions({ index: 2 })
    // index 2 → "Play scene 3, …" (scene number restored).
    expect(
      screen.getByRole('button', { name: /^play scene 3, stops at the end of this scene$/i })
    ).toBeInTheDocument()
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
  it('Delete calls applyAndSave with an opFn that removes the clip BY ID', async () => {
    const { props } = renderActions()
    await userEvent.click(screen.getByRole('button', { name: /edit by myself/i }))
    await userEvent.click(screen.getByRole('button', { name: /delete this clip/i }))

    expect(props.applyAndSave).toHaveBeenCalledTimes(1)
    const [opFn, announceText] = props.applyAndSave.mock.calls[0]
    // Run the captured opFn against the fixture state: s1 is removed by id.
    const next = opFn(STATE)
    expect(next.clips.map((c) => c.id)).toEqual(['s2'])
    expect(next.clips.find((c) => c.id === 's1')).toBeUndefined()
    // No post-save announceText for delete — the creator's confirmation is the
    // immediate local announce (Fix B); applyAndSave's text would be a SECOND
    // read for the creator, so it is empty.
    expect(announceText).toBe('')
  })

  it('Delete announces exactly ONCE, scene-numbered, with no second post-save read (Fix B)', async () => {
    renderActions({ index: 0 })
    await userEvent.click(screen.getByRole('button', { name: /edit by myself/i }))
    await userEvent.click(screen.getByRole('button', { name: /delete this clip/i }))

    // Exactly one announcement, with the probe wording.
    expect(mockAnnounce).toHaveBeenCalledTimes(1)
    expect(mockAnnounce).toHaveBeenCalledWith('Scene 1 removed from the edit.')
  })

  it('Split immediately announces "Scene N trimmed at this point." (Fix A)', async () => {
    renderActions({ index: 2 })
    await userEvent.click(screen.getByRole('button', { name: /edit by myself/i }))
    await userEvent.click(screen.getByRole('button', { name: /trim this scene at the current position/i }))
    expect(mockAnnounce).toHaveBeenCalledWith('Scene 3 trimmed at this point.')
  })

  it('the Trim button reads "Trim here" with an explanation + clip-count line', async () => {
    renderActions()
    await userEvent.click(screen.getByRole('button', { name: /edit by myself/i }))
    // Button label is "Trim here" (probe wording), not the bare "Split".
    const trim = screen.getByRole('button', { name: /trim this scene at the current position — splits it into two clips/i })
    expect(trim).toHaveTextContent('Trim here')
    expect(screen.queryByRole('button', { name: /^split this clip/i })).not.toBeInTheDocument()
    // Explanatory copy + live clip-count (1 clip for an unsplit scene).
    expect(screen.getByText(/it splits into two clips/i)).toBeInTheDocument()
    expect(screen.getByText(/this scene currently has 1 clip\./i)).toBeInTheDocument()
  })

  it('the clip-count line reflects multiple clips after a split (allClips has split halves)', async () => {
    // allClips carries s1 + its split half → the scene spans 2 clips.
    renderActions({
      allClips: [
        { id: 's1', name: 'Scene 1', startTime: 0, endTime: 3, trimStart: 0, trimEnd: 0 },
        { id: 's1-split-123-a', name: 'Scene 1', startTime: 3, endTime: 6, trimStart: 0, trimEnd: 0 },
        { id: 's2', name: 'Scene 2', startTime: 6, endTime: 12, trimStart: 0, trimEnd: 0 },
      ],
    })
    await userEvent.click(screen.getByRole('button', { name: /edit by myself/i }))
    expect(screen.getByText(/this scene currently has 2 clips\./i)).toBeInTheDocument()
  })

  it('Move earlier immediately announces "Scene N moved earlier." (Fix A)', async () => {
    renderActions({ index: 0 })
    await userEvent.click(screen.getByRole('button', { name: /edit by myself/i }))
    await userEvent.click(screen.getByRole('button', { name: /move this clip earlier/i }))
    expect(mockAnnounce).toHaveBeenCalledWith('Scene 1 moved earlier.')
  })

  it('Move later immediately announces "Scene N moved later." (Fix A)', async () => {
    renderActions({ index: 1 })
    await userEvent.click(screen.getByRole('button', { name: /edit by myself/i }))
    await userEvent.click(screen.getByRole('button', { name: /move this clip later/i }))
    expect(mockAnnounce).toHaveBeenCalledWith('Scene 2 moved later.')
  })

  it('Add caption immediately announces "Caption added to scene N." (Fix A)', async () => {
    renderActions({ index: 0 })
    await userEvent.click(screen.getByRole('button', { name: /edit by myself/i }))
    await userEvent.click(screen.getByRole('button', { name: /add a caption to this scene/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /caption text/i }), 'a caption')
    await userEvent.click(screen.getByRole('button', { name: /save caption/i }))
    expect(mockAnnounce).toHaveBeenCalledWith('Caption added to scene 1.')
  })

  it('Mute toggle calls applyAndSave with a toggle_mute opFn that sets clip.muted true', async () => {
    const { props } = renderActions()
    await userEvent.click(screen.getByRole('button', { name: /edit by myself/i }))
    await userEvent.click(screen.getByRole('button', { name: /mute the original audio for scene 1/i }))

    expect(props.applyAndSave).toHaveBeenCalledTimes(1)
    const [opFn, announceText] = props.applyAndSave.mock.calls[0]
    // Run the captured opFn against the fixture state: s1 gains muted: true.
    const next = opFn(STATE)
    expect(next.clips.find((c) => c.id === 's1').muted).toBe(true)
    expect(next.clips.find((c) => c.id === 's2').muted).toBeFalsy()
    // Input is never mutated (pure op).
    expect(STATE.clips.find((c) => c.id === 's1').muted).toBeFalsy()
    expect(announceText).toMatch(/muted Scene 1/i)
  })

  it('Mute toggle immediately announces the scene-numbered confirmation', async () => {
    renderActions({ index: 1 })
    await userEvent.click(screen.getByRole('button', { name: /edit by myself/i }))
    await userEvent.click(screen.getByRole('button', { name: /mute the original audio for scene 2/i }))
    expect(mockAnnounce).toHaveBeenCalledWith('Original audio muted on scene 2.')
  })

  it('the mute button reads "Unmute original audio" when the clip is already muted', async () => {
    renderActions({ clip: { ...CLIP, muted: true } })
    await userEvent.click(screen.getByRole('button', { name: /edit by myself/i }))
    expect(screen.getByRole('button', { name: /unmute the original audio for scene 1/i })).toBeInTheDocument()
  })

  it('Undo applies a non-rebasable state-replacing op', async () => {
    const { props } = renderActions()
    await userEvent.click(screen.getByRole('button', { name: /edit by myself/i }))
    // Seed the undo stack with a panel-preserving edit (Trim keeps the panel
    // open; Delete closes it). The real applyAndSave invokes the opFn, which
    // captures the pre-image; the spy here doesn't, but the contract under
    // test is only the non-rebasable replacement.
    await userEvent.click(screen.getByRole('button', { name: /trim this scene at the current position/i }))
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

  it('the Ask-Helper composer gets submitOnVoice={false}: a voice result FILLS the field and does NOT send the task yet', async () => {
    const { props } = renderActions()
    await userEvent.click(screen.getByRole('button', { name: /ask helper to edit/i }))
    const panel = screen.getByRole('group', { name: /ask helper/i })

    // Drive a recognised transcript into the helper composer (keyed by its
    // per-surface announcement). submitOnVoice={false} → it fills, not sends.
    const helperOpts = speechHook.byAnnouncement['Speak now. Describe the task for your helper.']
    expect(helperOpts).toBeTruthy()
    act(() => {
      helperOpts.onResult('please trim the long boring intro and brighten it')
    })

    // The transcript is in the box for review; no task created yet (review-before-send).
    expect(props.onCreateTask).not.toHaveBeenCalled()
    expect(within(panel).getByRole('textbox')).toHaveValue('please trim the long boring intro and brighten it')

    // An explicit Send then dispatches the reviewed instruction.
    await userEvent.click(within(panel).getByRole('button', { name: /send to helper/i }))
    expect(props.onCreateTask).toHaveBeenCalledWith({
      text: 'please trim the long boring intro and brighten it',
      segmentLabel: 'Scene 1',
    })
  })

  it('the VQA composer keeps auto-submit (submitOnVoice default): a voice result POSTs immediately', async () => {
    mockServerPost.mockResolvedValueOnce({ answer: 'A red pot.' })
    renderActions()
    await userEvent.click(screen.getByRole('button', { name: /ask ai about scene/i }))

    const vqaOpts = speechHook.byAnnouncement['Speak now. Ask your question.']
    expect(vqaOpts).toBeTruthy()
    await act(async () => {
      vqaOpts.onResult('what colour is the pot?')
    })

    // VQA still auto-submits on voice → it POSTs straight away.
    expect(mockServerPost).toHaveBeenCalledWith('/api/segments/s1/vqa', {
      question: 'what colour is the pot?',
    })
  })
})

describe('SceneActions — voice input present in every composer', () => {
  it('the VQA composer renders a mic (voice input) button', async () => {
    renderActions()
    await userEvent.click(screen.getByRole('button', { name: /ask ai about scene/i }))
    const panel = screen.getByRole('group', { name: /ask ai about scene/i })
    expect(within(panel).getByRole('button', { name: /voice input/i })).toBeInTheDocument()
  })

  it('the Ask-AI-to-Edit composer renders a mic (voice input) button', async () => {
    renderActions()
    await userEvent.click(screen.getByRole('button', { name: /ask ai to edit/i }))
    const panel = screen.getByRole('group', { name: /ask ai to edit/i })
    expect(within(panel).getByRole('button', { name: /voice input/i })).toBeInTheDocument()
  })

  it('the Ask-Helper composer renders a mic (voice input) button', async () => {
    renderActions()
    await userEvent.click(screen.getByRole('button', { name: /ask helper to edit/i }))
    const panel = screen.getByRole('group', { name: /ask helper/i })
    expect(within(panel).getByRole('button', { name: /voice input/i })).toBeInTheDocument()
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

  it('forwards the FULL allClips timeline + focused_clip_id; a proposal targeting a NON-focused clip still validates', async () => {
    // The model targets s2 even though the focused scene is s1 — this must
    // still validate because describeProposal runs against the full allClips.
    mockServerPost.mockResolvedValueOnce({ op: 'delete', target_clip_id: 's2', summary: 'drop scene two' })
    const ALL = STATE.clips // [s1, s2]
    const { props } = renderActions({ allClips: ALL })

    await userEvent.click(screen.getByRole('button', { name: /ask ai to edit/i }))
    const panel = screen.getByRole('group', { name: /ask ai to edit/i })
    await userEvent.type(within(panel).getByRole('textbox'), 'delete the second scene')
    await userEvent.click(within(panel).getByRole('button', { name: /ask ai/i }))

    // The request body carries the WHOLE timeline (not just the focused clip)
    // plus focused_clip_id naming the scene the request came from.
    const [path, body] = mockServerPost.mock.calls[0]
    expect(path).toBe('/api/projects/p1/ai-edit')
    expect(body.focused_clip_id).toBe('s1')
    expect(body.clips.map((c) => c.id)).toEqual(['s1', 's2'])

    // The deterministic sentence names the NON-focused target (validated
    // against allClips, not [clip]).
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Delete Scene 2?')).toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: /^confirm/i }))
    expect(props.applyAndSave).toHaveBeenCalledTimes(1)
    const [opFn, doneText] = props.applyAndSave.mock.calls[0]
    expect(doneText).toBe('Deleted Scene 2.')
    expect(opFn(STATE).clips.map((c) => c.id)).toEqual(['s1'])
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

  it('carries the prior request + clarification when the creator answers a clarifying question', async () => {
    mockServerPost
      .mockResolvedValueOnce({ clarification: 'Which scene would you like to make brighter?' })
      .mockResolvedValueOnce({ op: 'brightness', target_clip_id: 's1', params: { value: 20 }, summary: 'brighten it' })
    renderActions({ allClips: STATE.clips })

    await userEvent.click(screen.getByRole('button', { name: /ask ai to edit/i }))
    const panel = screen.getByRole('group', { name: /ask ai to edit/i })
    await userEvent.type(within(panel).getByRole('textbox'), 'make it brighter')
    await userEvent.click(within(panel).getByRole('button', { name: /ask ai/i }))
    await screen.findByText('Which scene would you like to make brighter?')

    // First request carried no history.
    expect(mockServerPost.mock.calls[0][1].history).toEqual([])

    // Answer the clarifying question in the same (now-cleared) box.
    await userEvent.type(within(panel).getByRole('textbox'), 'scene 1')
    await userEvent.click(within(panel).getByRole('button', { name: /ask ai/i }))

    expect(mockServerPost).toHaveBeenCalledTimes(2)
    const secondBody = mockServerPost.mock.calls[1][1]
    expect(secondBody.request).toBe('scene 1')
    expect(secondBody.history).toEqual([
      { request: 'make it brighter', clarification: 'Which scene would you like to make brighter?' },
    ])
  })

  it('resets the clarification history when the panel is closed and reopened (a fresh exchange)', async () => {
    mockServerPost
      .mockResolvedValueOnce({ clarification: 'Which scene do you mean?' })
      .mockResolvedValueOnce({ clarification: 'Which scene do you mean?' })
    renderActions({ allClips: STATE.clips })

    await userEvent.click(screen.getByRole('button', { name: /ask ai to edit/i }))
    let panel = screen.getByRole('group', { name: /ask ai to edit/i })
    await userEvent.type(within(panel).getByRole('textbox'), 'edit it')
    await userEvent.click(within(panel).getByRole('button', { name: /ask ai/i }))
    await screen.findByText('Which scene do you mean?')

    // Close then reopen the panel — the next request starts a clean exchange.
    await userEvent.click(screen.getByRole('button', { name: /close ai edit/i }))
    await userEvent.click(screen.getByRole('button', { name: /ask ai to edit/i }))
    panel = screen.getByRole('group', { name: /ask ai to edit/i })
    await userEvent.type(within(panel).getByRole('textbox'), 'do something else')
    await userEvent.click(within(panel).getByRole('button', { name: /ask ai/i }))

    expect(mockServerPost.mock.calls[1][1].history).toEqual([])
  })

  it('an AI-confirmed edit can be undone, like a self-edit (rebasable:false)', async () => {
    mockServerPost.mockResolvedValueOnce({ op: 'delete', target_clip_id: 's1', summary: 'remove the intro' })
    const { props } = renderActions({ allClips: STATE.clips })

    await userEvent.click(screen.getByRole('button', { name: /ask ai to edit/i }))
    const panel = screen.getByRole('group', { name: /ask ai to edit/i })
    await userEvent.type(within(panel).getByRole('textbox'), 'delete this scene')
    await userEvent.click(within(panel).getByRole('button', { name: /ask ai/i }))
    const dialog = await screen.findByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^confirm/i }))
    expect(props.applyAndSave).toHaveBeenCalledTimes(1)

    // The AI edit is now on the shared undo stack: open Edit by Myself and undo.
    props.applyAndSave.mockClear()
    await userEvent.click(screen.getByRole('button', { name: /edit by myself/i }))
    const undo = screen.getByRole('button', { name: /undo last edit/i })
    expect(undo).toBeEnabled()
    await userEvent.click(undo)
    expect(props.applyAndSave).toHaveBeenCalledTimes(1)
    const [, , opts] = props.applyAndSave.mock.calls[0]
    expect(opts).toEqual(expect.objectContaining({ rebasable: false }))
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

  it('with audio ON, the VQA answer is announced ONCE and is NOT also spoken via ttsService (Fix D)', async () => {
    a11yState.audioEnabled = true
    mockServerPost.mockResolvedValueOnce({ answer: 'She is stirring soup.' })
    renderActions()

    await userEvent.click(screen.getByRole('button', { name: /ask ai about scene/i }))
    const panel = screen.getByRole('group', { name: /ask ai about scene/i })
    await userEvent.type(within(panel).getByRole('textbox'), 'what is she doing?')
    await userEvent.click(within(panel).getByRole('button', { name: /^ask$/i }))

    await screen.findByText('She is stirring soup.')
    // Single channel: announce reaches the SR; ttsService is NOT used for the
    // answer (it would be a second read for an audio-on BLV user).
    expect(mockAnnounce).toHaveBeenCalledWith('She is stirring soup.')
    expect(mockAnnounce).toHaveBeenCalledTimes(1)
    expect(ttsMock.speak).not.toHaveBeenCalled()
    a11yState.audioEnabled = false
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
