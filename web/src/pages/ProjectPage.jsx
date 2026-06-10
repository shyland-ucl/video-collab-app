import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../contexts/AuthContext'
import { buildInviteUrl } from '../lib/inviteUrl'
import { announce } from '../utils/announcer'

export default function ProjectPage() {
  const { id } = useParams()
  const { user } = useAuth()
  const [project, setProject] = useState(null)
  const [members, setMembers] = useState([])
  const [inviteLink, setInviteLink] = useState(null)
  const [error, setError] = useState(null)
  const [inviting, setInviting] = useState(false)

  useEffect(() => {
    async function load() {
      const { data: proj, error: projErr } = await supabase
        .from('projects')
        .select('id, title, owner_id')
        .eq('id', id)
        .single()
      if (projErr) {
        setError('Project not found, or you are not a member of it.')
        return
      }
      setProject(proj)
      const { data: mems } = await supabase
        .from('project_members')
        .select('user_id, role, created_at')
        .eq('project_id', id)
      setMembers(mems ?? [])
    }
    load()
  }, [id])

  async function handleInvite() {
    if (inviting) return
    setInviting(true)
    setError(null)
    try {
      const { data, error } = await supabase
        .from('invites')
        .insert({ project_id: id, created_by: user.id })
        .select('token')
        .single()
      if (error) {
        setError('Could not create an invite link. Only the project owner can invite.')
        announce('Could not create invite')
        return
      }
      const url = buildInviteUrl(window.location.origin, data.token)
      setInviteLink(url)
      if (navigator.share) {
        announce('Invite link created. Opening share options.')
        try {
          await navigator.share({ title: 'Join my video project', url })
        } catch {
          /* user cancelled the share sheet — link stays visible below */
        }
      } else {
        try {
          await navigator.clipboard.writeText(url)
          announce('Invite link created and copied to clipboard')
        } catch {
          announce('Invite link created')
        }
      }
    } finally {
      setInviting(false)
    }
  }

  if (error && !project) {
    return (
      <main id="main" tabIndex={-1} className="mx-auto max-w-lg p-4">
        <p className="text-red-700">{error}</p>
        <Link to="/" className="underline">Back to projects</Link>
      </main>
    )
  }
  if (!project) {
    return (
      <main id="main" tabIndex={-1} className="p-4">
        <p>Loading…</p>
      </main>
    )
  }

  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-lg p-4">
      <Link to="/" className="mb-4 inline-block underline">← All projects</Link>
      <h1 className="mb-4 text-2xl font-bold">{project.title}</h1>

      <section aria-labelledby="members-heading" className="mb-6">
        <h2 id="members-heading" className="mb-2 text-xl font-semibold">
          People ({members.length})
        </h2>
        <ul className="space-y-1">
          {members.map((m) => (
            <li key={m.user_id} className="rounded border border-gray-300 p-2">
              {m.role === 'creator' ? 'Creator' : 'Helper'}
              {m.user_id === user?.id ? ' (you)' : ''}
            </li>
          ))}
        </ul>
      </section>

      <button
        onClick={handleInvite}
        disabled={inviting}
        className="min-h-12 w-full rounded bg-blue-700 px-4 py-3 text-lg font-semibold text-white disabled:opacity-50"
      >
        Invite a helper
      </button>
      {error && <p className="mt-3 text-red-700">{error}</p>}
      {inviteLink && (
        <p className="mt-3 break-all rounded border border-gray-300 p-3">
          Share this link with your helper: {inviteLink}
        </p>
      )}
    </main>
  )
}
