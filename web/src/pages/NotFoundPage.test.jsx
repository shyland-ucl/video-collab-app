import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import NotFoundPage from './NotFoundPage'

describe('NotFoundPage', () => {
  it('renders a heading and a link back to projects', () => {
    render(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>
    )
    expect(screen.getByRole('heading', { name: /page not found/i })).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /projects/i })
    expect(link).toHaveAttribute('href', '/')
  })
})
