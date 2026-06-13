import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { announce } from '../../utils/announcer'
import { playEarcon } from '../../utils/earcon'
import ttsService from '../../services/ttsService'
import { useAccessibility } from '../../contexts/AccessibilityContext'
import { useRootInert } from '../../hooks/useRootInert'
import { applyOperation } from '../../lib/editor/sceneEditOps'
import { rootSegmentId } from '../../lib/editor/stateStore'
import { computeClipLayout } from '../../hooks/usePlaybackEngine'

/**
 * Ported from probe src/components/probe1/ExplorationMode.jsx (Task 9).
 *
 * Stripped per the adaptation contract:
 * - EventLoggerContext / logEvent / eventTypes — deleted
 * - direct clip-array surgery + onEditChange — every edit now routes through
 *   `applyAndSave(opFn, announceText)` with opFns built on applyOperation,
 *   so EditorPage persists and Realtime distributes
 * - VQAPanel + in-component VQA modal — replaced by `onAskQuestion(clip)`
 *   (the device opens TaskRequestModal mode="vqa")
 * - `actionMode` condition branches — only the probe2b/3 behavior remains
 * - 'm' Mark shortcut — onMark was a no-op in the decoupled creator device
 * - local playTone — replaced with the shared earcon util (same frequencies
 *   and the probe's 50ms duration)
 *
 * Replaced:
 * - `segments` (buildAllSegments) → the scene list IS `state.clips`
 * - description lookup → `descriptions[rootSegmentId(clip.id)]?.[level]`
 * - playerRef play/pause/seek → onPlay/onPause/onSeekToClip callbacks that
 *   drive the device's playback engine (which also broadcasts transport)
 *
 * Kept identical: keyboard map (ArrowLeft/Right scenes, ArrowUp/Down detail,
 * Space play/pause, Enter ask, Escape close), earcons, TTS read-out + Stop
 * Reading, announce() texts, undo/redo local stacks, modal focus management
 * via useRootInert.
 */

function formatTime(seconds) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

const textSizeClasses = {
  small: 'text-base',
  medium: 'text-lg',
  large: 'text-xl',
}

const ACCENT = '#5CB85C' // creator accent from the decoupled probe device

