import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import {
  fetchProjectEvents,
  fetchUserEmails,
  formatBytes,
  formatDuration,
  orderMembers,
  timeAgo,
} from '../lib/admin'
import { loadLatestState } from '../lib/editor/stateStore'
import { renderDownloadUrl } from '../lib/editor/rendersApi'

// A read-only observation view of one participant project. Deliberately NOT the
// editor: the editor is built to mutate, and threading a disabled flag through
// it would leave the researcher one mis-click from writing to trial data. This
// page only ever SELECTs — the database would refuse a write anyway, but the
// separation means there is no write path to refuse.

const VIDEO_STATUS_STYLES = {
  uploading: 'bg-sunken text-ink-soft',
  processing: 'bg-helper-soft text-helper',
  ready: 'bg-brand-soft text-brand-strong',
  failed: 'bg-danger-soft text-danger',
}

const TASK_STATUS_LABELS = {
  pending: 'Pending',
  done: 'Done',
  needs_discussion: 'Needs discussion',
  cant_do: "Can't do",
}

const ROUTED_LABELS = { self: 'Did it themselves', helper: 'Sent to helper', ai: 'Asked AI' }

function Section({ title, count, children }) {
  const id = `sec-${title.toLowerCase().replace(/\W+/g, '-')}`
  return (
    <section aria-labelledby={id} className="mb-7">
      <h2 id={id} className="section-title mb-2.5">
        {title}
        {count !== undefined && <span className="ml-2 font-normal text-ink-faint">({count})</span>}
      </h2>
      {children}
    </section>
  )
}

function Empty({ children }) {
  return <p className="muted text-sm">{children}</p>
}

