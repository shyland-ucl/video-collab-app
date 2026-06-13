import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import DetailLevelSelector from './DetailLevelSelector'

describe('DetailLevelSelector', () => {
  it('renders the three level targets and reflects currentLevel via aria-pressed', () => {
    render(<DetailLevelSelector currentLevel={1} onLevelChange={vi.fn()} />)

    const overview = screen.getByRole('button', { name: /change to overview description/i })
    const detailed = screen.getByRole('button', { name: /change to detailed description/i })
    const technical = screen.getByRole('button', { name: /change to technical description/i })

    expect(overview).toBeInTheDocument()
    expect(detailed).toBeInTheDocument()
    expect(technical).toBeInTheDocument()

    // currentLevel === 1 (Overview) is the only pressed target.
    expect(overview).toHaveAttribute('aria-pressed', 'true')
    expect(detailed).toHaveAttribute('aria-pressed', 'false')
    expect(technical).toHaveAttribute('aria-pressed', 'false')
  })

  it('aria-pressed tracks a different currentLevel', () => {
    render(<DetailLevelSelector currentLevel={2} onLevelChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: /change to detailed description/i }))
      .toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /change to overview description/i }))
      .toHaveAttribute('aria-pressed', 'false')
  })

  it('activating a level calls onLevelChange with that level value', async () => {
    const onLevelChange = vi.fn()
    render(<DetailLevelSelector currentLevel={1} onLevelChange={onLevelChange} />)

    await userEvent.click(screen.getByRole('button', { name: /change to technical description/i }))
    expect(onLevelChange).toHaveBeenCalledTimes(1)
    expect(onLevelChange).toHaveBeenCalledWith(3)
  })

  it('activation stops propagation — a click on a level does NOT bubble to a parent onClick', async () => {
    const parentClick = vi.fn()
    const onLevelChange = vi.fn()
    render(
      // The probe's unusual SR contract: these roleless-button targets must
      // stop propagation so a TalkBack/VoiceOver double-tap cannot leak to the
      // scene header (the parent) and close the action region.
      <div onClick={parentClick}>
        <DetailLevelSelector currentLevel={1} onLevelChange={onLevelChange} />
      </div>
    )

    await userEvent.click(screen.getByRole('button', { name: /change to detailed description/i }))
    expect(onLevelChange).toHaveBeenCalledWith(2)
    expect(parentClick).not.toHaveBeenCalled()
  })

  it('keyboard Enter / Space activate a level and stop propagation', async () => {
    const parentClick = vi.fn()
    const onLevelChange = vi.fn()
    render(
      <div onClick={parentClick}>
        <DetailLevelSelector currentLevel={1} onLevelChange={onLevelChange} />
      </div>
    )

    const technical = screen.getByRole('button', { name: /change to technical description/i })
    technical.focus()
    await userEvent.keyboard('{Enter}')
    expect(onLevelChange).toHaveBeenLastCalledWith(3)

    const detailed = screen.getByRole('button', { name: /change to detailed description/i })
    detailed.focus()
    await userEvent.keyboard(' ')
    expect(onLevelChange).toHaveBeenLastCalledWith(2)

    expect(parentClick).not.toHaveBeenCalled()
  })
})
