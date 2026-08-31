import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../contexts/AccessibilityContext', () => ({
  useAccessibility: () => ({ audioEnabled: false, speechRate: 1.2 }),
}))
vi.mock('../../utils/announcer', () => ({ announce: vi.fn() }))

import EditorTimeline from './EditorTimeline'

const CLIP = {
  id: 'scene-1',
  sourceId: 'video-1',
  name: 'Scene 1',
  startTime: 0,
  endTime: 4,
  trimStart: 0,
  trimEnd: 0,
  color: '#2563eb',
}

describe('EditorTimeline destructive edits', () => {
  it('confirms helper deletion before applying it', async () => {
    const applyAndSave = vi.fn()
    render(
      <EditorTimeline
        clips={[CLIP]}
        captions={[]}
        sources={[]}
        colour={{}}
        applyAndSave={applyAndSave}
      />,
    )

    await userEvent.click(screen.getByRole('option', { name: /Scene 1/i }))
    await userEvent.click(screen.getByRole('button', { name: 'Delete selected clip' }))

    expect(applyAndSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Delete Scene 1 from the timeline?')

    await userEvent.click(screen.getByRole('button', { name: /^Delete:/ }))

    expect(applyAndSave).toHaveBeenCalledTimes(1)
    const [opFn] = applyAndSave.mock.calls[0]
    expect(opFn({ clips: [CLIP] }).clips).toEqual([])
  })
})

describe('EditorTimeline undo/redo', () => {
  const renderTimeline = (props = {}) =>
    render(
      <EditorTimeline
        clips={[CLIP]}
        captions={[]}
        sources={[]}
        colour={{}}
        applyAndSave={vi.fn()}
        {...props}
      />,
    )

  it('offers undo and redo in the edit toolbar', () => {
    renderTimeline()
    expect(screen.getByRole('button', { name: 'Undo last edit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Redo last undone edit' })).toBeInTheDocument()
  })

  it('disables undo and redo while their histories are empty', () => {
    renderTimeline({ canUndo: false, canRedo: false })
    expect(screen.getByRole('button', { name: 'Undo last edit' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Redo last undone edit' })).toBeDisabled()
  })

  it('reverses the last edit when undo is pressed', async () => {
    const onUndo = vi.fn()
    renderTimeline({ canUndo: true, onUndo })

    await userEvent.click(screen.getByRole('button', { name: 'Undo last edit' }))

    expect(onUndo).toHaveBeenCalledTimes(1)
  })

  it('reapplies the last undone edit when redo is pressed', async () => {
    const onRedo = vi.fn()
    renderTimeline({ canRedo: true, onRedo })

    await userEvent.click(screen.getByRole('button', { name: 'Redo last undone edit' }))

    expect(onRedo).toHaveBeenCalledTimes(1)
  })

  // The helper's timeline edits are the ones undo exists for, so they must go
  // through the recording save, not the plain one.
  it('records a delete on the history by saving it undoably', async () => {
    const applyAndSave = vi.fn()
    const applyAndSaveUndoable = vi.fn()
    renderTimeline({ applyAndSave, applyAndSaveUndoable })

    await userEvent.click(screen.getByRole('option', { name: /Scene 1/i }))
    await userEvent.click(screen.getByRole('button', { name: 'Delete selected clip' }))
    await userEvent.click(screen.getByRole('button', { name: /^Delete:/ }))

    expect(applyAndSaveUndoable).toHaveBeenCalledTimes(1)
    expect(applyAndSave).not.toHaveBeenCalled()
    const [opFn] = applyAndSaveUndoable.mock.calls[0]
    expect(opFn({ clips: [CLIP] }).clips).toEqual([])
  })

  it('records a caption on the history by saving it undoably', async () => {
    const applyAndSaveUndoable = vi.fn()
    renderTimeline({ applyAndSaveUndoable })

    await userEvent.click(screen.getByRole('option', { name: /Scene 1/i }))
    await userEvent.click(screen.getByRole('button', { name: 'Show caption editor' }))
    await userEvent.type(screen.getByRole('textbox', { name: /caption/i }), 'Hello')
    await userEvent.click(screen.getByRole('button', { name: 'Add caption' }))

    expect(applyAndSaveUndoable).toHaveBeenCalledTimes(1)
  })
})
