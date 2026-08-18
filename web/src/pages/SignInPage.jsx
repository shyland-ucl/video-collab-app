import { useRef, useState } from 'react'
import { useSearchParams, Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../contexts/AuthContext'
import { announce } from '../utils/announcer'
import { safeNext } from '../lib/safeNext'
import { logEvent } from '../lib/events'

const AUTH_ERRORS = {
  invalid_credentials: 'Wrong email or password.',
  user_already_exists: 'This email already has an account — sign in instead.',
  weak_password: 'Password must be at least 6 characters.',
}
const NOT_ALLOWED = 'This email is not on the allowed list.'
const GENERIC = 'Could not sign you in. Please try again.'

// The allowlist trigger rejection reaches the client as a generic DB error
// (code unexpected_failure, message "Database error saving new user")
function describeError(error, mode) {
  if (
    mode === 'create' &&
    error.code === 'unexpected_failure' &&
    error.message?.includes('Database error')
  ) {
    return NOT_ALLOWED
  }
  return AUTH_ERRORS[error.code] ?? GENERIC
}

export default function SignInPage() {
  const { session } = useAuth()
  const [params] = useSearchParams()
  const [mode, setMode] = useState('signin') // 'signin' | 'create'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const emailRef = useRef(null)
  const next = safeNext(params.get('next'))

  if (session) return <Navigate to={next} replace />

  async function handleSubmit(e) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    const credentials = { email, password }
    const { data, error } =
      mode === 'create'
        ? await supabase.auth.signUp(credentials)
        : await supabase.auth.signInWithPassword(credentials)
    setBusy(false)
    if (error || !data?.session) {
      const message = error ? describeError(error, mode) : GENERIC
      setError(message)
      announce(message, { assertive: true })
      return
    }
    // success: AuthContext picks up the session and <Navigate> above redirects
    logEvent('sign_in', { mode })
  }

  function switchMode(nextMode) {
    setMode(nextMode)
    setError(null)
    announce(nextMode === 'create' ? 'Create your password' : 'Sign in')
    emailRef.current?.focus()
  }

  const heading = mode === 'create' ? 'Create your password' : 'Sign in'
  const subtitle =
    mode === 'create'
      ? 'Set a password to get started.'
      : 'Welcome back. Sign in to reach your projects.'

  return (
    <main id="main" tabIndex={-1} className="page flex min-h-[100dvh] flex-col justify-center">
      <header className="mb-7 text-center">
        <p className="eyebrow">Video Collab</p>
        <h1 className="page-title mt-2">{heading}</h1>
        <p className="muted mt-1.5">{subtitle}</p>
      </header>

      <div className="card p-6">
        <form onSubmit={handleSubmit}>
          <label htmlFor="email" className="label">
            Email address
          </label>
          <input
            id="email"
            ref={emailRef}
            name="email"
            type="email"
            required
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'auth-error' : undefined}
            className="input mb-4"
          />
          <label htmlFor="password" className="label">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={6}
            autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'auth-error' : undefined}
            className="input mb-5"
          />
          <button type="submit" disabled={busy} className="btn btn-primary btn-block">
            {mode === 'create'
              ? busy
                ? 'Creating…'
                : 'Create password and sign in'
              : busy
                ? 'Signing in…'
                : 'Sign in'}
          </button>
          {error && <p id="auth-error" role="alert" className="alert-error mt-4">{error}</p>}
        </form>
      </div>

      <p className="mt-6 text-center">
        {mode === 'create' ? (
          <button type="button" onClick={() => switchMode('signin')} className="link min-h-11">
            Already have a password? Sign in
          </button>
        ) : (
          <button type="button" onClick={() => switchMode('create')} className="link min-h-11">
            First time here? Create your password
          </button>
        )}
      </p>
    </main>
  )
}
