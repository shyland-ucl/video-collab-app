import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AccessibilityProvider, useAccessibility } from './AccessibilityContext'

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
})
