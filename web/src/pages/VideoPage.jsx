import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'

const LEVELS = [
  { value: 1, label: "What's happening" },
  { value: 2, label: "What's visible" },
  { value: 3, label: 'How it looks' },
]

function formatTime(seconds) {
  const s = Math.round(Number(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function VideoPage() {
  const { projectId, videoId } = useParams()
  const [video, setVideo] = useState(null)
  const [segments, setSegments] = useState([])
  const [urls, setUrls] = useState({})
  const [level, setLevel] = useState(1)
  const [error, setError] = useState(null)

  useEffect(() => {
    async function load() {
      const { data: vid, error: vidErr } = await supabase
        .from('videos')
        .select('id, original_name, status, duration_seconds, storage_path')
        .eq('id', videoId)
        .single()
      if (vidErr || !vid) {
        setError('Video not found, or you are not a member of this project.')
        return
      }
      setVideo(vid)

      const { data: segs, error: segErr } = await supabase
        .from('segments')
        .select('id, idx, label, start_seconds, end_seconds, keyframe_path, descriptions ( level, text )')
        .eq('video_id', videoId)
        .order('idx')
      if (segErr) {
        setError(segErr.message)
        return
      }
      setSegments(segs ?? [])

      const paths = [vid.storage_path, ...(segs ?? []).map((s) => s.keyframe_path)]
      const { data: signed } = await supabase.storage.from('videos').createSignedUrls(paths, 3600)
      const map = {}
      for (const item of signed ?? []) {
        if (!item.error) map[item.path] = item.signedUrl
      }
      setUrls(map)
    }
    load()
  }, [videoId])

  if (error) {
    return (
      <main id="main" tabIndex={-1} className="page">
        <p role="alert" className="alert-error mb-4">{error}</p>
        <Link to={`/projects/${projectId}`} className="link-back">← Back to project</Link>
      </main>
    )
  }
  if (!video) {
    return (
      <main id="main" tabIndex={-1} className="page">
        <p role="status" className="muted">Loading…</p>
      </main>
    )
  }

  return (
    <main id="main" tabIndex={-1} className="page">
      <Link to={`/projects/${projectId}`} className="link-back mb-3">
        ← Back to project
      </Link>
      <h1 className="page-title mb-5">{video.original_name}</h1>

      {video.status !== 'ready' && (
        <p role="status" className="card mb-5 p-4 text-lg">
          This video is still being prepared — scenes and descriptions will appear here when it's ready.
        </p>
      )}

      {urls[video.storage_path] && (
        <video
          controls
          src={urls[video.storage_path]}
          className="mb-6 w-full rounded-card border border-line shadow-card"
          aria-label={`Original video: ${video.original_name}`}
        />
      )}

      <fieldset className="mb-7">
        <legend className="label mb-2.5">Description detail</legend>
        <div className="flex flex-col gap-2.5">
          {LEVELS.map((opt) => (
            <label
              key={opt.value}
              className="flex min-h-12 cursor-pointer items-center gap-3 rounded-field border border-line bg-surface px-4 text-lg shadow-card transition-colors hover:bg-sunken has-[:checked]:border-brand has-[:checked]:bg-brand-soft"
            >
              <input
                type="radio"
                name="description-level"
                value={opt.value}
                checked={level === opt.value}
                onChange={() => setLevel(opt.value)}
                className="h-5 w-5 accent-brand"
              />
              {opt.label}
            </label>
          ))}
        </div>
      </fieldset>

      <section aria-labelledby="scenes-heading">
        <h2 id="scenes-heading" className="section-title mb-3">
          Scenes ({segments.length})
        </h2>
        <ol className="space-y-3.5">
          {segments.map((seg) => {
            const description = seg.descriptions?.find((d) => d.level === level)
            return (
              <li key={seg.id} className="card overflow-hidden">
                {urls[seg.keyframe_path] && (
                  <img
                    src={urls[seg.keyframe_path]}
                    alt={seg.descriptions?.find((d) => d.level === 1)?.text ?? `Keyframe for ${seg.label}`}
                    className="w-full border-b border-line"
                  />
                )}
                <div className="p-4">
                  <p className="font-display text-lg font-bold">
                    {seg.label}{' '}
                    <span className="muted font-sans text-sm font-medium">
                      {formatTime(seg.start_seconds)}–{formatTime(seg.end_seconds)}
                    </span>
                  </p>
                  <p className="mt-1">{description?.text ?? 'No description available.'}</p>
                </div>
              </li>
            )
          })}
        </ol>
      </section>
    </main>
  )
}
