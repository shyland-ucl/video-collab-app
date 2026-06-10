import { useState, useEffect, useRef } from 'react'
import { useSearchParams, Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../contexts/AuthContext'
import { announce } from '../utils/announcer'
import { safeNext } from '../lib/safeNext'

export default function SignInPage() {
  const { session } = useAuth()
  const [params] = useSearchParams()
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState('idle') // idle | sending | sent | error
  const next = safeNext(params.get('next'))
  const confirmRef = useRef(null)

  // Fix 3: capture focus on the confirmation paragraph when the form swaps out
  useEffect(() => {
    if (status === 'sent') {
      confirmRef.current?.focus()
    }
  }, [status])

  if (session) return <Navigate to={next} replace />

  async function handleSubmit(e) {
    e.preventDefault()
    setStatus('sending')
    announce('Sending sign-in link')
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}${next}` },
    })
    if (error) {
      setStatus('error')
      // Fix 4: use friendly copy matching visible text; button keeps focus so
      // announce() is the single announcement channel here
      announce('Something went wrong sending the link. Check the address and try again.')
    } else {
      setStatus('sent')
      // Fix 3: focus on confirmRef speaks the text — no announce() needed here
    }
  }

  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-lg p-4">
      <h1 className="mb-4 text-2xl font-bold">Sign in</h1>
      {status === 'sent' ? (
        // Fix 3: tabIndex={-1} + ref so useEffect can focus it; no role="status"
        // (focus makes the screen reader speak it — a live-region role would double-read)
        <p ref={confirmRef} tabIndex={-1} className="text-lg">
          Check your email — we sent a sign-in link to {email}. Open it on this device.
        </p>
      ) : (
        <form onSubmit={handleSubmit}>
          <label htmlFor="email" className="mb-2 block text-lg">
            Email address
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mb-4 block w-full rounded border border-gray-400 p-3 text-lg"
          />
          <button
            type="submit"
            disabled={status === 'sending'}
            className="min-h-12 w-full rounded bg-blue-700 px-4 py-3 text-lg font-semibold text-white disabled:opacity-50"
          >
            {status === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
          </button>
          {status === 'error' && (
            // Fix 4: no role="alert" — announce() is the channel when button keeps focus
            <p className="mt-3 text-red-700">
              Something went wrong sending the link. Check the address and try again.
            </p>
          )}
        </form>
      )}
    </main>
  )
}
