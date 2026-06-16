import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { mockAnnounce, ttsMock, a11yState } = vi.hoisted(() => ({
  mockAnnounce: vi.fn(),
  ttsMock: { speak: vi.fn(), stop: vi.fn(), isSpeaking: false },
  a11yState: { textSize: 'medium', audioEnabled: false, speechRate: 1.2 },
}))

vi.mock('../../utils/announcer', () => ({ announce: mockAnnounce }))
vi.mock('../../services/ttsService', () => ({ default: ttsMock }))
vi.mock('../../contexts/AccessibilityContext', () => ({
  useAccessibility: () => a11yState,
}))

import ConfirmAiEditDialog, { proposalToOpFn, describeProposal } from './ConfirmAiEditDialog'

const CLIPS = [
  { id: 's1', sourceId: 'v1', name: 'Scene 1', startTime: 0, endTime: 6, trimStart: 0, trimEnd: 0 },
  { id: 's2', sourceId: 'v1', name: 'Scene 2', startTime: 6, endTime: 12, trimStart: 0, trimEnd: 0 },
  { id: 's3', sourceId: 'v2', name: 'Scene 3', startTime: 0, endTime: 4, trimStart: 0, trimEnd: 0 },
]

const STATE = { clips: CLIPS, captions: [], textOverlays: [], colour: {} }

function renderDialog(proposal, props = {}) {
  return render(
    <ConfirmAiEditDialog
      proposal={proposal}
      clips={CLIPS}
      onConfirm={props.onConfirm ?? vi.fn()}
      onCancel={props.onCancel ?? vi.fn()}
    />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  a11yState.audioEnabled = false
})

describe('proposalToOpFn', () => {
  it('maps a delete proposal to an opFn that removes the clip', () => {
    const opFn = proposalToOpFn({ op: 'delete', target_clip_id: 's2', params: {} })
    const next = opFn(STATE)
    expect(next.clips.map((c) => c.id)).toEqual(['s1', 's3'])
    // never mutates the input
    expect(STATE.clips).toHaveLength(3)
  })

  it('maps add_caption with params.caption_text to a real caption', () => {
    const opFn = proposalToOpFn({
      op: 'add_caption',
      target_clip_id: 's1',
      params: { caption_text: 'hello' },
    })
    const next = opFn(STATE)
    expect(next.captions).toHaveLength(1)
    expect(next.captions[0]).toMatchObject({ sceneId: 's1', text: 'hello' })
  })

  it('maps trim_start to the editor 0.5s trim step', () => {
    const opFn = proposalToOpFn({ op: 'trim_start', target_clip_id: 's1', params: {} })
    const next = opFn(STATE)
    expect(next.clips[0].trimStart).toBe(0.5)
  })

  it('is a safe no-op for an unknown op (applyOperation passthrough)', () => {
    const opFn = proposalToOpFn({ op: 'explode', target_clip_id: 's1', params: {} })
    expect(opFn(STATE)).toBe(STATE)
  })
})

describe('describeProposal', () => {
  it('composes deterministic sentences from the op + clip name', () => {
    expect(describeProposal({ op: 'delete', target_clip_id: 's3' }, CLIPS).question).toBe('Delete Scene 3?')
    expect(
      describeProposal({ op: 'add_caption', target_clip_id: 's2', params: { caption_text: 'hello' } }, CLIPS).question
    ).toBe("Add the caption 'hello' to Scene 2?")
    expect(describeProposal({ op: 'trim_start', target_clip_id: 's1' }, CLIPS).question).toBe(
      'Trim half a second off the start of Scene 1?'
    )
    expect(describeProposal({ op: 'trim_end', target_clip_id: 's1' }, CLIPS).question).toBe(
      'Trim half a second off the end of Scene 1?'
    )
    expect(describeProposal({ op: 'split', target_clip_id: 's1' }, CLIPS).question).toBe(
      'Split Scene 1 into two at its midpoint?'
    )
    expect(describeProposal({ op: 'move_earlier', target_clip_id: 's2' }, CLIPS).question).toBe(
      'Move Scene 2 earlier in the timeline?'
    )
    expect(describeProposal({ op: 'move_later', target_clip_id: 's2' }, CLIPS).question).toBe(
      'Move Scene 2 later in the timeline?'
    )
  })

  it('provides a past-tensed sentence for the post-confirm announcement', () => {
    expect(describeProposal({ op: 'delete', target_clip_id: 's3' }, CLIPS).done).toBe('Deleted Scene 3.')
    expect(
      describeProposal({ op: 'add_caption', target_clip_id: 's2', params: { caption_text: 'hello' } }, CLIPS).done
    ).toBe("Added the caption 'hello' to Scene 2.")
    expect(describeProposal({ op: 'trim_start', target_clip_id: 's1' }, CLIPS).done).toBe(
      'Trimmed half a second off the start of Scene 1.'
    )
  })

  it('returns null for an unknown op or a clip that is not in the timeline', () => {
    expect(describeProposal({ op: 'colour_grade', target_clip_id: 's1' }, CLIPS)).toBeNull()
    expect(describeProposal({ op: 'delete', target_clip_id: 'nope' }, CLIPS)).toBeNull()
    expect(describeProposal(null, CLIPS)).toBeNull()
  })
})

