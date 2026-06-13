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

  it('analysing: announces via aria-live WITHOUT role="status" (no role-name chatter)', () => {
    render(<AIAnalysisTriggerCard status="analysing" role="creator" />)
    const msg = screen.getByText(/analysing/i)
    // It is a live region (announced) but carries no role="status" (which would
    // make VoiceOver speak the literal word "status").
    const liveRegion = msg.closest('[aria-live="polite"]')
    expect(liveRegion).not.toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('done (creator): summarises the count as a visual, non-live summary (no double-announce)', () => {
    render(<AIAnalysisTriggerCard status="done" role="creator" suggestionCount={3} />)
    expect(screen.getByText(/3 suggestions now showing/i)).toBeInTheDocument()
    // The done card is NOT a live region — the completion is announced once by
    // EditorPage, so this must not be role="status".
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('done (creator): singular count reads "1 suggestion"', () => {
    render(<AIAnalysisTriggerCard status="done" role="creator" suggestionCount={1} />)
    expect(screen.getByText(/1 suggestion now showing/i)).toBeInTheDocument()
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
