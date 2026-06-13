import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { rootSegmentId } from '../../lib/editor/stateStore'
import { formatDuration } from '../../lib/editor/projectOverview'
import usePlaybackEngine, { computeClipLayout } from '../../hooks/usePlaybackEngine'
import useTextOverlay from '../../hooks/useTextOverlay'
import EditorVideoPlayer from './EditorVideoPlayer'
import TransportControls from './TransportControls'
import EditorTimeline from './EditorTimeline'
import SegmentMarkerPanel from './SegmentMarkerPanel'
import ActivityFeed from './ActivityFeed'
import TextOverlaySettings from './TextOverlaySettings'

/**
 * Helper device — the sighted collaborator's editing surface.
 * Ported from probe src/components/decoupled/DecoupledHelperDevice.jsx (Task 10).
 *
 * Prop contract (EditorPage): { role, projectId, user, state, version,
 * sources, descriptions, tasks, applyAndSave, channel, remote, onCreateTask,
 * onSetTaskStatus, syncDown }.
 *
 * Stripped per the adaptation contract:
 * - buildAllSegments/getTotalDuration/eventTypes(Actors) imports — the scene
 *   list IS state.clips; durations come from the layout
 * - webrtcService + sendActivity('ACTIVITY' WS) → `channel.sendActivity`
 * - creatorActivities/feedItems props assembled by a probe page → creator
 *   activity is accumulated locally from `remote.activity`; the task feed is
 *   derived from the `tasks` prop
 * - useSceneSoundPlayback (placeholder sound catalogue) — deleted
 * - peerEditNotification toast → EditorPage owns the remote-change toast +
 *   announce (ProjectUpdateToast is rendered there)
 * - onAIReview/onAIUndo/onSuggestionResponse/onAwarenessViewed + the
 *   suggestion/AI-edit feed branches — Phase 3, deleted
 * - condition/accentColor props — only the probe2b/3 behavior remains
 *
 * Adapted:
 * - TASK_STATUS_UPDATE WS → `onSetTaskStatus(taskId, status)` (done /
 *   needs_discussion / cant_do)
 * - COLOUR_UPDATE transient WS → colour PERSISTS through applyAndSave into
 *   state.colour[sceneId] on slider commit (EditorTimeline)
 * - creator playhead via STATE_UPDATE → `remote.playhead` / `remote.transport`
 *   drive the pinned preview; the helper's own scrubbing stays local and emits
 *   `channel.sendActivity({ action: 'Seeked', detail: formatDuration(time) })`
 * - text overlays persist through applyAndSave into state.textOverlays
 */

// brightness/contrast/saturation sliders are -100..100 (0 neutral); zoom is
// 100..250%. Port of probe editStateView.colourValuesToFilter/Transform.
function colourValuesToFilter(values) {
  if (!values) return undefined
  const { brightness = 0, contrast = 0, saturation = 0 } = values
  if (brightness === 0 && contrast === 0 && saturation === 0) return undefined
  const b = (1 + brightness / 200).toFixed(3)
  const c = (1 + contrast / 200).toFixed(3)
  const s = (1 + saturation / 100).toFixed(3)
  return `brightness(${b}) contrast(${c}) saturate(${s})`
}
function colourValuesToTransform(values) {
  if (!values) return undefined
  const { zoom = 100 } = values
  if (zoom === 100) return undefined
  return `scale(${(zoom / 100).toFixed(3)})`
}

