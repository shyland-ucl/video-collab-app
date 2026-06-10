import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../contexts/AuthContext'
import { announce } from '../utils/announcer'

export default function ProjectsPage() {
  const { user, signOut } = useAuth()
  const [projects, setProjects] = useState(null) // null = loading
  const [title, setTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState(null)

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

  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-lg p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Your projects</h1>
        <button onClick={signOut} className="min-h-12 rounded border border-gray-400 px-3">
          Sign out
        </button>
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
