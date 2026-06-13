import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AIAnalysisTriggerCard from './AIAnalysisTriggerCard'

describe('AIAnalysisTriggerCard', () => {
  it('idle: shows the trigger button and fires onTrigger once', async () => {
    const onTrigger = vi.fn()
    render(<AIAnalysisTriggerCard status="idle" role="creator" onTrigger={onTrigger} />)
    const btn = screen.getByRole('button', { name: /trigger ai analysis/i })
    await userEvent.click(btn)
    expect(onTrigger).toHaveBeenCalledTimes(1)
  })

  it('idle: renders nothing for the helper (creator-only trigger)', () => {
    const { container } = render(<AIAnalysisTriggerCard status="idle" role="helper" onTrigger={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('analysing: shows a polite live-region progress card', () => {
    render(<AIAnalysisTriggerCard status="analysing" role="creator" />)
    const card = screen.getByRole('status')
    expect(card).toHaveAttribute('aria-live', 'polite')
    expect(card).toHaveTextContent(/analysing/i)
  })

  it('done (creator): summarises the suggestion count', () => {
    render(<AIAnalysisTriggerCard status="done" role="creator" suggestionCount={3} />)
    expect(screen.getByRole('status')).toHaveTextContent(/3 suggestions now showing/i)
  })

  it('done (creator): singular count reads "1 suggestion"', () => {
    render(<AIAnalysisTriggerCard status="done" role="creator" suggestionCount={1} />)
    expect(screen.getByRole('status')).toHaveTextContent(/1 suggestion now showing/i)
  })

  it('done (helper): renders a read-only list of the suggestions', () => {
    render(
      <AIAnalysisTriggerCard
        status="done"
        role="helper"
        suggestions={[
          { id: 'a', category: 'issue', text: 'Scene one is dark', related_scene: 0 },
          { id: 'b', category: 'creative', text: 'Add a caption', related_scene: 2 },
        ]}
      />
    )
    const region = screen.getByRole('region', { name: /ai suggestions visible to the creator/i })
    expect(region).toHaveTextContent('Scene one is dark')
    expect(region).toHaveTextContent('Add a caption')
    // helper has no trigger button
    expect(screen.queryByRole('button')).toBeNull()
  })
})
