import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { fetchAdminProjects, orderMembers, projectStage, timeAgo } from '../lib/admin'

// Stage pill colours reuse the same tokens as the participant status pills in
// VideosSection, so "failed" reads the same red everywhere in the app.
const STAGE_STYLES = {
  failed: 'bg-danger-soft text-danger',
  processing: 'bg-helper-soft text-helper',
  empty: 'bg-sunken text-ink-soft',
  ready: 'bg-sunken text-ink-soft',
  editing: 'bg-creator-soft text-creator',
  exported: 'bg-brand-soft text-brand-strong',
  unknown: 'bg-sunken text-ink-soft',
}

// A definition pair, not two loose divs: the label and its number stay
// associated for a screen reader (and for a test that asks "what is the Videos
// total?" rather than "what is the third number on the page?").
function Stat({ label, value }) {
  return (
    <div className="rounded-field bg-sunken px-3 py-2">
      <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className="text-lg font-bold tabular-nums">{value}</dd>
    </div>
  )
}

export default function AdminPage() {
  const [rows, setRows] = useState(null) // null = loading
  const [error, setError] = useState(null)
  // Captured once per load so every row on the page measures "ago" from the
  // same instant — a re-render must not reshuffle the wording.
  const [loadedAt, setLoadedAt] = useState(() => Date.now())
  const [query, setQuery] = useState('')

  async function load() {
    try {
      const data = await fetchAdminProjects(supabase)
      setRows(data)
      setLoadedAt(Date.now())
      setError(null)
    } catch (err) {
      setError(err.message)
      setRows([])
    }
  }

  useEffect(() => {
    load()
  }, [])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle || !rows) return rows ?? []
    return rows.filter((r) => {
      const haystack = [r.title, r.owner_email, ...orderMembers(r.members).map((m) => m.email)]
        .join(' ')
        .toLowerCase()
      return haystack.includes(needle)
    })
  }, [rows, query])

  const totals = useMemo(() => {
    const list = rows ?? []
    return {
      projects: list.length,
      people: new Set(list.flatMap((r) => orderMembers(r.members).map((m) => m.email))).size,
      videos: list.reduce((n, r) => n + (r.video_count ?? 0), 0),
      exports: list.reduce((n, r) => n + (r.render_count ?? 0), 0),
      failed: list.filter((r) => (r.videos_failed ?? 0) > 0).length,
    }
  }, [rows])

  return (
    <main id="main" tabIndex={-1} className="page-wide">
      <div className="mb-6 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0">
          <p className="eyebrow">Researcher</p>
          <h1 className="page-title mt-1">Trial dashboard</h1>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <button onClick={load} className="btn btn-ghost flex-1 sm:flex-none">
            Refresh
          </button>
          <Link to="/" className="btn btn-ghost flex-1 sm:flex-none">
            Your projects
          </Link>
        </div>
      </div>

      <p className="alert-readonly mb-5">
        You can view every participant&apos;s project here, but not change any of them — the database
        grants your account read access only.
      </p>

      {error && <p role="alert" className="alert-error mb-4">{error}</p>}

      {rows === null ? (
        <p role="status" className="muted">Loading projects…</p>
      ) : (
        <>
          <dl className="mb-5 grid grid-cols-2 gap-2.5 sm:grid-cols-5">
            <Stat label="Projects" value={totals.projects} />
            <Stat label="People" value={totals.people} />
            <Stat label="Videos" value={totals.videos} />
            <Stat label="Exports" value={totals.exports} />
            <Stat label="Need help" value={totals.failed} />
          </dl>

          <div className="mb-5">
            <label htmlFor="admin-search" className="label">
              Filter by project name or participant email
            </label>
            <input
              id="admin-search"
              type="search"
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="input"
            />
          </div>

          {filtered.length === 0 ? (
            <div className="card p-6 text-center">
              <p className="muted">
                {rows.length === 0
                  ? 'No projects have been created yet.'
                  : 'No project matches that filter.'}
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {filtered.map((r) => {
                const stage = projectStage(r)
                const members = orderMembers(r.members)
                return (
                  <li key={r.project_id} className="card p-4">
                    <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                      <h2 className="min-w-0 break-words text-lg font-bold">
                        <Link to={`/admin/projects/${r.project_id}`} className="link">
                          {r.title}
                        </Link>
                      </h2>
                      <span
                        className={`shrink-0 rounded-full px-3 py-1 text-sm font-semibold ${
                          STAGE_STYLES[stage.key] ?? STAGE_STYLES.unknown
                        }`}
                      >
                        {stage.label}
                      </span>
                    </div>

                    <ul className="mb-2.5 flex flex-wrap gap-1.5">
                      {members.map((m) => (
                        <li
                          key={m.user_id}
                          className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${
                            m.role === 'creator'
                              ? 'border-creator/40 bg-creator-soft text-creator'
                              : 'border-helper/40 bg-helper-soft text-helper'
                          }`}
                        >
                          {m.role === 'creator' ? 'Creator' : 'Helper'}: {m.email}
                        </li>
                      ))}
                    </ul>

                    <p className="text-sm text-ink-soft">
                      <span className="tabular-nums">{r.video_count}</span> video
                      {r.video_count === 1 ? '' : 's'}
                      {r.videos_processing > 0 && ` (${r.videos_processing} processing)`}
                      {r.videos_failed > 0 && ` (${r.videos_failed} failed)`}
                      {' · '}
                      <span className="tabular-nums">{r.state_version}</span> timeline version
                      {r.state_version === 1 ? '' : 's'}
                      {' · '}
                      <span className="tabular-nums">{r.task_count}</span> task
                      {r.task_count === 1 ? '' : 's'}
                      {' · '}
                      <span className="tabular-nums">{r.suggestion_count}</span> AI suggestion
                      {r.suggestion_count === 1 ? '' : 's'}
                      {' · '}
                      <span className="tabular-nums">{r.render_count}</span> export
                      {r.render_count === 1 ? '' : 's'}
                    </p>
                    <p className="mt-1 text-sm text-ink-faint">
                      Last activity {timeAgo(r.last_activity_at, loadedAt)}
                      {' · '}
                      <span className="tabular-nums">{r.event_count}</span> logged action
                      {r.event_count === 1 ? '' : 's'}
                    </p>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </main>
  )
}
