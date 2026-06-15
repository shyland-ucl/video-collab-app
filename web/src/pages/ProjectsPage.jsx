import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../contexts/AuthContext'
import { announce } from '../utils/announcer'

const JOIN_ERRORS = {
  invalid_code: "That code didn't work. Check the digits and try again.",
  expired_code: 'This code has expired. Ask for a new one.',
  too_many_attempts: 'Too many tries. Please wait 15 minutes.',
}

export default function ProjectsPage() {
  const { user, signOut } = useAuth()
  const [projects, setProjects] = useState(null) // null = loading
  const [title, setTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState(null)

  const navigate = useNavigate()
  const [joinCode, setJoinCode] = useState('')
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState(null)

  async function loadProjects() {
    const { data, error } = await supabase
      .from('projects')
      .select('id, title, status, created_at, owner_id')
      .order('created_at', { ascending: false })
    if (error) {
      setError(error.message)
      setProjects([])
    } else {
      setError(null)
      setProjects(data)
    }
  }

  useEffect(() => {
    loadProjects()
  }, [])

  async function handleCreate(e) {
    e.preventDefault()
    setError(null)
    setCreating(true)
    const { data, error } = await supabase
      .from('projects')
      .insert({ title, owner_id: user.id })
      .select()
      .single()
    setCreating(false)
    if (error) {
      setError(error.message)
      announce('Could not create project')
      return
    }
    setTitle('')
    announce(`Project ${data.title} created`)
    loadProjects()
  }

  async function handleJoin(e) {
    e.preventDefault()
    if (joining) return
    if (joinCode.length !== 4) {
      setJoinError('Enter all 4 digits of the code.')
      announce('Enter all 4 digits of the code.', { assertive: true })
      return
    }
    setJoining(true)
    setJoinError(null)
    const { data, error } = await supabase.rpc('redeem_code', { p_code: joinCode })
    setJoining(false)
    if (error || !data?.ok) {
      const message =
        JOIN_ERRORS[data?.reason] ?? 'Could not join the project. Please try again.'
      setJoinError(message)
      announce(message, { assertive: true })
      return
    }
    setJoinCode('')
    announce('Joined project')
    navigate(`/projects/${data.project_id}`)
  }

  return (
    <main id="main" tabIndex={-1} className="page">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <p className="eyebrow">Video Collab</p>
          <h1 className="page-title mt-1">Your projects</h1>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/settings" className="btn btn-ghost">
            Settings
          </Link>
          <button onClick={signOut} className="btn btn-ghost">
            Sign out
          </button>
        </div>
      </div>

      <div className="card mb-6 p-5">
        <form onSubmit={handleCreate} className="mb-5">
          <label htmlFor="title" className="label">
            New project name
          </label>
          <div className="flex gap-2">
            <input
              id="title"
              required
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="input"
            />
            <button type="submit" disabled={creating} className="btn btn-primary shrink-0">
              Create
            </button>
          </div>
        </form>

        <hr className="my-5 border-line" />

        <form onSubmit={handleJoin}>
          <label htmlFor="join-code" className="label">
            Join with a code
          </label>
          <div className="flex gap-2">
            <input
              id="join-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{4}"
              maxLength={4}
              required
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, ''))}
              className="input text-center tracking-[0.4em]"
            />
            <button type="submit" disabled={joining} className="btn btn-primary shrink-0">
              Join
            </button>
          </div>
          {joinError && <p className="alert-error mt-3">{joinError}</p>}
        </form>
      </div>

      {error && <p className="alert-error mb-4">{error}</p>}
      {projects === null ? (
        <p className="muted">Loading projects…</p>
      ) : projects.length === 0 ? (
        <div className="card p-6 text-center">
          <p className="muted">No projects yet. Create one above to get started.</p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {projects.map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.id}`} className="row-link flex items-center justify-between gap-3">
                <span className="truncate">{p.title}</span>
                <span aria-hidden="true" className="text-ink-faint">→</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