export default function HelperDevice({
  state,
  sources,
  tasks,
  applyAndSave,
  channel,
  remote,
  onSetTaskStatus,
}) {
  const clips = useMemo(() => state?.clips ?? [], [state])
  const captions = state?.captions ?? []
  const textOverlaysState = state?.textOverlays ?? []
  const colour = state?.colour ?? {}

  // ---- Playback engine: one hidden <video> per source, EDL-sequenced ----
  const videoRefsMapRef = useRef({})
  const videoRefs = useMemo(() => {
    const map = videoRefsMapRef.current
    for (const source of sources) {
      if (!map[source.id]) map[source.id] = { current: null }
    }
    return { ...map }
  }, [sources])

  const engine = usePlaybackEngine(null, clips, captions, clips.length > 0, videoRefs)
  const [isPlaying, setIsPlaying] = useState(false)
  const activeClip = clips[engine.currentClipIndex] ?? null

  // ---- Text overlays — persist through applyAndSave into state.textOverlays ----
  // Guard against the hook's mount echo: only persist when the overlay set
  // actually differs from what's already in shared state (a no-op save would
  // bump the version and clobber a concurrent edit).
  const overlaySignature = (arr = []) =>
    arr.map((o) => `${o.id}:${o.content}:${o.size}:${o.color}:${o.x}:${o.y}:${o.appliedAt || ''}:${o.sceneId || ''}`).join('|')
  const persistOverlays = useCallback((nextOverlays) => {
    if (overlaySignature(nextOverlays) === overlaySignature(state?.textOverlays ?? [])) return
    applyAndSave(
      (s) => ({ ...s, textOverlays: nextOverlays }),
      undefined,
    )
  }, [applyAndSave, state])

  const {
    textOverlays, activeOverlay, activeOverlayId, textToolActive,
    handleTextTool, handleTextMove, handleTextChange, handleTextApply, handleTextRemove,
  } = useTextOverlay({
    initialOverlays: textOverlaysState,
    onOverlaysChange: persistOverlays,
    sceneId: activeClip?.id || null,
  })

  // ---- Local scrub + transport ----
  const seekTo = useCallback((time) => {
    engine.seekEdl(time)
    channel.sendActivity({ action: 'Seeked', detail: formatDuration(time) })
  }, [engine, channel])

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      engine.pause()
      setIsPlaying(false)
    } else {
      engine.play()
      setIsPlaying(true)
    }
  }, [engine, isPlaying])

  const getCurrentTime = useCallback(() => engine.edlTime, [engine])

  // ---- Synced preview: the creator's transport drives the pinned preview. ----
  const lastTransportRef = useRef(null)
  useEffect(() => {
    const transport = remote?.transport
    if (!transport || transport === lastTransportRef.current) return
    lastTransportRef.current = transport
    const { action, time } = transport
    if (typeof time === 'number') engine.seekEdl(time)
    if (action === 'play') {
      engine.play()
      setIsPlaying(true)
    } else if (action === 'pause') {
      engine.pause()
      setIsPlaying(false)
    }
    // 'seek' just repositions (handled by seekEdl above).
  }, [remote?.transport, engine])

  // ---- Creator activity feed: accumulate latest remote.activity payloads. ----
  const [creatorActivities, setCreatorActivities] = useState([])
  const lastActivityRef = useRef(null)
  useEffect(() => {
    const activity = remote?.activity
    if (!activity || activity === lastActivityRef.current) return
    lastActivityRef.current = activity
    setCreatorActivities((prev) => [
      ...prev,
      { ...activity, key: `${prev.length}-${activity.action}-${activity.detail ?? ''}` },
    ])
  }, [remote?.activity])

  // ---- Colour → CSS for the active scene ----
  const activeColour = activeClip ? colour?.[rootSegmentId(activeClip.id)] : null
  const videoFilter = useMemo(() => colourValuesToFilter(activeColour), [activeColour])
  const videoTransform = useMemo(() => colourValuesToTransform(activeColour), [activeColour])

  // Segment for the marker panel (probe shape: start_time/end_time/color).
  const markerSegment = activeClip
    ? {
        id: activeClip.id,
        name: activeClip.name,
        color: activeClip.color,
        start_time: activeClip.startTime + (activeClip.trimStart || 0),
        end_time: activeClip.endTime - (activeClip.trimEnd || 0),
      }
    : null

  const totalDuration = engine.totalDuration

  return (
    <div className="flex-1 flex flex-col min-h-0" role="region" aria-label="Helper device">
      {/* Pinned preview */}
      <div className="flex-shrink-0 mb-4">
        <div
          role="region"
          aria-label="Video preview"
          className="rounded-2xl overflow-hidden bg-white"
          style={{ border: '1px solid #dfe4ea', boxShadow: '0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.03)' }}
        >
          <div className="relative">
            <EditorVideoPlayer
              sources={sources}
              videoRefs={videoRefs}
              activeSourceId={engine.activeSourceId}
              activeClip={activeClip}
              activeCaption={engine.activeCaption}
              textOverlays={textOverlays}
              videoFilter={videoFilter}
              videoTransform={videoTransform}
              maxHeight="32vh"
              editingOverlayId={activeOverlayId}
              onOverlayMove={handleTextMove}
            />
            {/* The text overlays are rendered inside EditorVideoPlayer; the
                drag-edit handle is the active overlay (handled there). */}
          </div>
          <TransportControls
            isPlaying={isPlaying}
            currentTime={engine.edlTime}
            duration={totalDuration}
            onPlayPause={handlePlayPause}
            onSeek={seekTo}
            getCurrentTime={getCurrentTime}
          />
        </div>
      </div>

      {/* Scrollable: activity feed + editor tools */}
      <div className="flex-1 min-h-0 overflow-y-auto" style={{ WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' }}>
        {/* Creator Intent Banner — most recent unfinished task from the feed */}
        {(() => {
          const activeTask = [...tasks].reverse().find((t) => !t.status || t.status === 'pending' || t.status === 'sent')
          if (!activeTask) return null
          return (
            <div
              role="region"
              aria-label="Creator's current request"
              className="rounded-xl px-4 py-3 mb-4 border-l-4"
              style={{ borderColor: '#E67E22', backgroundColor: '#FFF8F1' }}
            >
              <p className="text-xs font-bold text-orange-700 uppercase tracking-wider mb-1">Creator's Intent</p>
              <p className="text-sm text-gray-800 font-medium">{activeTask.text || 'Task from creator'}</p>
              {activeTask.segment_label && (
                <div className="flex gap-2 mt-1">
                  <span className="text-xs px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">{activeTask.segment_label}</span>
                </div>
              )}
            </div>
          )
        })()}

        {/* Activity Feed */}
        <div role="region" aria-label="Tasks and activity" className="rounded-2xl overflow-hidden mb-4" style={{ border: '1px solid rgba(230,126,34,0.2)', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
          <div className="px-4 py-2.5" style={{ background: '#fff8f1', borderBottom: '1px solid #fde8d0' }}>
            <h2 className="text-xs font-bold tracking-wider text-[#c2410c] uppercase">
              Activity Feed {tasks.length > 0 ? `(${tasks.length})` : ''}
            </h2>
          </div>
          <ActivityFeed
            tasks={tasks}
            creatorActivities={creatorActivities}
            onSetTaskStatus={onSetTaskStatus}
          />
        </div>

        {/* Editor tools */}
        <div role="region" aria-label="Editor tools" className="rounded-2xl overflow-hidden" style={{ border: '1px solid #dfe4ea', boxShadow: '0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.03)' }}>
          <div className="px-4 py-2.5" style={{ background: '#f8f9fb', borderBottom: '1px solid #eef2f7' }}>
            <h2 className="text-xs font-bold tracking-wider text-[#64748b] uppercase">Video Editor</h2>
          </div>
          <div className="flex flex-col">
            <EditorTimeline
              clips={clips}
              captions={captions}
              sources={sources}
              currentTime={engine.edlTime}
              colour={colour}
              applyAndSave={applyAndSave}
              onSeek={seekTo}
              onTextTool={handleTextTool}
              textToolActive={textToolActive}
            />
            <SegmentMarkerPanel segment={markerSegment} />
          </div>
        </div>

        {/* Text Overlay Settings (active overlay only) */}
        {activeOverlay && (
          <TextOverlaySettings
            overlay={activeOverlay}
            onChange={handleTextChange}
            onApply={handleTextApply}
            onRemove={handleTextRemove}
          />
        )}
      </div>
    </div>
  )
}
