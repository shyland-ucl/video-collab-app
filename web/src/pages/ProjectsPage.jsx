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
    <main id="main" tabIndex={-1} className="mx-auto max-w-lg p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Your projects</h1>
        <div className="flex items-center gap-2">
          <Link
            to="/settings"
            className="flex min-h-12 items-center rounded border border-gray-400 px-3"
          >
            Settings
          </Link>
          <button onClick={signOut} className="min-h-12 rounded border border-gray-400 px-3">
            Sign out
          </button>
        </div>
      </div>

      <form onSubmit={handleCreate} className="mb-6">
        <label htmlFor="title" className="mb-2 block text-lg">
          New project name
        </label>
        <div className="flex gap-2">
          <input
            id="title"
            required
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="block w-full rounded border border-gray-400 p-3 text-lg"
          />
          <button
            type="submit"
            disabled={creating}
            className="min-h-12 shrink-0 rounded bg-blue-700 px-4 font-semibold text-white disabled:opacity-50"
          >
            Create
          </button>
        </div>
      </form>

      <form onSubmit={handleJoin} className="mb-6">
        <label htmlFor="join-code" className="mb-2 block text-lg">
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
            className="block w-full rounded border border-gray-400 p-3 text-lg tracking-widest"
          />
          <button
            type="submit"
            disabled={joining}
            className="min-h-12 shrink-0 rounded bg-blue-700 px-4 font-semibold text-white disabled:opacity-50"
          >
            Join
          </button>
        </div>
        {joinError && <p className="mt-2 text-red-700">{joinError}</p>}
      </form>

      {error && <p className="mb-4 text-red-700">{error}</p>}
      {projects === null ? (
        <p>Loading projects…</p>
      ) : projects.length === 0 ? (
        <p>No projects yet. Create one above to get started.</p>
      ) : (
        <ul className="space-y-2">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                to={`/projects/${p.id}`}
                className="block min-h-12 rounded border border-gray-300 p-3 text-lg"
              >
                {p.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
