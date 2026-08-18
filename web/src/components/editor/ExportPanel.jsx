import { useState, useEffect, useCallback, useRef } from 'react'

/**
 * Phase 4 — Export/Download panel (creator surface). Four states keyed on the
 * latest render row:
 *   idle / none  → "Export video" button.
 *   rendering    → an aria-live=polite status (no role="status" — that makes
 *                  VoiceOver speak the role; the completion is also announced
 *                  by EditorPage).
 *   ready        → a "Download video" link (resolves a signed URL on mount).
 *   failed       → an assertive note + a retry (the Export button again).
 *
 * Props:
 *   render         { status:'rendering'|'ready'|'failed', output_path } | null
 *   onExport       () => void  — triggers POST /render
 *   getDownloadUrl (outputPath) => Promise<string|null>  — signed URL resolver
 */


export default function ExportPanel({ render, onExport, getDownloadUrl }) {
  const status = render?.status ?? null
  const [downloadUrl, setDownloadUrl] = useState(null)
  const downloadRef = useRef(null)

  // Resolve the signed URL when a render becomes ready.
  useEffect(() => {
    let cancelled = false
    setDownloadUrl(null)
    if (status === 'ready' && render?.output_path && getDownloadUrl) {
      getDownloadUrl(render.output_path)
        .then((url) => { if (!cancelled) setDownloadUrl(url) })
        .catch(() => { if (!cancelled) setDownloadUrl(null) })
    }
    return () => { cancelled = true }
  }, [status, render?.output_path, getDownloadUrl])

  // Move focus to the Download link when it appears (the Export button it
  // replaced just unmounted; without this focus falls to <body> — the same
  // stranded-focus trap as the suggestion routes). EditorPage's assertive
  // "ready to download" announce carries the news; this gives a focus target.
  useEffect(() => {
    if (downloadUrl && downloadRef.current) {
      const raf = requestAnimationFrame(() => downloadRef.current?.focus?.())
      return () => cancelAnimationFrame(raf)
    }
    return undefined
  }, [downloadUrl])

  const handleExport = useCallback(() => { onExport?.() }, [onExport])

  if (status === 'rendering') {
    // Visual only — NOT a live region. EditorPage announces "Rendering…" on the
    // triggering action, so a live region here would double-announce.
    return (
      <div className="rounded-xl border-2 border-creator/40 bg-creator-soft px-4 py-3 mb-3 flex items-center gap-3">
        <span className="flex gap-1" aria-hidden="true">
          <span className="w-2 h-2 rounded-full bg-creator animate-bounce" style={{ animationDelay: '0ms' }} />
          <span className="w-2 h-2 rounded-full bg-creator animate-bounce" style={{ animationDelay: '120ms' }} />
          <span className="w-2 h-2 rounded-full bg-creator animate-bounce" style={{ animationDelay: '240ms' }} />
        </span>
        <span className="text-sm font-medium text-creator">Rendering your video…</span>
      </div>
    )
  }

  if (status === 'ready') {
    return (
      <div className="rounded-xl border border-creator/30 bg-creator-soft px-4 py-3 mb-3 flex flex-col gap-2">
        <p className="text-sm font-medium text-creator">Your exported video is ready.</p>
        {downloadUrl ? (
          <a
            ref={downloadRef}
            href={downloadUrl}
            download="export.mp4"
            className="inline-flex items-center justify-center w-full py-3 rounded-lg bg-creator text-on-accent text-sm font-bold hover:opacity-90"
            style={{ minHeight: '48px' }}
          >
            Download video
          </a>
        ) : (
          <p className="text-sm text-ink-soft">Preparing your download…</p>
        )}
        <button
          type="button"
          onClick={handleExport}
          className="w-full py-2 rounded-lg bg-sunken text-sm font-semibold text-ink-soft hover:bg-line"
          style={{ minHeight: '44px' }}
          aria-label="Export this project as a video again"
        >
          Export again
        </button>
      </div>
    )
  }

  // idle or failed → the Export button (+ a failure note).
  return (
    <div className="mb-3 flex flex-col gap-2">
      {status === 'failed' && (
        <p className="text-sm text-danger bg-danger-soft border border-danger/30 rounded-lg px-3 py-2">
          The export failed. Try again.
        </p>
      )}
      <button
        type="button"
        onClick={handleExport}
        aria-label="Export this project as a video"
        className="w-full py-3 rounded-xl bg-creator text-on-accent text-sm font-bold hover:opacity-90"
        style={{ minHeight: '48px' }}
      >
        ⬇ Export video
      </button>
    </div>
  )
}
