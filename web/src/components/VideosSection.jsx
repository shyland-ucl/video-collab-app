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
      .select('id, original_name, status, error, created_at')
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
    <section aria-labelledby="videos-heading" className="mb-6">
      <h2 id="videos-heading" className="mb-2 text-xl font-semibold">
        Videos
      </h2>

      <label htmlFor="video-file" className="mb-2 block text-lg">
        Upload a video (MP4, up to 50 MB)
      </label>
      <input
        id="video-file"
        type="file"
        accept="video/mp4"
        disabled={progress !== null}
        onChange={handleFileChange}
        className="mb-3 block w-full rounded border border-gray-400 p-3"
      />

      {progress !== null && (
        <p role="status" className="mb-3 text-lg">
          Uploading… {progress}%
        </p>
      )}
      {error && (
        <p role="alert" className="mb-3 text-red-700">
          {error}
        </p>
      )}
      {/* Fix 8 — separate alert for transient poll failures */}
      {listError && (
        <p role="alert" className="mb-3 text-red-700">
          {listError}
        </p>
      )}

      {videos === null ? (
        <p role="status">Loading videos…</p>
      ) : videos.length === 0 ? (
        <p>No videos yet. Upload one above to get started.</p>
      ) : (
        <ul className="space-y-2">
          {videos.map((v) => (
            <li key={v.id} className="rounded border border-gray-300 p-3">
              <p className="text-lg font-medium">{v.original_name}</p>
              <p>
                Status: {STATUS_LABELS[v.status] ?? v.status}
                {v.status === 'failed' && v.error ? ` — ${v.error}` : ''}
              </p>
              {v.status === 'ready' && (
                <Link
                  to={`/projects/${projectId}/videos/${v.id}`}
                  aria-label={`View scenes and descriptions for ${v.original_name}`}
                  className="mt-1 inline-block min-h-12 underline"
                >
                  View scenes and descriptions
                </Link>
              )}
              {/* Fix 2 — stuck-uploading rows (no in-flight upload) also get Retry */}
              {(v.status === 'failed' || (v.status === 'uploading' && progress === null)) && (
                <button
                  onClick={() => handleRetry(v)}
                  aria-label={`Retry processing ${v.original_name}`}
                  className="mt-1 min-h-12 rounded border border-gray-400 px-3"
                >
                  Retry processing
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