export default function AdminProjectPage() {
  const { id } = useParams()
  const [data, setData] = useState(null) // null = loading
  const [error, setError] = useState(null)
  // { id, url } for the newest READY render, which is not necessarily the
  // newest render — a failed re-export must not hide the working one.
  const [download, setDownload] = useState(null)
  const [loadedAt, setLoadedAt] = useState(() => Date.now())

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const { data: project, error: projErr } = await supabase
          .from('projects')
          .select('id, title, status, owner_id, created_at')
          .eq('id', id)
          .single()
        if (projErr || !project) throw new Error('Project not found.')

        const [members, videos, tasks, suggestions, renders, latestState, events] = await Promise.all([
          supabase.from('project_members').select('user_id, role, created_at').eq('project_id', id),
          supabase
            .from('videos')
            .select(
              'id, original_name, status, error, duration_seconds, width, height, size_bytes, uploaded_by, created_at'
            )
            .eq('project_id', id)
            .order('created_at', { ascending: true }),
          supabase
            .from('tasks')
            .select('id, text, segment_label, status, created_by, created_at, updated_at')
            .eq('project_id', id)
            .order('created_at', { ascending: true }),
          supabase
            .from('suggestions')
            .select('id, category, text, related_scene, routed_to, outcome_status, created_at')
            .eq('project_id', id)
            .order('created_at', { ascending: true }),
          supabase
            .from('renders')
            .select('id, status, output_path, error, edl_version, created_by, created_at')
            .eq('project_id', id)
            .order('created_at', { ascending: false }),
          loadLatestState(supabase, id),
          fetchProjectEvents(supabase, id),
        ])

        // Every user id the page will print, resolved to an email in one call.
        const ids = [
          project.owner_id,
          ...(members.data ?? []).map((m) => m.user_id),
          ...(videos.data ?? []).map((v) => v.uploaded_by),
          ...(tasks.data ?? []).map((t) => t.created_by),
          ...(renders.data ?? []).map((r) => r.created_by),
        ]
        const emails = await fetchUserEmails(supabase, ids)

        if (cancelled) return
        setData({
          project,
          members: members.data ?? [],
          videos: videos.data ?? [],
          tasks: tasks.data ?? [],
          suggestions: suggestions.data ?? [],
          renders: renders.data ?? [],
          state: latestState,
          events,
          emails,
        })
        setLoadedAt(Date.now())

        const ready = (renders.data ?? []).find((r) => r.status === 'ready' && r.output_path)
        if (ready) {
          renderDownloadUrl(supabase, ready.output_path)
            .then((url) => {
              if (!cancelled && url) setDownload({ id: ready.id, url })
            })
            .catch(() => {})
        }
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [id])

  if (error) {
    return (
      <main id="main" tabIndex={-1} className="page-wide">
        <p className="alert-error mb-4">{error}</p>
        <Link to="/admin" className="link-back">
          <span aria-hidden="true">←</span> Trial dashboard
        </Link>
      </main>
    )
  }
  if (!data) {
    return (
      <main id="main" tabIndex={-1} className="page-wide">
        <p role="status" className="muted">Loading project…</p>
      </main>
    )
  }

  const { project, members, videos, tasks, suggestions, renders, state, events, emails } = data
  const who = (userId) => emails.get(userId) ?? (userId ? `${String(userId).slice(0, 8)}…` : 'unknown')
  const clips = state?.state?.clips ?? []
  const captions = state?.state?.captions ?? []
  const overlays = state?.state?.textOverlays ?? []
  const colourKeys = Object.keys(state?.state?.colour ?? {})
  const videoName = new Map(videos.map((v) => [v.id, v.original_name]))

  return (
    <main id="main" tabIndex={-1} className="page-wide">
      <Link to="/admin" className="link-back mb-3">
        <span aria-hidden="true">←</span> Trial dashboard
      </Link>
      <h1 className="page-title mb-2 break-words">{project.title}</h1>
      <p className="muted mb-4 text-sm">
        Owner {who(project.owner_id)} · created {new Date(project.created_at).toLocaleString()} ·{' '}
        {project.status}
      </p>
      <p className="alert-readonly mb-6">Read-only researcher view. Nothing on this page can be changed.</p>

      <Section title="People" count={members.length}>
        <ul className="flex flex-wrap gap-2">
          {members.map((m) => (
            <li
              key={m.user_id}
              className={`rounded-full border px-3.5 py-1.5 text-sm font-semibold ${
                m.role === 'creator'
                  ? 'border-creator/40 bg-creator-soft text-creator'
                  : 'border-helper/40 bg-helper-soft text-helper'
              }`}
            >
              {m.role === 'creator' ? 'Creator' : 'Helper'}: {who(m.user_id)}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Videos" count={videos.length}>
        {videos.length === 0 ? (
          <Empty>Nothing uploaded yet.</Empty>
        ) : (
          <ul className="space-y-2">
            {videos.map((v) => (
              <li key={v.id} className="card p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link to={`/projects/${id}/videos/${v.id}`} className="link min-w-0 break-words">
                    {v.original_name}
                  </Link>
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
                      VIDEO_STATUS_STYLES[v.status] ?? 'bg-sunken text-ink-soft'
                    }`}
                  >
                    {v.status}
                  </span>
                </div>
                <p className="mt-1 text-sm text-ink-faint">
                  {formatDuration(v.duration_seconds)} · {v.width ?? '?'}×{v.height ?? '?'} ·{' '}
                  {formatBytes(v.size_bytes)} · uploaded by {who(v.uploaded_by)}{' '}
                  {timeAgo(v.created_at, loadedAt)}
                </p>
                {v.error && <p className="alert-error mt-2">{v.error}</p>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Timeline">
        {!state ? (
          <Empty>The pair has not opened the editor yet.</Empty>
        ) : (
          <>
            <p className="muted mb-2.5 text-sm">
              Version <span className="tabular-nums">{state.version}</span> · {clips.length} scene
              {clips.length === 1 ? '' : 's'} · {captions.length} caption
              {captions.length === 1 ? '' : 's'} · {overlays.length} text overlay
              {overlays.length === 1 ? '' : 's'} · {colourKeys.length} colour change
              {colourKeys.length === 1 ? '' : 's'}
            </p>
            {clips.length === 0 ? (
              <Empty>The timeline is empty.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase tracking-wide text-ink-faint">
                    <tr>
                      <th scope="col" className="py-1.5 pr-3">Scene</th>
                      <th scope="col" className="py-1.5 pr-3">From video</th>
                      <th scope="col" className="py-1.5 pr-3">In</th>
                      <th scope="col" className="py-1.5 pr-3">Out</th>
                      <th scope="col" className="py-1.5 pr-3">Length</th>
                      <th scope="col" className="py-1.5">Muted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clips.map((c) => {
                      const start = Number(c.startTime) + Number(c.trimStart ?? 0)
                      const end = Number(c.endTime) - Number(c.trimEnd ?? 0)
                      return (
                        <tr key={c.id} className="border-t border-line">
                          <td className="py-1.5 pr-3 font-semibold">{c.name}</td>
                          <td className="py-1.5 pr-3 text-ink-soft">
                            {videoName.get(c.sourceId) ?? '—'}
                          </td>
                          <td className="py-1.5 pr-3 tabular-nums">{formatDuration(start)}</td>
                          <td className="py-1.5 pr-3 tabular-nums">{formatDuration(end)}</td>
                          <td className="py-1.5 pr-3 tabular-nums">{formatDuration(end - start)}</td>
                          <td className="py-1.5">{c.muted ? 'yes' : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Section>

      <Section title="Helper tasks" count={tasks.length}>
        {tasks.length === 0 ? (
          <Empty>No tasks were sent to the helper.</Empty>
        ) : (
          <ul className="space-y-2">
            {tasks.map((t) => (
              <li key={t.id} className="card p-3.5">
                <p className="break-words font-medium">{t.text}</p>
                <p className="mt-1 text-sm text-ink-faint">
                  {TASK_STATUS_LABELS[t.status] ?? t.status}
                  {t.segment_label && ` · ${t.segment_label}`} · from {who(t.created_by)} ·{' '}
                  {timeAgo(t.created_at, loadedAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="AI suggestions" count={suggestions.length}>
        {suggestions.length === 0 ? (
          <Empty>No analysis has been run.</Empty>
        ) : (
          <ul className="space-y-2">
            {suggestions.map((s) => (
              <li key={s.id} className="card p-3.5">
                <p className="break-words">{s.text}</p>
                <p className="mt-1 text-sm text-ink-faint">
                  {s.category} · scene {s.related_scene} ·{' '}
                  {s.routed_to ? (ROUTED_LABELS[s.routed_to] ?? s.routed_to) : 'not answered'}
                  {s.outcome_status && ` · ${s.outcome_status}`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Exports" count={renders.length}>
        {renders.length === 0 ? (
          <Empty>Nothing was exported.</Empty>
        ) : (
          <ul className="space-y-2">
            {renders.map((r) => (
              <li key={r.id} className="card p-3.5">
                <p className="font-medium">
                  {r.status}
                  {r.edl_version != null && ` · from timeline v${r.edl_version}`}
                </p>
                <p className="mt-1 text-sm text-ink-faint">
                  started by {who(r.created_by)} {timeAgo(r.created_at, loadedAt)}
                </p>
                {r.error && <p className="alert-error mt-2">{r.error}</p>}
                {/* Only the newest ready render gets a link: signing every
                    output would be a storage round-trip per row for files the
                    researcher almost never opens. */}
                {download?.id === r.id && (
                  <a href={download.url} target="_blank" rel="noreferrer" className="link mt-2 inline-block">
                    Open the exported video
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Logged actions" count={events.reduce((n, e) => n + (e.event_count ?? 0), 0)}>
        {events.length === 0 ? (
          <Empty>No interaction events recorded.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-ink-faint">
                <tr>
                  <th scope="col" className="py-1.5 pr-3">Action</th>
                  <th scope="col" className="py-1.5 pr-3">Times</th>
                  <th scope="col" className="py-1.5">Last</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.event_type} className="border-t border-line">
                    <td className="py-1.5 pr-3 font-medium">{e.event_type}</td>
                    <td className="py-1.5 pr-3 tabular-nums">{e.event_count}</td>
                    <td className="py-1.5 text-ink-soft">{timeAgo(e.last_at, loadedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </main>
  )
}
