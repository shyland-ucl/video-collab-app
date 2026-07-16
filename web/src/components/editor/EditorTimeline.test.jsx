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
