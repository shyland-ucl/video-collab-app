// THEMING NOTE: this component is deliberately NOT swept to design tokens.
// It is dark player chrome (like every video editor's timeline/transport),
// identical across all app themes, so its literal dark colors stay.
import { useCallback, useMemo, useRef, useState } from 'react'
import { announce } from '../../utils/announcer'
import ConfirmEditDialog from './ConfirmEditDialog'
import {
  splitClip, deleteClip, moveClip, addCaption, getClipForScene,
  setClipMuted, getClipMuted, setClipVolume, getClipVolume,
} from '../../lib/editor/sceneEditOps'
import { summarizeVisualAdjustment } from '../../lib/editor/projectOverview'
import { rootSegmentId } from '../../lib/editor/stateStore'

// Adapted port of probe src/components/shared/MockEditorVisual.jsx (Task 10).
//
// Stripped per the adaptation contract:
// - useEventLogger / EventTypes / Actors / logEvent — deleted
// - the component's internal clips/captions/sources state + the
//   onEditChange broadcast machinery (didMount/syncFromProps/prevEditState
//   guards) — the timeline is now CONTROLLED off `clips` (state.clips); every
//   edit routes through `applyAndSave(opFn, announceText)` with id-based, pure
//   opFns from sceneEditOps so they re-derive correctly on rebased remote state
// - Import Video (local blob sources can't persist to the shared signed-URL
//   project) and the Sound panel (placeholder catalogue — Task 9 stripped
//   useSceneSoundPlayback) and per-clip volume — out of 1c scope
// - the local undo/redo stacks: EditorPage owns versioned history; the helper's
//   edits are individually announced and durable
// - MockColourControls/eventTypes import — the slider set is inlined here and
//   colour now PERSISTS via onColourCommit (slider commit, not every input)
//
// Kept faithful: the timeline strip layout + click-to-seek, the trim-handle
// keyboard sliders (0.5s step), selection model, toolbar keyboard roving, the
// caption editor, the visual-adjustment slider set + ranges, and all aria.
// REQUIRED: every clip element carries data-testid="timeline-clip".

// Exported so the slider set (incl. the restored rotate control) is unit-testable
// without mounting the full timeline.
export const COLOUR_SLIDERS = [
  { id: 'brightness', label: 'Brightness', min: -100, max: 100, step: 5, suffix: '' },
  { id: 'contrast', label: 'Contrast', min: -100, max: 100, step: 5, suffix: '' },
  { id: 'saturation', label: 'Saturation', min: -100, max: 100, step: 5, suffix: '' },
  { id: 'zoom', label: 'Zoom', min: 100, max: 250, step: 10, suffix: '%' },
  { id: 'rotate', label: 'Rotate', min: -180, max: 180, step: 15, suffix: '°' },
]
const COLOUR_DEFAULTS = { brightness: 0, contrast: 0, saturation: 0, zoom: 100, rotate: 0 }
const TRIM_STEP = 0.5

function effectiveDuration(clip) {
  return Math.max(0.5, (clip.endTime - clip.trimEnd) - (clip.startTime + clip.trimStart))
}

// Trim opFn factory. Returns a pure (state) => state op that targets the clip
// BY ID (so it re-derives correctly on a rebased remote state whose clip order
// differs) and adjusts one trim edge by `direction * TRIM_STEP`, clamped to a 0
// floor and leaving at least 0.5s of clip. `edge` is 'left' (trimStart) or
// 'right' (trimEnd); `direction` is +1 (trim more) or -1 (recover).
// Exported so the clamp/step maths can be unit-tested without a jsdom pointer.
export function makeTrimOp(clipId, edge, direction) {
  const delta = direction * TRIM_STEP
  return (s) => {
    const target = getClipForScene(s, clipId)
    if (!target) return s
    const dur = target.endTime - target.startTime
    const next = { ...target }
    if (edge === 'left') {
      next.trimStart = Math.max(0, Math.min((target.trimStart || 0) + delta, dur - (target.trimEnd || 0) - 0.5))
    } else {
      next.trimEnd = Math.max(0, Math.min((target.trimEnd || 0) + delta, dur - (target.trimStart || 0) - 0.5))
    }
    return { ...s, clips: s.clips.map((c) => (c.id === clipId ? next : c)) }
  }
}

