import { useState, useEffect, useCallback } from 'react'

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

const ACCENT = '#9B59B6'

export default function ExportPanel({ render, onExport, getDownloadUrl }) {
  const status = render?.status ?? null
  const [downloadUrl, setDownloadUrl] = useState(null)

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

  const handleExport = useCallback(() => { onExport?.() }, [onExport])

  if (status === 'rendering') {
    return (
      <div
        aria-live="polite"
        className="rounded-xl border-2 border-[#9B59B6]/40 bg-[#f5eefa] px-4 py-3 mb-3 flex items-center gap-3"
      >
        <span className="flex gap-1" aria-hidden="true">
          <span className="w-2 h-2 rounded-full bg-[#9B59B6] animate-bounce" style={{ animationDelay: '0ms' }} />
          <span className="w-2 h-2 rounded-full bg-[#9B59B6] animate-bounce" style={{ animationDelay: '120ms' }} />
          <span className="w-2 h-2 rounded-full bg-[#9B59B6] animate-bounce" style={{ animationDelay: '240ms' }} />
        </span>
        <span className="text-sm font-medium text-[#6b3f86]">Rendering your video…</span>
      </div>
    )
  }

  if (status === 'ready') {
    return (
      <div className="rounded-xl border border-[#9B59B6]/30 bg-[#faf6fd] px-4 py-3 mb-3 flex flex-col gap-2">
        <p className="text-sm font-medium text-[#6b3f86]">Your exported video is ready.</p>
        {downloadUrl ? (
          <a
            href={downloadUrl}
            download="export.mp4"
            className="inline-flex items-center justify-center w-full py-3 rounded-lg text-white text-sm font-bold hover:opacity-90 focus:outline-2 focus:outline-offset-2 focus:outline-blue-500"
            style={{ backgroundColor: ACCENT, minHeight: '48px' }}
          >
            Download video
          </a>
        ) : (
          <p className="text-sm text-gray-500" aria-live="polite">Preparing your download…</p>
        )}
        <button
          type="button"
          onClick={handleExport}
          className="w-full py-2 rounded-lg bg-gray-100 text-sm font-semibold text-gray-700 hover:bg-gray-200 focus:outline-2 focus:outline-offset-2 focus:outline-blue-500"
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
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          The export failed. Try again.
        </p>
      )}
      <button
        type="button"
        onClick={handleExport}
        aria-label="Export this project as a video"
        className="w-full py-3 rounded-xl text-white text-sm font-bold hover:opacity-90 focus:outline-2 focus:outline-offset-2 focus:outline-blue-500"
        style={{ backgroundColor: ACCENT, minHeight: '48px' }}
      >
        ⬇ Export video
      </button>
    </div>
  )
}
