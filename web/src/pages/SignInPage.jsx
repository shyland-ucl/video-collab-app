import { useRef, useState } from 'react'
import { useSearchParams, Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../contexts/AuthContext'
import { announce } from '../utils/announcer'
import { safeNext } from '../lib/safeNext'

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
  }

  function switchMode(nextMode) {
    setMode(nextMode)
    setError(null)
    announce(nextMode === 'create' ? 'Create your password' : 'Sign in')
    emailRef.current?.focus()
  }

  const heading = mode === 'create' ? 'Create your password' : 'Sign in'

  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-lg p-4">
      <h1 className="mb-4 text-2xl font-bold">{heading}</h1>
      <form onSubmit={handleSubmit}>
        <label htmlFor="email" className="mb-2 block text-lg">
          Email address
        </label>
        <input
          id="email"
          ref={emailRef}
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mb-4 block w-full rounded border border-gray-400 p-3 text-lg"
        />
        <label htmlFor="password" className="mb-2 block text-lg">
          Password
        </label>
        <input
          id="password"
          type="password"
          required
          minLength={6}
          autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-4 block w-full rounded border border-gray-400 p-3 text-lg"
        />
        <button
          type="submit"
          disabled={busy}
          className="min-h-12 w-full rounded bg-blue-700 px-4 py-3 text-lg font-semibold text-white disabled:opacity-50"
        >
          {mode === 'create'
            ? busy
              ? 'Creating…'
              : 'Create password and sign in'
            : busy
              ? 'Signing in…'
              : 'Sign in'}
        </button>
        {error && <p className="mt-3 text-red-700">{error}</p>}
      </form>
      {mode === 'create' ? (
        <button
          type="button"
          onClick={() => switchMode('signin')}
          className="mt-4 min-h-12 underline"
        >
          Already have a password? Sign in
        </button>
      ) : (
        <button
          type="button"
          onClick={() => switchMode('create')}
          className="mt-4 min-h-12 underline"
        >
          First time here? Create your password
        </button>
      )}
    </main>
  )
}
