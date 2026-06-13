import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SuggestionItem from './SuggestionItem'

const SUG = { id: 's1', category: 'issue', text: 'Scene one is too dark', related_scene: 0 }

describe('SuggestionItem (unrouted)', () => {
  it('renders the text and the three routing buttons (no dismiss)', () => {
    render(<SuggestionItem suggestion={SUG} helperName="Sam" onRouteSelf={vi.fn()} onRouteHelper={vi.fn()} onRouteAI={vi.fn()} />)
    expect(screen.getByText('Scene one is too dark')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /i'll fix it/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /ask sam to fix it/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /ask ai to fix it/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull()
  })

  it('each button calls its handler once', async () => {
    const self = vi.fn(); const helper = vi.fn(); const ai = vi.fn()
    render(<SuggestionItem suggestion={SUG} onRouteSelf={self} onRouteHelper={helper} onRouteAI={ai} />)
    await userEvent.click(screen.getByRole('button', { name: /i'll fix it/i }))
    await userEvent.click(screen.getByRole('button', { name: /ask helper to fix it/i }))
    await userEvent.click(screen.getByRole('button', { name: /ask ai to fix it/i }))
    expect(self).toHaveBeenCalledTimes(1)
    expect(helper).toHaveBeenCalledTimes(1)
    expect(ai).toHaveBeenCalledTimes(1)
  })
})

describe('SuggestionItem (routed)', () => {
  it('shows the resolution badge with a terse aria-label and hides the buttons', () => {
    render(<SuggestionItem suggestion={SUG} resolution={{ routedTo: 'ai', outcomeStatus: 'applied' }} onRouteSelf={vi.fn()} onRouteHelper={vi.fn()} onRouteAI={vi.fn()} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByLabelText('Routed to AI. applied.')).toBeInTheDocument()
  })

  it('names the helper in the routed-to-helper badge', () => {
    render(<SuggestionItem suggestion={SUG} helperName="Sam" resolution={{ routedTo: 'helper', outcomeStatus: 'pending' }} />)
    expect(screen.getByLabelText('Routed to Sam. pending.')).toBeInTheDocument()
  })

  it('reads "Doing it myself" for a self route', () => {
    render(<SuggestionItem suggestion={SUG} resolution={{ routedTo: 'self', outcomeStatus: 'pending' }} />)
    expect(screen.getByLabelText('Doing it myself. pending.')).toBeInTheDocument()
  })
})
