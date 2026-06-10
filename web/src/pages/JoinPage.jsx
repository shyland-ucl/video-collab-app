import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../contexts/AuthContext'
import { announce } from '../utils/announcer'

export default function JoinPage() {
  const { token } = useParams()
  const { session } = useAuth()
  const navigate = useNavigate()
  const [error, setError] = useState(null)
  const redeeming = useRef(false)

  useEffect(() => {
    if (!session || redeeming.current) return
    redeeming.current = true
    supabase.rpc('redeem_invite', { invite_token: token }).then(({ data, error }) => {
      if (error) {
        const messages = {
          invalid_invite: 'This invite link is not valid.',
          expired_invite: 'This invite link has expired. Ask for a new one.',
          used_invite: 'This invite link was already used by someone else.',
        }
        const key = Object.keys(messages).find((k) => error.message.includes(k))
        setError(messages[key] ?? 'Could not join the project. Please try again.')
        announce('Could not join the project')
      } else {
        announce('Joined project')
        navigate(`/projects/${data}`, { replace: true })
      }
    })
  }, [session, token, navigate])

  if (session === undefined) return null
  if (session === null) {
    return <Navigate to={`/signin?next=${encodeURIComponent(`/join/${token}`)}`} replace />
  }
  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-lg p-4">
      {error ? (
        <>
          <p className="mb-4 text-red-700">{error}</p>
          <Link to="/" className="underline">Go to your projects</Link>
        </>
      ) : (
        <p className="text-lg">Joining project…</p>
      )}
    </main>
  )
}
