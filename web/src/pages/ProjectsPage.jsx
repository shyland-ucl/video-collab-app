import { useCallback, useEffect, useState } from 'react'
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
  const { user, isAdmin, signOut } = useAuth()
  const [projects, setProjects] = useState(null) // null = loading
  const [title, setTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState(null)

  const navigate = useNavigate()
  const [joinCode, setJoinCode] = useState('')
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState(null)

  // "Your projects" is scoped explicitly rather than leaning on RLS to filter.
  // For a participant the two are identical, but the researcher admin can SELECT
  // every project (migration 0015) — without this filter their own list would
  // fill up with the whole trial. Cross-project visibility belongs on /admin.
  const loadProjects = useCallback(async () => {
    if (!user?.id) return
    const { data: memberships, error: memberErr } = await supabase
      .from('project_members')
      .select('project_id')
      .eq('user_id', user.id)
    if (memberErr) {
      setError(memberErr.message)
      setProjects([])
      return
    }
    const ids = (memberships ?? []).map((m) => m.project_id)
    // Owner is always inserted as a creator-member by the on_project_created
    // trigger, so `ids` normally covers ownership too — the owner_id clause is
    // the belt to that braces, and keeps the filter valid when ids is empty.
    const filters = [`owner_id.eq.${user.id}`]
    if (ids.length > 0) filters.push(`id.in.(${ids.join(',')})`)

    const { data, error } = await supabase
      .from('projects')
      .select('id, title, status, created_at, owner_id')
      .or(filters.join(','))
      .order('created_at', { ascending: false })
    if (error) {
      setError(error.message)
      setProjects([])
    } else {
      setError(null)
      setProjects(data)
    }
  }, [user?.id])

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

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
      <div className="mb-6 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0">
          <p className="eyebrow">Video Collab</p>
          <h1 className="page-title mt-1">Your projects</h1>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          {isAdmin && (
            <Link to="/admin" className="btn btn-ghost flex-1 sm:flex-none">
              Trial dashboard
            </Link>
          )}
          <Link to="/settings" className="btn btn-ghost flex-1 sm:flex-none">
            Settings
          </Link>
          <button onClick={signOut} className="btn btn-ghost flex-1 sm:flex-none">
            Sign out
          </button>
        </div>
      </div>

      <div className="card mb-6 p-5">
        <form onSubmit={handleCreate} className="mb-5">
          <label htmlFor="title" className="label">
            New project name
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="title"
              name="project-title"
              autoComplete="off"
              required
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="input min-w-0 flex-1"
            />
            <button type="submit" disabled={creating} className="btn btn-primary w-full sm:w-auto sm:shrink-0">
              {creating ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>

        <hr className="my-5 border-line" />

        <form onSubmit={handleJoin}>
          <label htmlFor="join-code" className="label">
            Join with a code
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="join-code"
              name="join-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{4}"
              maxLength={4}
              required
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, ''))}
              aria-invalid={Boolean(joinError)}
              aria-describedby={joinError ? 'join-code-error' : undefined}
              spellCheck={false}
              className="input min-w-0 flex-1 text-center tracking-[0.4em]"
            />
            <button type="submit" disabled={joining} className="btn btn-primary w-full sm:w-auto sm:shrink-0">
              {joining ? 'Joining…' : 'Join'}
            </button>
          </div>
          {joinError && <p id="join-code-error" role="alert" className="alert-error mt-3">{joinError}</p>}
        </form>
      </div>

      {error && <p role="alert" className="alert-error mb-4">{error}</p>}
      {projects === null ? (
        <p role="status" className="muted">Loading projects…</p>
      ) : projects.length === 0 ? (
        <div className="card p-6 text-center">
          <p className="muted">No projects yet. Create one above to get started.</p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {projects.map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.id}`} className="row-link flex items-center justify-between gap-3">
                <span className="min-w-0 truncate">{p.title}</span>
                <span aria-hidden="true" className="shrink-0 text-ink-faint">→</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