export default function ExplorationMode({
  state,
  descriptions,
  isPlaying,
  currentTime,
  activeClipIndex,
  applyAndSave,
  onPlay,
  onPause,
  onSeekToClip,
  onAskAI,
  onAskHelper,
  onAskQuestion,
  suspendKeys = false,
}) {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [currentLevel, setCurrentLevel] = useState(1)
  const [showEditPanel, setShowEditPanel] = useState(false)
  const [showCaptionInput, setShowCaptionInput] = useState(false)
  const [captionText, setCaptionText] = useState('')
  const [undoStack, setUndoStack] = useState([])
  const [redoStack, setRedoStack] = useState([])
  const [isSpeaking, setIsSpeaking] = useState(false)
  const speakingTimerRef = useRef(null)
  const modalRef = useRef(null)
  const preModalFocusRef = useRef(null)
  const descriptionRef = useRef(null)
  const { textSize, audioEnabled, speechRate } = useAccessibility()

  const clips = state?.clips ?? []
  const total = clips.length
  const currentClip = clips[currentIndex] ?? null
  const isFirst = currentIndex === 0
  const isLast = currentIndex >= total - 1

  const isModalOpen = showEditPanel
  const getInitialModalFocus = useCallback(
    () => modalRef.current?.querySelector('button, input, textarea, [tabindex]:not([tabindex="-1"])'),
    []
  )
  const getPreModalFocus = useCallback(() => {
    const target = preModalFocusRef.current
    preModalFocusRef.current = null
    return target
  }, [])
  useRootInert(isModalOpen, {
    initialFocus: getInitialModalFocus,
    restoreFocus: getPreModalFocus,
    focusDelay: 100,
  })

  // Edits can shrink the clip list (delete, remote changes) — clamp the scene
  // cursor so the explorer never vanishes mid-session.
  useEffect(() => {
    if (total > 0 && currentIndex >= total) setCurrentIndex(total - 1)
  }, [total, currentIndex])

  // Sync the scene cursor with playback (probe: index follows the playhead).
  useEffect(() => {
    if (!isPlaying) return
    if (
      typeof activeClipIndex === 'number' &&
      activeClipIndex !== currentIndex &&
      clips[activeClipIndex]
    ) {
      setCurrentIndex(activeClipIndex)
    }
  }, [isPlaying, activeClipIndex, currentIndex, clips])

  // ---------------------------------------------------------------------------
  // Announce description helper
  // ---------------------------------------------------------------------------
  const stopSpeaking = useCallback(() => {
    ttsService.stop()
    setIsSpeaking(false)
    if (speakingTimerRef.current) {
      clearInterval(speakingTimerRef.current)
      speakingTimerRef.current = null
    }
    announce('Stopped reading.')
  }, [])

  const focusDescription = useCallback(() => {
    descriptionRef.current?.focus()
  }, [])

  const descriptionFor = useCallback(
    (clip, level) => descriptions?.[rootSegmentId(clip.id)]?.[level] ?? '',
    [descriptions]
  )

  const announceDescription = useCallback(
    (clip, level) => {
      if (!clip) return
      const rawText = descriptionFor(clip, level)
      const timePrefix = `${formatTime(clip.startTime)} - ${formatTime(clip.endTime)}`
      const text = `Detail level ${level}. ${timePrefix}. ${rawText}`
      announce(text)
      if (audioEnabled) {
        ttsService.speak(text, { rate: speechRate })
        setIsSpeaking(true)
        // Poll to detect when speech ends
        if (speakingTimerRef.current) clearInterval(speakingTimerRef.current)
        speakingTimerRef.current = setInterval(() => {
          if (!ttsService.isSpeaking) {
            setIsSpeaking(false)
            clearInterval(speakingTimerRef.current)
            speakingTimerRef.current = null
          }
        }, 250)
      }
    },
    [audioEnabled, speechRate, descriptionFor]
  )

  // Clean up speaking timer on unmount
  useEffect(() => {
    return () => {
      if (speakingTimerRef.current) clearInterval(speakingTimerRef.current)
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Activation (probe: pause, seek to the first scene, focus the description)
  // ---------------------------------------------------------------------------
  // If a modal opened before the delayed focus fires, leave focus alone — the
  // dialog owns it (yanking focus out of a just-opened dialog strands a
  // screen-reader user).
  const modalGuardRef = useRef(false)
  modalGuardRef.current = suspendKeys || isModalOpen
  useEffect(() => {
    if (clips[0]) onSeekToClip?.(clips[0])
    const timer = setTimeout(() => {
      if (!modalGuardRef.current) focusDescription()
    }, 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------------------------------------------------------------------------
  // Navigation callbacks (no wrapping — clamp at boundaries)
  // ---------------------------------------------------------------------------
  const goToPrevScene = useCallback(() => {
    if (!total || currentIndex <= 0) return
    const nextIdx = currentIndex - 1
    setCurrentIndex(nextIdx)
    const clip = clips[nextIdx]
    if (clip) {
      playEarcon(880, 50)
      onSeekToClip?.(clip)
      announce(`Scene ${nextIdx + 1} of ${total}. ${clip.name}.`)
      announceDescription(clip, currentLevel)
    }
  }, [total, clips, currentIndex, currentLevel, announceDescription, onSeekToClip])

  const goToNextScene = useCallback(() => {
    if (!total || currentIndex >= total - 1) return
    const nextIdx = currentIndex + 1
    setCurrentIndex(nextIdx)
    const clip = clips[nextIdx]
    if (clip) {
      playEarcon(880, 50)
      onSeekToClip?.(clip)
      announce(`Scene ${nextIdx + 1} of ${total}. ${clip.name}.`)
      announceDescription(clip, currentLevel)
    }
  }, [total, clips, currentIndex, currentLevel, announceDescription, onSeekToClip])

  const increaseLevel = useCallback(() => {
    if (currentLevel >= 3) return
    const next = currentLevel + 1
    setCurrentLevel(next)
    playEarcon(440, 50)
    announceDescription(currentClip, next)
  }, [currentLevel, currentClip, announceDescription])

  const decreaseLevel = useCallback(() => {
    if (currentLevel <= 1) return
    const next = currentLevel - 1
    setCurrentLevel(next)
    playEarcon(440, 50)
    announceDescription(currentClip, next)
  }, [currentLevel, currentClip, announceDescription])

  const handleAskQuestion = useCallback(() => {
    if (!currentClip) return
    announce('Ask a question about this scene.')
    onAskQuestion?.(currentClip)
  }, [currentClip, onAskQuestion])

  const handleEditOpen = useCallback(() => {
    preModalFocusRef.current = document.activeElement
    setShowEditPanel(true)
    announce('Edit panel opened.')
  }, [])

  const handleEditClose = useCallback(() => {
    setShowEditPanel(false)
    announce('Edit panel closed.')
  }, [])

  // ---------------------------------------------------------------------------
  // Clip editing helpers — every edit routes through applyAndSave(opFn, text)
  // ---------------------------------------------------------------------------
  const canMoveEarlier = currentIndex > 0
  const canMoveLater = currentClip != null && currentIndex < total - 1

  // The probe's canSplit compared the playhead with the clip's effective
  // bounds directly (its clips lived on one combined timeline). Production
  // clips keep source-video coordinates, so map the engine's timeline
  // position into the current clip's source time first: split stays enabled
  // only while the playhead is STRICTLY inside the scene.
  const layout = useMemo(() => computeClipLayout(clips), [clips])
  const layoutEntry = layout[currentIndex] ?? null
  const splitSourceTime =
    layoutEntry &&
    layoutEntry.duration > 0 &&
    currentTime > layoutEntry.edlOffset &&
    currentTime < layoutEntry.edlOffset + layoutEntry.duration
      ? layoutEntry.effectiveStart + (currentTime - layoutEntry.edlOffset)
      : null
  const canSplit = splitSourceTime !== null

  // Undo/redo snapshots stay LOCAL (probe behavior) but apply through
  // applyAndSave with a state-replacing opFn so they persist + distribute.
  const saveSnapshot = useCallback(() => {
    setUndoStack((prev) => [...prev, state])
    setRedoStack([])
  }, [state])

  const handleSplitClip = useCallback(() => {
    if (!canSplit || !currentClip) return
    saveSnapshot()
    const id = currentClip.id
    const at = splitSourceTime
    applyAndSave(
      (s) => applyOperation(s, id, 'split', { currentTime: at }),
      `Split ${currentClip.name} at ${at.toFixed(1)} seconds`
    )
  }, [canSplit, currentClip, splitSourceTime, saveSnapshot, applyAndSave])

  const handleDeleteClip = useCallback(() => {
    if (!currentClip) return
    saveSnapshot()
    const id = currentClip.id
    applyAndSave((s) => applyOperation(s, id, 'delete'), `Deleted clip: ${currentClip.name}`)
    setShowEditPanel(false)
  }, [currentClip, saveSnapshot, applyAndSave])

  const handleMoveEarlier = useCallback(() => {
    if (!canMoveEarlier || !currentClip) return
    saveSnapshot()
    const id = currentClip.id
    applyAndSave((s) => applyOperation(s, id, 'move_earlier'), `Moved ${currentClip.name} earlier`)
  }, [canMoveEarlier, currentClip, saveSnapshot, applyAndSave])

  const handleMoveLater = useCallback(() => {
    if (!canMoveLater || !currentClip) return
    saveSnapshot()
    const id = currentClip.id
    applyAndSave((s) => applyOperation(s, id, 'move_later'), `Moved ${currentClip.name} later`)
  }, [canMoveLater, currentClip, saveSnapshot, applyAndSave])

  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) return
    const prev = undoStack[undoStack.length - 1]
    setRedoStack((r) => [...r, state])
    setUndoStack((u) => u.slice(0, -1))
    // State-REPLACING opFn — non-rebasable so a conflict surfaces and resyncs
    // instead of clobbering a concurrent helper edit with this stale snapshot.
    applyAndSave(() => prev, 'Undo', { rebasable: false })
  }, [undoStack, state, applyAndSave])

  const handleRedo = useCallback(() => {
    if (redoStack.length === 0) return
    const next = redoStack[redoStack.length - 1]
    setUndoStack((u) => [...u, state])
    setRedoStack((r) => r.slice(0, -1))
    // State-REPLACING opFn — non-rebasable (see handleUndo).
    applyAndSave(() => next, 'Redo', { rebasable: false })
  }, [redoStack, state, applyAndSave])

  const handleAddCaption = useCallback(() => {
    const text = captionText.trim()
    if (!text || !currentClip) return
    saveSnapshot()
    const id = currentClip.id
    applyAndSave(
      (s) => applyOperation(s, id, 'add_caption', { captionText: text }),
      `Added caption: "${text}"`
    )
    setCaptionText('')
    setShowCaptionInput(false)
  }, [captionText, currentClip, saveSnapshot, applyAndSave])

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      onPause?.()
      // Return focus to the description and read it aloud
      setTimeout(() => {
        focusDescription()
      }, 150)
    } else {
      onPlay?.(currentClip)
      announce('Playing.')
    }
  }, [isPlaying, currentClip, onPlay, onPause, focusDescription])

  // ---------------------------------------------------------------------------
  // Keyboard handling
  // ---------------------------------------------------------------------------
  useEffect(() => {
    function onKeyDown(e) {
      const tag = e.target.tagName?.toLowerCase?.() ?? ''
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      if (e.target.isContentEditable || e.target.getAttribute?.('role') === 'textbox') return

      // While a device-level modal (Ask AI/Helper/VQA, confirm dialog) is open,
      // the explorer behind it must not react to global shortcuts.
      if (suspendKeys) return

      // While the edit panel is open, only Escape (close it) passes.
      if (isModalOpen) {
        if (e.key === 'Escape') {
          e.preventDefault()
          handleEditClose()
        }
        return
      }

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault()
          goToPrevScene()
          break
        case 'ArrowRight':
          e.preventDefault()
          goToNextScene()
          break
        case 'ArrowUp':
          e.preventDefault()
          increaseLevel()
          break
        case 'ArrowDown':
          e.preventDefault()
          decreaseLevel()
          break
        case 'Enter':
          e.preventDefault()
          handleAskQuestion()
          break
        case ' ':
          e.preventDefault()
          handlePlayPause()
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    suspendKeys,
    isModalOpen,
    goToPrevScene,
    goToNextScene,
    increaseLevel,
    decreaseLevel,
    handleAskQuestion,
    handlePlayPause,
    handleEditClose,
  ])

  if (!currentClip) return null

  const rawDescription = descriptionFor(currentClip, currentLevel) || 'No description available.'

  return (
    <div className="w-full flex flex-col gap-3">
      {/* Scene Description Card */}
      <div
        role="region"
        aria-label="Scene description"
        className="rounded-2xl overflow-hidden bg-white"
        style={{ border: '1px solid #d3e8d3', boxShadow: '0 1px 3px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.04)' }}
      >
        {/* Card header */}
        <div
          className="px-4 py-3 flex items-center justify-between"
          style={{ background: `linear-gradient(135deg, ${ACCENT}, ${ACCENT}dd)` }}
        >
          <span className="text-xs font-bold tracking-wider uppercase text-white/90">Scene Description</span>
          <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-white/20 text-white backdrop-blur-sm">
            {currentIndex + 1} / {total}
          </span>
        </div>

        {/* Detail level controls */}
        <div className="flex items-center gap-2 px-3 py-2.5" style={{ borderBottom: '1px solid #eef2f7', background: '#fafbfc' }}>
          <span
            className="text-xs font-bold text-[#64748b] whitespace-nowrap tracking-wide"
            role="status"
            aria-live="polite"
            aria-label={`Detail level ${currentLevel} of 3`}
          >
            Detail {currentLevel}/3
          </span>
          <div className="flex-1 flex items-center gap-1.5">
            {[1, 2, 3].map((lvl) => (
              <div
                key={lvl}
                className="flex-1 h-1 rounded-full transition-all duration-300"
                style={{ backgroundColor: lvl <= currentLevel ? ACCENT : '#e2e8f0' }}
                aria-hidden="true"
              />
            ))}
          </div>
          <button
            type="button"
            onClick={decreaseLevel}
            disabled={currentLevel <= 1}
            aria-label={`Less detail, currently level ${currentLevel} of 3`}
            className="py-2.5 px-4 rounded-lg text-sm font-semibold transition-all duration-150 active:scale-[0.97] disabled:opacity-35 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-offset-1"
            style={{ minHeight: '48px', backgroundColor: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', '--tw-ring-color': ACCENT }}
          >
            − Less
          </button>
          <button
            type="button"
            onClick={increaseLevel}
            disabled={currentLevel >= 3}
            aria-label={`More detail, currently level ${currentLevel} of 3`}
            className="py-2.5 px-4 rounded-lg text-sm font-semibold transition-all duration-150 active:scale-[0.97] disabled:opacity-35 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-offset-1"
            style={{ minHeight: '48px', backgroundColor: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', '--tw-ring-color': ACCENT }}
          >
            + More
          </button>
        </div>

        {/* Stop Reading banner — shown while TTS is active */}
        {isSpeaking && (
          <button
            type="button"
            onClick={stopSpeaking}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold transition-all duration-150 active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-white/50"
            style={{ background: ACCENT, color: 'white', minHeight: '44px' }}
            aria-label="Stop reading description"
          >
            <span className="w-3 h-3 rounded-sm bg-white" aria-hidden="true" />
            Tap to Stop Reading
          </button>
        )}

        {/* Description body */}
        <div className="px-4 py-4">
          <p
            ref={descriptionRef}
            tabIndex={-1}
            className={`${textSizeClasses[textSize] ?? 'text-lg'} leading-relaxed text-gray-800 focus:outline-none`}
            aria-label={`Scene ${currentIndex + 1} of ${total}. ${currentClip.name}. ${formatTime(currentClip.startTime)} to ${formatTime(currentClip.endTime)}. Detail level ${currentLevel} of 3. ${rawDescription}`}
          >
            <span className="block text-sm font-bold mb-0.5" style={{ color: ACCENT }} aria-hidden="true">
              {currentClip.name}
            </span>
            <span className="block text-xs text-gray-400 mb-3 font-medium tracking-wide" aria-hidden="true">
              {formatTime(currentClip.startTime)} – {formatTime(currentClip.endTime)}
            </span>
            <span className="text-[#334155]" aria-hidden="true">{rawDescription}</span>
          </p>
        </div>

        {/* Navigation row */}
        <div className="flex items-center gap-2 px-3 py-2.5" style={{ borderTop: '1px solid #eef2f7', background: '#fafbfc' }}>
          <button
            type="button"
            onClick={goToPrevScene}
            disabled={isFirst}
            aria-label={isFirst ? 'Previous scene, at first scene' : `Previous scene: ${clips[currentIndex - 1]?.name}`}
            className="flex-1 py-3 rounded-xl text-sm font-semibold transition-all duration-150 active:scale-[0.97] disabled:opacity-35 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-offset-1"
            style={{ minHeight: '48px', backgroundColor: '#e7f4e7', color: '#2d6a2d', '--tw-ring-color': ACCENT }}
          >
            ◀ Prev
          </button>
          <button
            type="button"
            onClick={handlePlayPause}
            aria-label={isPlaying ? 'Pause playback' : 'Play from scene start'}
            className="flex-none px-5 py-3 rounded-xl text-sm font-bold text-white transition-all duration-150 active:scale-[0.97] focus:outline-none focus:ring-2 focus:ring-offset-1"
            style={{ minHeight: '48px', backgroundColor: ACCENT, boxShadow: `0 2px 8px ${ACCENT}40`, '--tw-ring-color': ACCENT }}
          >
            {isPlaying ? '⏸ Pause' : '▶ Play'}
          </button>
          <button
            type="button"
            onClick={goToNextScene}
            disabled={isLast}
            aria-label={isLast ? 'Next scene, at last scene' : `Next scene: ${clips[currentIndex + 1]?.name}`}
            className="flex-1 py-3 rounded-xl text-sm font-semibold transition-all duration-150 active:scale-[0.97] disabled:opacity-35 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-offset-1"
            style={{ minHeight: '48px', backgroundColor: '#e7f4e7', color: '#2d6a2d', '--tw-ring-color': ACCENT }}
          >
            Next ▶
          </button>
        </div>
      </div>

      {/* Actions Card */}
      <div
        role="region"
        aria-label="Actions"
        className="rounded-2xl overflow-hidden bg-white"
        style={{ border: '1px solid #e8ecf1', boxShadow: '0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.03)' }}
      >
        <div className="px-4 py-2.5" style={{ background: '#f8f9fb', borderBottom: '1px solid #eef2f7' }}>
          <span className="text-xs font-bold tracking-wider text-[#64748b] uppercase">Actions</span>
        </div>
        <div className="flex flex-col gap-2.5 px-3 py-3">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={handleEditOpen}
              aria-label="Edit this clip yourself"
              className="flex-1 py-3 rounded-xl text-sm font-bold text-white transition-all duration-150 active:scale-[0.97] focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2"
              style={{ minHeight: '48px', background: 'linear-gradient(135deg, #374151, #1f2937)', boxShadow: '0 2px 6px rgba(55,65,81,0.3)' }}
            >
              <span aria-hidden="true">✏️ </span>Edit Myself
            </button>
            <button
              type="button"
              onClick={() => onAskAI?.(currentClip)}
              aria-label="Ask AI to edit this clip"
              className="flex-1 py-3 rounded-xl text-sm font-bold text-white transition-all duration-150 active:scale-[0.97] focus:outline-none focus:ring-2 focus:ring-offset-1"
              style={{ minHeight: '48px', background: 'linear-gradient(135deg, #7D3C98, #6C3483)', boxShadow: '0 2px 6px rgba(125,60,152,0.35)', '--tw-ring-color': '#7D3C98' }}
            >
              <span aria-hidden="true">🤖 </span>Ask AI
            </button>
            <button
              type="button"
              onClick={() => onAskHelper?.(currentClip)}
              aria-label="Ask helper to edit this clip"
              className="flex-1 py-3 rounded-xl text-sm font-bold text-white transition-all duration-150 active:scale-[0.97] focus:outline-none focus:ring-2 focus:ring-offset-1"
              style={{ minHeight: '48px', background: 'linear-gradient(135deg, #B85C14, #A04000)', boxShadow: '0 2px 6px rgba(184,92,20,0.35)', '--tw-ring-color': '#B85C14' }}
            >
              <span aria-hidden="true">🙋 </span>Ask Helper
            </button>
          </div>
          {/* New in production (Task 9): scene-level VQA */}
          <button
            type="button"
            onClick={handleAskQuestion}
            aria-label="Ask a question about this scene"
            className="w-full py-3 rounded-xl text-sm font-bold text-white transition-all duration-150 active:scale-[0.97] focus:outline-none focus:ring-2 focus:ring-offset-1"
            style={{ minHeight: '48px', background: 'linear-gradient(135deg, #2B579A, #1e3f6f)', boxShadow: '0 2px 6px rgba(43,87,154,0.35)', '--tw-ring-color': '#2B579A' }}
          >
            <span aria-hidden="true">❓ </span>Ask about this scene
          </button>
        </div>
      </div>

      {/* Edit Actions — portalled to document.body for VoiceOver focus trap */}
      {showEditPanel &&
        createPortal(
          <div
            ref={modalRef}
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
            role="dialog"
            aria-modal="true"
            aria-label={`Edit clip: ${currentClip.name}`}
            onClick={(e) => {
              if (e.target === e.currentTarget) handleEditClose()
            }}
          >
            <div className="w-full max-w-lg bg-white rounded-t-2xl shadow-2xl">
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
                <h3 className="font-bold text-sm text-gray-900">Edit: {currentClip.name}</h3>
                <button
                  onClick={handleEditClose}
                  className="px-3 py-1.5 rounded text-sm font-medium text-gray-600 hover:bg-gray-100 focus:outline-2 focus:outline-blue-500"
                  style={{ minHeight: '44px', minWidth: '44px' }}
                  aria-label="Close edit actions"
                >
                  Done
                </button>
              </div>
              <div className="flex flex-col gap-2 p-4">
                {/* Split */}
                <button
                  type="button"
                  onClick={handleSplitClip}
                  disabled={!canSplit}
                  aria-label="Split this clip at the current playback position"
                  className="w-full py-3 rounded-lg bg-[#2B579A] text-sm font-bold text-white hover:bg-[#1e3f6f] disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-[#2B579A] focus:ring-offset-1"
                  style={{ minHeight: '48px' }}
                >
                  Split
                </button>
                {/* Move Earlier / Move Later */}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleMoveEarlier}
                    disabled={!canMoveEarlier}
                    aria-label="Move this clip earlier in the timeline"
                    className="flex-1 py-3 rounded-lg bg-gray-100 text-sm font-semibold text-gray-700 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-[#2B579A] focus:ring-offset-1"
                    style={{ minHeight: '48px' }}
                  >
                    Move Earlier
                  </button>
                  <button
                    type="button"
                    onClick={handleMoveLater}
                    disabled={!canMoveLater}
                    aria-label="Move this clip later in the timeline"
                    className="flex-1 py-3 rounded-lg bg-gray-100 text-sm font-semibold text-gray-700 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-[#2B579A] focus:ring-offset-1"
                    style={{ minHeight: '48px' }}
                  >
                    Move Later
                  </button>
                </div>
                {/* Delete */}
                <button
                  type="button"
                  onClick={handleDeleteClip}
                  disabled={!currentClip}
                  aria-label="Delete this clip from the timeline"
                  className="w-full py-3 rounded-lg bg-red-500 text-sm font-bold text-white hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-red-400 focus:ring-offset-2"
                  style={{ minHeight: '48px' }}
                >
                  Delete
                </button>
                {/* Undo / Redo */}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleUndo}
                    disabled={undoStack.length === 0}
                    aria-label="Undo last edit"
                    className="flex-1 py-3 rounded-lg bg-gray-100 text-sm font-semibold text-gray-700 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-[#2B579A] focus:ring-offset-1"
                    style={{ minHeight: '48px' }}
                  >
                    Undo
                  </button>
                  <button
                    type="button"
                    onClick={handleRedo}
                    disabled={redoStack.length === 0}
                    aria-label="Redo last undone edit"
                    className="flex-1 py-3 rounded-lg bg-gray-100 text-sm font-semibold text-gray-700 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-[#2B579A] focus:ring-offset-1"
                    style={{ minHeight: '48px' }}
                  >
                    Redo
                  </button>
                </div>
                {/* Add Caption */}
                {!showCaptionInput ? (
                  <button
                    type="button"
                    onClick={() => setShowCaptionInput(true)}
                    aria-label="Add a caption to this scene"
                    className="w-full py-3 rounded-lg bg-amber-500 text-sm font-bold text-white hover:bg-amber-600 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:ring-offset-2"
                    style={{ minHeight: '48px' }}
                  >
                    Add Caption
                  </button>
                ) : (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={captionText}
                      onChange={(e) => setCaptionText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleAddCaption()
                      }}
                      placeholder="Enter caption text..."
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-2 focus:outline-[#2B579A]"
                      style={{ minHeight: '48px' }}
                      aria-label="Caption text"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={handleAddCaption}
                      disabled={!captionText.trim()}
                      aria-label="Save caption"
                      className="px-4 py-2 rounded-lg bg-amber-500 text-sm font-bold text-white hover:bg-amber-600 disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:ring-offset-1"
                      style={{ minHeight: '48px', minWidth: '48px' }}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowCaptionInput(false)
                        setCaptionText('')
                      }}
                      aria-label="Cancel adding caption"
                      className="px-3 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:ring-offset-1"
                      style={{ minHeight: '48px', minWidth: '48px' }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
