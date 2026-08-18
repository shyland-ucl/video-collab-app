import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AccessibilityProvider, useAccessibility } from './AccessibilityContext'

function ThemeProbe() {
  const { theme, setTheme } = useAccessibility()
  return (
    <button type="button" onClick={() => setTheme('hc-dark')}>
      Current theme: {theme}
    </button>
  )
}

function TextSizeProbe() {
  const { textSize, setTextSize } = useAccessibility()
  return (
    <button type="button" onClick={() => setTextSize('large')}>
      Current size: {textSize}
    </button>
  )
}

describe('AccessibilityProvider', () => {
  it('applies the selected text size to the whole document', async () => {
    render(
      <AccessibilityProvider>
        <TextSizeProbe />
      </AccessibilityProvider>,
    )

    expect(document.documentElement.dataset.textSize).toBe('medium')
    await userEvent.click(screen.getByRole('button', { name: /Current size: medium/i }))
    await waitFor(() => expect(document.documentElement.dataset.textSize).toBe('large'))
  })

  it('applies the selected theme to the whole document', async () => {
    render(
      <AccessibilityProvider>
        <ThemeProbe />
      </AccessibilityProvider>,
    )

    // jsdom has no matchMedia, so the OS-preference fallback lands on default
    expect(document.documentElement.dataset.theme).toBe('default')
    await userEvent.click(screen.getByRole('button', { name: /Current theme: default/i }))
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('hc-dark'))
  })
})
