import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { mockSignIn, mockSignUp, mockUseAuth } = vi.hoisted(() => ({
  mockSignIn: vi.fn(),
  mockSignUp: vi.fn(),
  mockUseAuth: vi.fn(),
}))

vi.mock('../lib/supabaseClient', () => ({
  supabase: { auth: { signInWithPassword: mockSignIn, signUp: mockSignUp } },
}))
vi.mock('../contexts/AuthContext', () => ({ useAuth: mockUseAuth }))
vi.mock('../utils/announcer', () => ({ announce: vi.fn() }))

import SignInPage from './SignInPage'
import { announce } from '../utils/announcer'

function renderAt(path = '/signin') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/signin" element={<SignInPage />} />
        <Route path="/" element={<p>Home stub</p>} />
        <Route path="/projects/:id" element={<p>Project stub</p>} />
      </Routes>
    </MemoryRouter>
  )
}

async function fillAndSubmit(email, password, buttonName) {
  await userEvent.type(screen.getByLabelText('Email address'), email)
  await userEvent.type(screen.getByLabelText('Password'), password)
  await userEvent.click(screen.getByRole('button', { name: buttonName }))
}

describe('SignInPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseAuth.mockReturnValue({ session: null })
  })

  it('renders the email + password sign-in form by default', () => {
    renderAt()
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByLabelText('Email address')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'First time here? Create your password' })
    ).toBeInTheDocument()
  })

  it('signs in with email and password', async () => {
    mockSignIn.mockResolvedValue({ data: {}, error: null })
    renderAt()
    await fillAndSubmit('a@b.com', 'secret123', 'Sign in')
    expect(mockSignIn).toHaveBeenCalledWith({ email: 'a@b.com', password: 'secret123' })
  })

  it('redirects to the sanitized next target when a session exists', () => {
    mockUseAuth.mockReturnValue({ session: { user: { id: 'u1' } } })
    renderAt('/signin?next=/projects/p1')
    expect(screen.getByText('Project stub')).toBeInTheDocument()
  })

  it('falls back to home for unsafe next values', () => {
    mockUseAuth.mockReturnValue({ session: { user: { id: 'u1' } } })
    renderAt('/signin?next=//evil.com')
    expect(screen.getByText('Home stub')).toBeInTheDocument()
  })

  it('switches to create mode, focuses email, announces, and signs up', async () => {
    mockSignUp.mockResolvedValue({ data: {}, error: null })
    renderAt()
    await userEvent.click(
      screen.getByRole('button', { name: 'First time here? Create your password' })
    )
    expect(screen.getByRole('heading', { name: 'Create your password' })).toBeInTheDocument()
    expect(screen.getByLabelText('Email address')).toHaveFocus()
    expect(announce).toHaveBeenCalledWith('Create your password')
    await fillAndSubmit('new@b.com', 'secret123', 'Create password and sign in')
    expect(mockSignUp).toHaveBeenCalledWith({ email: 'new@b.com', password: 'secret123' })
  })

  it('shows wrong-password message assertively on invalid credentials', async () => {
    mockSignIn.mockResolvedValue({
      data: null,
      error: { code: 'invalid_credentials', message: 'Invalid login credentials' },
    })
    renderAt()
    await fillAndSubmit('a@b.com', 'wrongpass', 'Sign in')
    expect(await screen.findByText('Wrong email or password.')).toBeInTheDocument()
    expect(announce).toHaveBeenCalledWith('Wrong email or password.', { assertive: true })
  })

  it('maps the allowlist trigger rejection on signup', async () => {
    mockSignUp.mockResolvedValue({
      data: null,
      error: { code: 'unexpected_failure', message: 'Database error saving new user' },
    })
    renderAt()
    await userEvent.click(
      screen.getByRole('button', { name: 'First time here? Create your password' })
    )
    await fillAndSubmit('rogue@b.com', 'secret123', 'Create password and sign in')
    expect(
      await screen.findByText('This email is not on the allowed list.')
    ).toBeInTheDocument()
    expect(announce).toHaveBeenCalledWith('This email is not on the allowed list.', {
      assertive: true,
    })
  })

  it.each([
    ['user_already_exists', 'This email already has an account — sign in instead.'],
    ['weak_password', 'Password must be at least 6 characters.'],
    ['some_unknown_code', 'Could not sign you in. Please try again.'],
  ])('signup error %s shows its message', async (code, message) => {
    mockSignUp.mockResolvedValue({ data: null, error: { code, message: 'x' } })
    renderAt()
    await userEvent.click(
      screen.getByRole('button', { name: 'First time here? Create your password' })
    )
    await fillAndSubmit('a@b.com', 'secret123', 'Create password and sign in')
    expect(await screen.findByText(message)).toBeInTheDocument()
  })

  it('disables the submit button while a request is in flight', async () => {
    mockSignIn.mockReturnValue(new Promise(() => {})) // never resolves
    renderAt()
    await fillAndSubmit('a@b.com', 'secret123', 'Sign in')
    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled()
  })
})