export default function EditorTimeline({
  clips = [],
  captions = [],
  sources = [],
  currentTime = 0,
  colour = {},
  applyAndSave,
  onSeek,
  onTextTool,
  textToolActive,
}) {
  const [selectedClipIndex, setSelectedClipIndex] = useState(null)
  const [showCaptionEditor, setShowCaptionEditor] = useState(false)
  const [showVisualPanel, setShowVisualPanel] = useState(false)
  const [showSoundPanel, setShowSoundPanel] = useState(false)
  const [captionText, setCaptionText] = useState('')
  const [pendingDelete, setPendingDelete] = useState(null)
  const timelineRef = useRef(null)
  const toolbarRef = useRef(null)

  // ---- Layout (effective, trimmed) ----
  const clipLayouts = useMemo(() => {
    const out = []
    let running = 0
    for (const clip of clips) {
      const dur = effectiveDuration(clip)
      out.push({ offsetTime: running, duration: dur })
      running += dur
    }
    return out
  }, [clips])
  const timelineTotalDuration = clipLayouts.reduce((s, l) => s + l.duration, 0) || 1
  const playheadPercent = Math.min(100, Math.max(0, (currentTime / timelineTotalDuration) * 100))

  const selectedClip = selectedClipIndex != null ? clips[selectedClipIndex] : null

  // The clip the colour/visual tools target: the selection, else the clip under
  // the playhead.
  const activeToolClip = useMemo(() => {
    if (selectedClip) return selectedClip
    let running = 0
    for (const clip of clips) {
      const dur = effectiveDuration(clip)
      if (currentTime >= running && currentTime < running + dur) return clip
      running += dur
    }
    return clips[0] ?? null
  }, [clips, currentTime, selectedClip])

  const handleSelectClip = useCallback((index) => {
    setSelectedClipIndex(index)
    const clip = clips[index]
    if (clip) {
      announce(`Selected clip ${index + 1} of ${clips.length}: ${clip.name}, ${effectiveDuration(clip).toFixed(1)} seconds`)
    }
  }, [clips])

  // ---- Edit operations — id-based, pure opFns through applyAndSave ----
  const handleDelete = useCallback(() => {
    if (selectedClipIndex === null) return
    const clip = clips[selectedClipIndex]
    if (!clip) return
    setPendingDelete(clip)
  }, [selectedClipIndex, clips])

  const confirmDelete = useCallback(() => {
    if (!pendingDelete) return
    const clip = pendingDelete
    const id = clip.id
    setPendingDelete(null)
    setSelectedClipIndex(null)
    applyAndSave((s) => deleteClip(s, id), `Deleted clip: ${clip.name}`)
  }, [pendingDelete, applyAndSave])

  const handleSplit = useCallback(() => {
    if (selectedClipIndex === null) return
    const clip = clips[selectedClipIndex]
    if (!clip) return
    // Map the EDL playhead into this clip's source time.
    const layout = clipLayouts[selectedClipIndex]
    const within = currentTime - layout.offsetTime
    const effectiveStart = clip.startTime + (clip.trimStart || 0)
    const effectiveEnd = clip.endTime - (clip.trimEnd || 0)
    const splitAt = effectiveStart + within
    if (splitAt <= effectiveStart || splitAt >= effectiveEnd) {
      announce('Playhead is not within the selected clip. Cannot split.')
      return
    }
    const id = clip.id
    applyAndSave((s) => splitClip(s, id, splitAt), `Split ${clip.name} at ${splitAt.toFixed(1)} seconds`)
  }, [selectedClipIndex, clips, clipLayouts, currentTime, applyAndSave])

  const handleMove = useCallback((direction) => {
    if (selectedClipIndex === null) return
    const clip = clips[selectedClipIndex]
    if (!clip) return
    const id = clip.id
    const dir = direction === 'up' ? 'up' : 'down'
    const newIndex = dir === 'up' ? selectedClipIndex - 1 : selectedClipIndex + 1
    if (newIndex < 0 || newIndex >= clips.length) return
    setSelectedClipIndex(newIndex)
    applyAndSave((s) => moveClip(s, id, dir), `Moved ${clip.name} ${dir === 'up' ? 'earlier' : 'later'}`)
  }, [selectedClipIndex, clips, applyAndSave])

  const handleTrim = useCallback((clipId, edge, direction) => {
    const clip = clips.find((c) => c.id === clipId)
    if (!clip) return
    applyAndSave(makeTrimOp(clipId, edge, direction), `Trimmed ${clip.name}`)
  }, [clips, applyAndSave])

  const handleAddCaption = useCallback(() => {
    const text = captionText.trim()
    if (!text) return
    const clip = selectedClip ?? activeToolClip
    if (!clip) return
    const id = clip.id
    setCaptionText('')
    applyAndSave((s) => addCaption(s, id, text), `Added caption: "${text}"`)
  }, [captionText, selectedClip, activeToolClip, applyAndSave])

  // ---- Colour: commit (slider release / change-end), persists per scene ----
  const colourValues = useMemo(() => {
    const sceneId = activeToolClip ? rootSegmentId(activeToolClip.id) : null
    return { ...COLOUR_DEFAULTS, ...(sceneId ? colour?.[sceneId] : null) }
  }, [activeToolClip, colour])
  // Live (uncommitted) slider value so the thumb tracks the drag before commit.
  const [pendingColour, setPendingColour] = useState({})

  const commitColour = useCallback((property, value) => {
    const clip = activeToolClip
    if (!clip) return
    const sceneId = rootSegmentId(clip.id)
    const numVal = Number(value)
    setPendingColour((p) => {
      const { [property]: _omit, ...rest } = p
      return rest
    })
    applyAndSave(
      (s) => ({
        ...s,
        colour: { ...s.colour, [sceneId]: { ...(s.colour?.[sceneId] || {}), [property]: numVal } },
      }),
      summarizeVisualAdjustment(property, numVal, 'Helper').announcement,
    )
  }, [activeToolClip, applyAndSave])

  // ---- Sound: mute toggle + scene-volume commit (probe Sound panel) ----
  // Target scene = the colour/visual target (selection, else playhead clip).
  // Mute is a synchronous toggle; volume commits on slider release / change-end
  // (mirroring the colour sliders) so a drag doesn't spam saves.
  const soundSceneId = activeToolClip ? activeToolClip.id : null
  const isMuted = getClipMuted({ clips }, soundSceneId)
  const soundSceneNumber = useMemo(() => {
    if (!activeToolClip) return null
    const idx = clips.findIndex((c) => c.id === activeToolClip.id)
    return idx >= 0 ? idx + 1 : null
  }, [clips, activeToolClip])
  const committedVolume = getClipVolume({ clips }, soundSceneId)
  const [pendingVolume, setPendingVolume] = useState(null)
  const shownVolume = pendingVolume != null ? pendingVolume : committedVolume

  const toggleMute = useCallback(() => {
    if (!activeToolClip) return
    const id = activeToolClip.id
    const next = !getClipMuted({ clips }, id)
    const label = soundSceneNumber ?? '?'
    applyAndSave(
      (s) => setClipMuted(s, id, next),
      next ? `Helper muted scene ${label}` : `Helper unmuted scene ${label}`,
    )
  }, [activeToolClip, clips, soundSceneNumber, applyAndSave])

  const commitVolume = useCallback((value) => {
    if (!activeToolClip) return
    const id = activeToolClip.id
    const numVal = Math.max(0, Math.min(200, Number(value)))
    setPendingVolume(null)
    const label = soundSceneNumber ?? '?'
    const announceText = numVal === 0
      ? `Helper muted scene ${label}`
      : `Helper set scene ${label} volume to ${numVal}%`
    applyAndSave((s) => setClipVolume(s, id, numVal), announceText)
  }, [activeToolClip, soundSceneNumber, applyAndSave])

  // ---- Keyboard ----
  const handleTimelineKeyDown = (e) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      handleSelectClip(selectedClipIndex === null ? 0 : Math.min(selectedClipIndex + 1, clips.length - 1))
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      handleSelectClip(selectedClipIndex === null ? 0 : Math.max(selectedClipIndex - 1, 0))
    }
  }

  const handleToolbarKeyDown = (e) => {
    const toolbar = toolbarRef.current
    if (!toolbar) return
    const buttons = Array.from(toolbar.querySelectorAll('button:not([disabled])'))
    const current = buttons.indexOf(document.activeElement)
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      buttons[current < buttons.length - 1 ? current + 1 : 0]?.focus()
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      buttons[current > 0 ? current - 1 : buttons.length - 1]?.focus()
    }
  }

  const getSourceName = (clip) => sources.find((s) => s.id === clip.sourceId)?.name || ''

  return (
    <div className="overflow-hidden" style={{ background: 'linear-gradient(180deg, #1a2d4d, #152240)' }}>
      {/* Edit Toolbar */}
      <div
        ref={toolbarRef}
        role="toolbar"
        aria-label="Edit toolbar"
        onKeyDown={handleToolbarKeyDown}
        className="flex flex-wrap items-center gap-1.5 p-2"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}
      >
        <ToolbarButton onClick={handleSplit} disabled={selectedClipIndex === null} label="Split clip at playhead">Split</ToolbarButton>
        <ToolbarButton onClick={handleDelete} disabled={selectedClipIndex === null} label="Delete selected clip">Delete</ToolbarButton>
        {selectedClipIndex !== null && (
          <>
            <ToolbarButton onClick={() => handleMove('up')} disabled={selectedClipIndex === 0} label="Move clip left">Move Left</ToolbarButton>
            <ToolbarButton onClick={() => handleMove('down')} disabled={selectedClipIndex >= clips.length - 1} label="Move clip right">Move Right</ToolbarButton>
          </>
        )}
        <div className="border-l border-white/30 h-6 mx-1" />
        <ToolbarButton
          onClick={() => setShowCaptionEditor((v) => !v)}
          label={showCaptionEditor ? 'Hide caption editor' : 'Show caption editor'}
        >
          {showCaptionEditor ? 'Hide Captions' : 'Add Caption'}
        </ToolbarButton>
        {onTextTool && (
          <>
            <div className="border-l border-white/30 h-6 mx-1" aria-hidden="true" />
            <button
              onClick={onTextTool}
              className={`px-3 py-1.5 rounded-md text-xs font-bold transition-colors focus:outline-2 focus:outline-offset-1 focus:outline-white ${
                textToolActive ? 'bg-[#fbbf24] text-[#1a1a2e]' : 'bg-white/20 text-white border border-white/30 hover:bg-white/30'
              }`}
              style={{ minHeight: '44px', minWidth: '44px' }}
              aria-label="Text overlay tool"
              aria-pressed={textToolActive}
            >
              T Text
            </button>
          </>
        )}
        <div className="border-l border-white/30 h-6 mx-1" aria-hidden="true" />
        <button
          onClick={() => setShowVisualPanel((v) => !v)}
          className={`px-3 py-1.5 rounded-md text-xs font-bold transition-colors focus:outline-2 focus:outline-offset-1 focus:outline-white ${
            showVisualPanel ? 'bg-[#38bdf8] text-[#082f49]' : 'bg-white/20 text-white border border-white/30 hover:bg-white/30'
          }`}
          style={{ minHeight: '44px', minWidth: '44px' }}
          aria-label={showVisualPanel ? 'Hide visual adjustments' : 'Show visual adjustments'}
          aria-pressed={showVisualPanel}
        >
          Visual
        </button>
        <div className="border-l border-white/30 h-6 mx-1" aria-hidden="true" />
        <button
          onClick={() => setShowSoundPanel((v) => !v)}
          className={`px-3 py-1.5 rounded-md text-xs font-bold transition-colors focus:outline-2 focus:outline-offset-1 focus:outline-white ${
            showSoundPanel ? 'bg-[#a855f7] text-white' : 'bg-white/20 text-white border border-white/30 hover:bg-white/30'
          }`}
          style={{ minHeight: '44px', minWidth: '44px' }}
          aria-label={showSoundPanel ? 'Hide sound panel' : 'Show sound panel'}
          aria-pressed={showSoundPanel}
        >
          Sound
        </button>
      </div>

      {/* Source indicators */}
      {sources.length > 1 && (
        <div className="flex flex-wrap gap-1.5 px-2 pt-2" aria-label="Video sources">
          {sources.map((source) => (
            <span
              key={source.id}
              className="inline-flex items-center gap-1.5 text-white/80 text-xs font-medium px-2.5 py-1 rounded-md"
              style={{ backgroundColor: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)' }}
            >
              {source.name}
            </span>
          ))}
        </div>
      )}

      {/* Timeline Strip */}
      <div
        ref={timelineRef}
        role="listbox"
        aria-label="Video timeline clips. Click to seek."
        tabIndex={0}
        onKeyDown={handleTimelineKeyDown}
        onClick={(e) => {
          if (!timelineRef.current || !onSeek) return
          const rect = timelineRef.current.getBoundingClientRect()
          const x = (e.clientX || 0) - rect.left
          const fraction = Math.max(0, Math.min(1, x / rect.width))
          onSeek(fraction * timelineTotalDuration)
        }}
        className="relative flex items-stretch mx-2 my-3 rounded-lg overflow-hidden cursor-pointer"
        style={{ height: '56px', backgroundColor: '#0f1d35', boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.3)' }}
      >
        {clips.map((clip, idx) => {
          const layout = clipLayouts[idx]
          const widthPercent = (layout.duration / timelineTotalDuration) * 100
          const isSelected = selectedClipIndex === idx
          const sourceName = sources.length > 1 ? getSourceName(clip) : ''
          return (
            <div
              key={clip.id}
              data-testid="timeline-clip"
              role="option"
              aria-selected={isSelected}
              aria-label={`${clip.name}${sourceName ? ` (${sourceName})` : ''}, ${layout.duration.toFixed(1)} seconds`}
              onClick={(e) => {
                e.stopPropagation()
                handleSelectClip(idx)
                if (onSeek && timelineRef.current) {
                  const rect = timelineRef.current.getBoundingClientRect()
                  const x = e.clientX - rect.left
                  const fraction = Math.max(0, Math.min(1, x / rect.width))
                  onSeek(fraction * timelineTotalDuration)
                }
              }}
              className="relative flex cursor-pointer select-none items-center justify-center overflow-hidden transition-[background,border-color,box-shadow,transform] duration-150"
              style={{
                width: `${widthPercent}%`,
                background: isSelected ? `linear-gradient(180deg, ${clip.color}, ${clip.color}cc)` : `linear-gradient(180deg, ${clip.color}dd, ${clip.color}99)`,
                border: isSelected ? '2px solid white' : '1px solid rgba(255,255,255,0.15)',
                borderRadius: '6px',
                margin: '0 1.5px',
                minWidth: '24px',
                boxShadow: isSelected ? '0 0 0 1px rgba(255,255,255,0.3), 0 2px 8px rgba(0,0,0,0.3)' : '0 1px 3px rgba(0,0,0,0.2)',
              }}
            >
              {isSelected && (
                <>
                  <div
                    role="slider"
                    aria-label={`Trim start of ${clip.name}`}
                    aria-valuemin={0}
                    aria-valuemax={clip.endTime - clip.startTime}
                    aria-valuenow={clip.trimStart}
                    aria-valuetext={`Trim start: ${(clip.trimStart || 0).toFixed(1)} seconds`}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                        e.preventDefault(); e.stopPropagation()
                        handleTrim(clip.id, 'left', +1)
                      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                        e.preventDefault(); e.stopPropagation()
                        handleTrim(clip.id, 'left', -1)
                      }
                    }}
                    className="absolute left-0 top-0 bottom-0 w-3 cursor-ew-resize z-10 flex items-center justify-center"
                    style={{ backgroundColor: 'rgba(255,255,255,0.5)', minHeight: '44px', minWidth: '44px' }}
                  >
                    <div className="w-0.5 h-4 bg-white rounded" />
                  </div>
                  <div
                    role="slider"
                    aria-label={`Trim end of ${clip.name}`}
                    aria-valuemin={0}
                    aria-valuemax={clip.endTime - clip.startTime}
                    aria-valuenow={clip.trimEnd}
                    aria-valuetext={`Trim end: ${(clip.trimEnd || 0).toFixed(1)} seconds`}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                        e.preventDefault(); e.stopPropagation()
                        handleTrim(clip.id, 'right', +1)
                      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                        e.preventDefault(); e.stopPropagation()
                        handleTrim(clip.id, 'right', -1)
                      }
                    }}
                    className="absolute right-0 top-0 bottom-0 w-3 cursor-ew-resize z-10 flex items-center justify-center"
                    style={{ backgroundColor: 'rgba(255,255,255,0.5)', minHeight: '44px', minWidth: '44px' }}
                  >
                    <div className="w-0.5 h-4 bg-white rounded" />
                  </div>
                </>
              )}
              <span
                className="text-white text-xs font-medium truncate px-2 pointer-events-none flex flex-col items-center leading-tight"
                style={{ textShadow: '0 1px 2px rgba(0,0,0,0.6)' }}
              >
                <span className="truncate max-w-full">{clip.name}</span>
                {sourceName && <span className="text-white/50 text-[10px] truncate max-w-full">{sourceName}</span>}
              </span>
            </div>
          )
        })}

        <div
          className="absolute top-0 bottom-0 z-20 pointer-events-none"
          style={{ left: `${playheadPercent}%`, width: '2px', background: 'white', boxShadow: '0 0 6px rgba(255,255,255,0.5)' }}
        >
          <div className="absolute -top-0.5 rounded-sm" style={{ left: '-4px', width: '10px', height: '6px', background: 'white', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }} />
        </div>
      </div>

      {/* Caption Editor */}
      {showCaptionEditor && (
        <div className="mx-2 mb-3 p-3 rounded-lg" style={{ backgroundColor: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
          <h3 className="text-white text-sm font-semibold mb-2">Caption Editor</h3>
          <div className="flex flex-wrap gap-2 items-end mb-3">
            <div className="flex-1 min-w-[160px]">
              <label htmlFor="caption-text" className="text-white/70 text-xs block mb-1">Caption text</label>
              <input
                id="caption-text"
                type="text"
                value={captionText}
                onChange={(e) => setCaptionText(e.target.value)}
                placeholder="Enter caption..."
                className="w-full px-2 py-1.5 rounded text-sm bg-white/10 text-white border border-white/20 focus:outline-none focus:border-white/50"
              />
            </div>
            <button
              onClick={handleAddCaption}
              disabled={!captionText.trim()}
              aria-label="Add caption"
              className="px-3 py-1.5 rounded text-sm text-white font-medium disabled:opacity-40"
              style={{ backgroundColor: '#2B579A', minHeight: '44px', minWidth: '44px' }}
            >
              Add
            </button>
          </div>
          {captions.length === 0 && <p className="text-white/40 text-xs">No captions added yet.</p>}
          {captions.length > 0 && (
            <ul className="space-y-1" aria-label="Captions list">
              {captions.map((cap) => (
                <li key={cap.id} className="px-2 py-1 rounded text-sm text-white bg-white/5 truncate">"{cap.text}"</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Visual adjustments — colour PERSISTS on commit (slider release). */}
      {showVisualPanel && (
        <div className="mx-2 mb-3 p-3 rounded-lg" style={{ backgroundColor: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-white/70">Visual Adjustments</h4>
            <span className="text-[10px] font-bold uppercase tracking-wide text-amber-300">Preview only until export</span>
          </div>
          {activeToolClip ? (
            <div className="space-y-3">
              {COLOUR_SLIDERS.map((slider) => {
                const committed = colourValues[slider.id]
                const shown = slider.id in pendingColour ? pendingColour[slider.id] : committed
                return (
                  <div key={slider.id}>
                    <label className="flex items-center justify-between text-sm mb-1 text-white/85">
                      <span>{slider.label}</span>
                      <span className="text-xs text-white/50">{shown}{slider.suffix}</span>
                    </label>
                    <input
                      type="range"
                      min={slider.min}
                      max={slider.max}
                      step={slider.step}
                      value={shown}
                      onChange={(e) => setPendingColour((p) => ({ ...p, [slider.id]: Number(e.target.value) }))}
                      onPointerUp={(e) => commitColour(slider.id, e.target.value)}
                      onKeyUp={(e) => { if (e.key.startsWith('Arrow')) commitColour(slider.id, e.target.value) }}
                      className="w-full h-2 rounded-lg appearance-none cursor-pointer accent-blue-600 bg-white/20"
                      aria-label={`${slider.label}: ${shown}${slider.suffix}`}
                      style={{ minHeight: '44px' }}
                    />
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="text-white/50 text-xs">Select a clip on the timeline (or play one) to adjust.</p>
          )}
        </div>
      )}

      {/* Sound — mute the original scene audio + per-scene volume. Volume
          PERSISTS on commit (slider release / change-end), like the colour
          sliders. The SOUND_LIBRARY "attach sound" feature is intentionally
          NOT here (it needs a real audio-asset pipeline). */}
      {showSoundPanel && (
        <div className="mx-2 mb-3 p-3 rounded-lg" style={{ backgroundColor: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-white text-sm font-semibold">Sound</h3>
            <span className="text-[10px] font-bold uppercase tracking-wide text-amber-300">Preview only until export</span>
          </div>
          {activeToolClip ? (
            <div className="space-y-3">
              <p className="text-white/70 text-xs">
                Target: Scene {soundSceneNumber}
                {isMuted && (
                  <span className="ml-2 inline-block px-2 py-0.5 rounded-full bg-amber-500/30 text-amber-200">
                    original muted
                  </span>
                )}
              </p>
              <button
                type="button"
                onClick={toggleMute}
                aria-pressed={isMuted}
                aria-label={
                  isMuted
                    ? `Unmute the original audio for scene ${soundSceneNumber}`
                    : `Mute the original audio for scene ${soundSceneNumber}`
                }
                className={`w-full py-2 text-sm font-bold rounded border transition-colors focus:outline-2 focus:outline-offset-1 focus:outline-white ${
                  isMuted
                    ? 'bg-amber-600 text-white border-amber-700'
                    : 'bg-white/20 text-white border-white/30 hover:bg-white/30'
                }`}
                style={{ minHeight: '44px' }}
              >
                {isMuted ? 'Unmute original audio' : 'Mute original audio'}
              </button>
              <div>
                <label className="flex items-center justify-between text-sm mb-1 text-white/85">
                  <span>Scene volume</span>
                  <span className="text-xs text-white/50">{shownVolume}%</span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={200}
                  step={10}
                  value={shownVolume}
                  onChange={(e) => setPendingVolume(Number(e.target.value))}
                  onPointerUp={(e) => commitVolume(e.target.value)}
                  onKeyUp={(e) => { if (e.key.startsWith('Arrow')) commitVolume(e.target.value) }}
                  className="w-full h-2 rounded-lg appearance-none cursor-pointer accent-purple-500 bg-white/20"
                  aria-label={`Scene ${soundSceneNumber} volume: ${shownVolume} percent`}
                  style={{ minHeight: '44px' }}
                />
              </div>
            </div>
          ) : (
            <p className="text-white/50 text-xs">Select a clip on the timeline (or play one) to adjust sound.</p>
          )}
        </div>
      )}
      {pendingDelete && (
        <ConfirmEditDialog
          title="Delete clip"
          question={`Delete ${pendingDelete.name} from the timeline?`}
          confirmLabel="Delete"
          destructive
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  )
}

function ToolbarButton({ children, onClick, disabled, label }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="rounded-md px-3 py-1.5 text-xs font-semibold text-white/90 transition-[background-color,opacity,transform] duration-150 hover:bg-white/15 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-30"
      style={{ backgroundColor: 'rgba(255,255,255,0.08)', minHeight: '44px', minWidth: '44px', border: '1px solid rgba(255,255,255,0.1)' }}
    >
      {children}
    </button>
  )
}
