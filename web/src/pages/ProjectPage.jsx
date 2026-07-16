import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../contexts/AuthContext'
import { announce } from '../utils/announcer'
import VideosSection from '../components/VideosSection'

export default function ProjectPage() {
  const { id } = useParams()
  const { user } = useAuth()
  const [project, setProject] = useState(null)
  const [members, setMembers] = useState([])
  const [invite, setInvite] = useState(null) // { code, expires_at }
  const [hasReadyVideo, setHasReadyVideo] = useState(false)
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
      const [{ data: mems }, { data: ready }] = await Promise.all([
        supabase
          .from('project_members')
          .select('user_id, role, created_at')
          .eq('project_id', id),
        supabase
          .from('videos')
          .select('id')
          .eq('project_id', id)
          .eq('status', 'ready')
          .limit(1),
      ])
      setMembers(mems ?? [])
      setHasReadyVideo((ready?.length ?? 0) > 0)
    }
    load()
  }, [id])

  async function handleInvite() {
    if (inviting) return
    setInviting(true)
    setError(null)
    try {
      const { data, error } = await supabase.rpc('create_invite', { p_project_id: id })
      if (error || !data?.code) {
        setInvite(null)
        setError('Could not create a code. Only the project owner can invite.')
        announce('Could not create invite code')
        return
      }
      setInvite(data)
      announce(`Invite code created: ${data.code.split('').join(' ')}`)
    } finally {
      setInviting(false)
    }
  }

  if (error && !project) {
    return (
      <main id="main" tabIndex={-1} className="page">
        <p className="alert-error mb-4">{error}</p>
        <Link to="/" className="link-back"><span aria-hidden="true">←</span> Back to projects</Link>
      </main>
    )
  }
  if (!project) {
    return (
      <main id="main" tabIndex={-1} className="page">
        <p role="status" className="muted">Loading…</p>
      </main>
    )
  }

  return (
    <main id="main" tabIndex={-1} className="page">
      <Link to="/" className="link-back mb-3">
        <span aria-hidden="true">←</span> All projects
      </Link>
      <h1 className="page-title mb-6 break-words">{project.title}</h1>

      <section aria-labelledby="members-heading" className="mb-7">
        <h2 id="members-heading" className="section-title mb-2.5">
          People ({members.length})
        </h2>
        <ul className="flex flex-wrap gap-2">
          {members.map((m) => (
            <li
              key={m.user_id}
              className={`rounded-full border px-3.5 py-1.5 text-sm font-semibold shadow-card ${
                m.role === 'creator'
                  ? 'border-violet-300 bg-violet-50 text-violet-800'
                  : 'border-amber-300 bg-amber-50 text-amber-800'
              }`}
            >
              {m.role === 'creator' ? 'Creator' : 'Helper'}
              {m.user_id === user?.id ? ' (you)' : ''}
            </li>
          ))}
        </ul>
      </section>

      <VideosSection projectId={id} />

      {hasReadyVideo && (
        <Link to={`/projects/${id}/edit`} className="btn btn-primary btn-block mb-7">
          Open editor <span aria-hidden="true">→</span>
        </Link>
      )}

      {project.owner_id === user?.id && (
        <div className="card p-5">
          <button onClick={handleInvite} disabled={inviting} className="btn btn-primary btn-block">
            {inviting ? 'Creating code…' : 'Invite a helper'}
          </button>
          {error && <p role="alert" className="alert-error mt-3">{error}</p>}
          {invite && (
            <div className="mt-4 rounded-card border border-brand/25 bg-brand-soft p-5 text-center">
              <p className="eyebrow mb-2">Invite code</p>
              <p className="break-words font-display text-5xl font-bold tracking-[0.3em] text-brand-strong">
                {invite.code}
              </p>
              <p className="muted mt-3">Expires in 15 minutes.</p>
              <p className="muted">Ask your helper to enter this code on their home page.</p>
            </div>
          )}
        </div>
      )}
    </main>
  )
}
