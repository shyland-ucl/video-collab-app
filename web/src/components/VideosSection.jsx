import { useEffect, useRef, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../contexts/AuthContext'
import { uploadVideo } from '../lib/uploadVideo'
import { serverPost } from '../lib/serverApi'
import { announce } from '../utils/announcer'

const STATUS_LABELS = {
  uploading: 'Uploading',
  processing: 'Processing',
  ready: 'Ready',
  failed: 'Failed',
}

// Status pill colours (Calm Clinical tokens + Tailwind amber for "in progress").
const STATUS_STYLES = {
  uploading: 'bg-sunken text-ink-soft',
  processing: 'bg-helper-soft text-helper',
  ready: 'bg-brand-soft text-brand-strong',
  failed: 'bg-danger-soft text-danger',
}

// Fix 4 — friendly error copy for known codes
const ERROR_LABELS = {
  server_not_configured: 'The server is not reachable right now. Please try again later.',
  already_processing: 'This video is already being processed.',
  not_signed_in: 'You are signed out. Sign in again to continue.',
}

function friendlyError(err) {
  const msg = String(err?.message ?? err)
  return ERROR_LABELS[msg] ?? msg
}

const POLL_MS = 4000

export default function VideosSection({ projectId }) {
  const { session, user } = useAuth()
  const [videos, setVideos] = useState(null) // null = loading
  const [progress, setProgress] = useState(null) // null | 0-100
  const [error, setError] = useState(null)
  // Fix 8 — separate state for transient poll failures
  const [listError, setListError] = useState(null)
  const prevStatuses = useRef({})

  const loadVideos = useCallback(async () => {
    const { data, error: loadErr } = await supabase
      .from('videos')
      .select('id, original_name, status, error, created_at, uploaded_by')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
    if (loadErr) {
      setListError(loadErr.message)
      return
    }
    setListError(null)
    for (const v of data) {
      const prev = prevStatuses.current[v.id]
      if (prev && prev !== v.status) {
        if (v.status === 'ready') announce(`${v.original_name} is ready`)
        if (v.status === 'failed') announce(`Processing failed for ${v.original_name}`, { assertive: true })
      }
      prevStatuses.current[v.id] = v.status
    }
    setVideos(data)
  }, [projectId])

  useEffect(() => {
    loadVideos()
  }, [loadVideos])

  const hasActive = (videos ?? []).some((v) => v.status === 'uploading' || v.status === 'processing')
  useEffect(() => {
    if (!hasActive) return undefined
    const timer = setInterval(loadVideos, POLL_MS)
    return () => clearInterval(timer)
  }, [hasActive, loadVideos])

  async function handleFileChange(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    // Fix 6 — client-side 50 MB guard before inserting anything
    if (file.size > 50 * 1024 * 1024) {
      setError('This video is larger than 50 MB. Please record or trim a shorter clip.')
      announce('File too large', { assertive: true })
      return
    }

    setError(null)

    const videoId = crypto.randomUUID()
    const storagePath = `${projectId}/${videoId}/original.mp4`

    const { error: insertErr } = await supabase.from('videos').insert({
      id: videoId,
      project_id: projectId,
      uploaded_by: user.id,
      original_name: file.name,
      storage_path: storagePath,
    })
    if (insertErr) {
      setError(friendlyError(insertErr))
      announce('Upload could not start', { assertive: true })
      return
    }

    announce('Upload started')
    setProgress(0)
    loadVideos()
    // Fix 5 — split tus upload catch from processing-start catch
    try {
      await uploadVideo({
        supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
        accessToken: session.access_token,
        objectName: storagePath,
        file,
        // Fix 3 — throttle progress announcements to deciles
        onProgress: (p) => setProgress(Math.floor(p / 10) * 10),
      })
    } catch (err) {
      setError(friendlyError(err))
      announce('Upload failed', { assertive: true })
      setProgress(null)
      loadVideos()
      return
    }

    try {
      await serverPost(`/api/videos/${videoId}/process`)
      announce('Upload complete. Processing started.')
    } catch (err) {
      setError(friendlyError(err))
      announce('Processing could not start', { assertive: true })
    } finally {
      setProgress(null)
      loadVideos()
    }
  }

  async function handleRetry(video) {
    setError(null)
    try {
      await serverPost(`/api/videos/${video.id}/process`)
      announce(`Processing restarted for ${video.original_name}`)
      loadVideos()
    } catch (err) {
      setError(friendlyError(err))
    }
  }

  return (
    <section aria-labelledby="videos-heading" className="mb-7">
      <h2 id="videos-heading" className="section-title mb-3">
        Videos
      </h2>

      <label htmlFor="video-file" className="label">
        Upload a video (MP4, up to 50 MB)
      </label>
      <input
        id="video-file"
        type="file"
        accept="video/mp4"
        disabled={progress !== null}
        onChange={handleFileChange}
        className="mb-3 block w-full rounded-field border border-line-strong bg-surface p-2.5 text-sm text-ink-soft file:mr-3 file:rounded-field file:border-0 file:bg-brand file:px-4 file:py-2 file:font-semibold file:text-on-brand hover:file:bg-brand-strong disabled:opacity-50"
      />

      {progress !== null && (
        <div role="status" className="mb-3">
          <p className="mb-1.5 text-sm font-semibold text-ink-soft">Uploading… {progress}%</p>
          <div className="h-2 w-full overflow-hidden rounded-full bg-sunken">
            <div
              className="h-full rounded-full bg-brand transition-[width] duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="alert-error mb-3">
          {error}
        </p>
      )}
      {/* Fix 8 — separate alert for transient poll failures */}
      {listError && (
        <p role="alert" className="alert-error mb-3">
          {listError}
        </p>
      )}

      {videos === null ? (
        <p role="status" className="muted">Loading videos…</p>
      ) : videos.length === 0 ? (
        <p className="muted">No videos yet. Upload one above to get started.</p>
      ) : (
        <ul className="space-y-2.5">
          {videos.map((v) => (
            <li key={v.id} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="font-display font-bold">{v.original_name}</p>
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${STATUS_STYLES[v.status] ?? STATUS_STYLES.processing}`}>
                  {STATUS_LABELS[v.status] ?? v.status}
                </span>
              </div>
              {v.status === 'failed' && v.error && (
                <p className="mt-1 text-sm" style={{ color: 'var(--color-danger)' }}>{v.error}</p>
              )}
              {(v.status === 'ready' ||
                v.status === 'failed' ||
                (v.status === 'uploading' && progress === null && v.uploaded_by === user.id)) && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {v.status === 'ready' && (
                    <>
                      <Link
                        to={`/projects/${projectId}/edit?video=${v.id}`}
                        aria-label={`Open ${v.original_name} in the editor`}
                        className="btn btn-primary"
                      >
                        Open in editor →
                      </Link>
                      <Link
                        to={`/projects/${projectId}/videos/${v.id}`}
                        aria-label={`View scenes and descriptions for ${v.original_name}`}
                        className="btn btn-ghost"
                      >
                        View scenes
                      </Link>
                    </>
                  )}
                  {/* Fix 2 — stuck-uploading rows (no in-flight upload) also get Retry;
                      Task 11 — gated to the uploader for uploading status */}
                  {(v.status === 'failed' ||
                    (v.status === 'uploading' && progress === null && v.uploaded_by === user.id)) && (
                    <button
                      onClick={() => handleRetry(v)}
                      aria-label={`Retry processing ${v.original_name}`}
                      className="btn btn-ghost"
                    >
                      Retry processing
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
