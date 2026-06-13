import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../../../services/ttsService.js', () => ({ default: { stop: vi.fn(), speak: vi.fn() } }))
vi.mock('../../../utils/announcer.js', () => ({ announce: vi.fn() }))

import SceneBlock from './SceneBlock'

const SCENE = { id: 's1', name: 'Scene 1', color: '#E74C3C', start_time: 0, end_time: 5, descriptions: { level_1: 'A pot.' } }

function renderBlock(extra = {}) {
  return render(
    <SceneBlock
      scene={SCENE}
      index={0}
      total={3}
      currentLevel={1}
      isExpanded={false}
      onExpand={vi.fn()}
      onCollapse={vi.fn()}
      {...extra}
    />
  )
}

describe('SceneBlock — AI suggestion indicator (Phase 3b)', () => {
  it('renders the ✨ AI pill and an aria hint when hasSuggestion', () => {
    renderBlock({ hasSuggestion: true })
    expect(screen.getByTitle('Has an AI suggestion')).toBeInTheDocument()
    const header = screen.getByRole('button', { name: /^Scene 1 of 3/i })
    expect(header).toHaveAttribute('aria-label', expect.stringContaining('Has an AI suggestion.'))
  })

  it('omits the pill + hint when hasSuggestion is false', () => {
    renderBlock({ hasSuggestion: false })
    expect(screen.queryByTitle('Has an AI suggestion')).toBeNull()
    const header = screen.getByRole('button', { name: /^Scene 1 of 3/i })
    expect(header.getAttribute('aria-label')).not.toContain('Has an AI suggestion')
  })

  it('does not show the pill on a removed scene', () => {
    renderBlock({ hasSuggestion: true, isRemoved: true })
    expect(screen.queryByTitle('Has an AI suggestion')).toBeNull()
  })
})
