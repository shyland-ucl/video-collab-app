import { afterEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import RouteAccessibility from './RouteAccessibility'

function Harness() {
  return (
    <MemoryRouter initialEntries={['/']}>
      <RouteAccessibility />
      <Routes>
        <Route
          path="/"
          element={(
            <main id="main" tabIndex={-1}>
              <h1>Projects</h1>
              <Link to="/settings">Open settings</Link>
            </main>
          )}
        />
        <Route
          path="/settings"
          element={(
            <main id="main" tabIndex={-1} data-testid="settings-main">
              <h1>Settings</h1>
            </main>
          )}
        />
      </Routes>
    </MemoryRouter>
  )
}

afterEach(() => {
  document.title = ''
})

describe('RouteAccessibility', () => {
  it('updates the document title and focuses main after SPA navigation', async () => {
    render(<Harness />)
    expect(document.title).toBe('Projects | Video Collab')

    await userEvent.click(screen.getByRole('link', { name: 'Open settings' }))

    await waitFor(() => expect(document.title).toBe('Settings | Video Collab'))
    const main = screen.getByTestId('settings-main')
    await waitFor(() => expect(document.activeElement).toBe(main))
  })
})
