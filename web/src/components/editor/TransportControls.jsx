// THEMING NOTE: this component is deliberately NOT swept to design tokens.
// It is dark player chrome (like every video editor's timeline/transport),
// identical across all app themes, so its literal dark colors stay.
import { useCallback } from 'react'

// Ported from probe src/components/shared/TransportControls.jsx (Task 10).
// Adapted: the probe drove a VideoPlayer imperative handle via `playerRef`
// (play/pause/seek/getCurrentTime). The production helper drives
// usePlaybackEngine directly, so the same buttons now call explicit callbacks
// — onPlayPause(), onSeek(time), getCurrentTime() — passed by HelperDevice.
// The icons, layout, aria-labels, and 5-second skip behavior are identical.

function formatTime(seconds) {
  if (!seconds || !isFinite(seconds)) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function IconSkipBack() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
      <rect x="2" y="3" width="2" height="12" />
      <polygon points="14,3 6,9 14,15" />
    </svg>
  )
}
function IconRewind() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
      <polygon points="9,3 1,9 9,15" />
      <polygon points="17,3 9,9 17,15" />
    </svg>
  )
}
function IconPlay() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="currentColor" aria-hidden="true">
      <polygon points="4,2 20,11 4,20" />
    </svg>
  )
}
function IconPause() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="currentColor" aria-hidden="true">
      <rect x="4" y="2" width="5" height="18" />
      <rect x="13" y="2" width="5" height="18" />
    </svg>
  )
}
function IconForward() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
      <polygon points="1,3 9,9 1,15" />
      <polygon points="9,3 17,9 9,15" />
    </svg>
  )
}
function IconSkipForward() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
      <polygon points="4,3 12,9 4,15" />
      <rect x="14" y="3" width="2" height="12" />
    </svg>
  )
}

export default function TransportControls({
  isPlaying,
  currentTime,
  duration,
  onPlayPause,
  onSeek,
  getCurrentTime,
}) {
  const handlePlayPause = useCallback(() => {
    onPlayPause?.()
  }, [onPlayPause])

  const handleJumpToStart = useCallback(() => {
    onSeek?.(0)
  }, [onSeek])

  const handleRewind = useCallback(() => {
    const t = getCurrentTime?.() ?? currentTime ?? 0
    onSeek?.(Math.max(0, t - 5))
  }, [getCurrentTime, currentTime, onSeek])

  const handleForward = useCallback(() => {
    const t = getCurrentTime?.() ?? currentTime ?? 0
    onSeek?.(Math.min(duration || 0, t + 5))
  }, [getCurrentTime, currentTime, duration, onSeek])

  const handleJumpToEnd = useCallback(() => {
    if (duration) onSeek?.(duration)
  }, [duration, onSeek])

  const btnBase = 'flex h-11 w-full max-w-12 items-center justify-center justify-self-center rounded text-white hover:bg-white/20 transition-colors focus:outline-2 focus:outline-white focus:outline-offset-2'

  return (
    <div
      className="grid grid-cols-3 items-center gap-1.5 rounded-b px-2 py-2 min-[420px]:grid-cols-5"
      style={{ backgroundColor: '#1F3864' }}
      role="toolbar"
      aria-label="Video transport controls"
    >
      <button className={btnBase} onClick={handleJumpToStart} aria-label="Jump to beginning" title="Jump to beginning">
        <IconSkipBack />
      </button>
      <button className={btnBase} onClick={handleRewind} aria-label="Rewind 5 seconds (Left arrow)" title="Rewind 5s (Left arrow)">
        <IconRewind />
      </button>
      <button
        className="flex h-12 w-full max-w-12 items-center justify-center justify-self-center rounded-full text-white transition-colors focus:outline-2 focus:outline-white focus:outline-offset-2"
        style={{ backgroundColor: '#2B579A' }}
        onClick={handlePlayPause}
        aria-label={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
        title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
      >
        {isPlaying ? <IconPause /> : <IconPlay />}
      </button>
      <button className={btnBase} onClick={handleForward} aria-label="Forward 5 seconds (Right arrow)" title="Forward 5s (Right arrow)">
        <IconForward />
      </button>
      <button className={btnBase} onClick={handleJumpToEnd} aria-label="Jump to end" title="Jump to end">
        <IconSkipForward />
      </button>
      <div className="col-span-full justify-self-center font-mono text-sm text-white" aria-live="off" aria-label={`Time: ${formatTime(currentTime)} of ${formatTime(duration)}`} role="timer">
        {formatTime(currentTime)} / {formatTime(duration)}
      </div>
    </div>
  )
}