describe('ConfirmAiEditDialog', () => {
  it('renders an alertdialog whose primary sentence is the deterministic one, with the AI summary secondary', () => {
    renderDialog({
      op: 'delete',
      target_clip_id: 's2',
      params: {},
      summary: 'I will remove the blurry kitchen shot for you.',
    })

    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByText('Delete Scene 2?')).toBeInTheDocument()
    // Gemini's free text renders as supplementary detail only
    expect(screen.getByText('I will remove the blurry kitchen shot for you.')).toBeInTheDocument()
    expect(dialog).toHaveAttribute('aria-labelledby')
    const labelledBy = dialog.getAttribute('aria-labelledby')
    expect(document.getElementById(labelledBy)).toHaveTextContent('Delete Scene 2?')
  })

  it('announces the deterministic sentence on open — never the AI summary', () => {
    renderDialog({
      op: 'add_caption',
      target_clip_id: 's2',
      params: { caption_text: 'hello' },
      summary: 'Adding a lovely caption.',
    })

    expect(mockAnnounce).toHaveBeenCalledWith("Add the caption 'hello' to Scene 2?", { assertive: true })
    expect(mockAnnounce).not.toHaveBeenCalledWith('Adding a lovely caption.', expect.anything())
  })

  it('speaks the deterministic sentence via TTS when audio is enabled', () => {
    a11yState.audioEnabled = true
    renderDialog({ op: 'delete', target_clip_id: 's1', params: {}, summary: 'whatever' })

    expect(ttsMock.speak).toHaveBeenCalledWith('Delete Scene 1?', { rate: 1.2 })
  })

  it('fires onConfirm / onCancel from the buttons and Escape', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    renderDialog({ op: 'delete', target_clip_id: 's1', params: {} }, { onConfirm, onCancel })

    await userEvent.click(screen.getByRole('button', { name: /confirm/i }))
    expect(onConfirm).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('renders nothing for a proposal it cannot describe', () => {
    renderDialog({ op: 'colour_grade', target_clip_id: 's1', params: {} })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })
})

describe('visual ops routing', () => {
  const clips = [{ id: 's1', name: 'Scene 1', startTime: 0, endTime: 5 }]

  it('describeProposal uses the fix-template sentence for brightness', () => {
    const d = describeProposal({ op: 'brightness', target_clip_id: 's1', params: { value: 30 } }, clips)
    expect(d.question).toBe('Increase the brightness on Scene 1?')
    expect(d.done).toBe('Increased the brightness on Scene 1.')
  })

  it('describeProposal handles zoom and mute', () => {
    expect(describeProposal({ op: 'zoom', target_clip_id: 's1', params: { value: 150 } }, clips).question)
      .toBe('Zoom Scene 1 to 150%?')
    expect(describeProposal({ op: 'mute', target_clip_id: 's1', params: {} }, clips).question)
      .toBe('Mute the original audio on Scene 1?')
  })

  it('proposalToOpFn applies brightness to the scene colour map', () => {
    const opFn = proposalToOpFn({ op: 'brightness', target_clip_id: 's1', params: { value: 30 } })
    const next = opFn({ clips, colour: {} })
    expect(next.colour.s1.brightness).toBe(30)
  })

  it('proposalToOpFn mutes via the existing op', () => {
    const opFn = proposalToOpFn({ op: 'mute', target_clip_id: 's1', params: {} })
    const next = opFn({ clips })
    expect(next.clips.find((c) => c.id === 's1').muted).toBe(true)
  })
})
