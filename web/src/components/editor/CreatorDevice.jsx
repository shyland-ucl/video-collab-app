import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { rootSegmentId } from '../../lib/editor/stateStore'
import { buildEditChangeSceneStamp } from '../../lib/editor/editChangeStamp'
import usePlaybackEngine, { computeClipLayout } from '../../hooks/usePlaybackEngine'
import { colourValuesToFilter, colourValuesToTransform } from './HelperDevice'
import SceneBlockList from './sceneblocks/SceneBlockList'
import SceneActions from './SceneActions'

/**
 * Creator device — the primary interface for a blind/low-vision creator.
 *
 * Phase 2a Task 3: rebuilt around the Probe 3 SceneBlockList experience
 * (pinned visually-only video at top + inline collapsible scene blocks with a
 * per-scene 3-level detail picker and per-scene actions), replacing the old
 * single-scene ExplorationMode modal. This is a faithful UX port of the probe's
 * Probe3Page creator branch
 * (video-collab-probe/src/pages/Probe3Page.jsx, `role === 'creator'`) — same
 * layout (max-w-lg, pinned video, SceneBlockList over scenes) and the same
 * bounded/unbounded play semantics (handlePlaySegment vs onPlay) — but wired to
 * THIS app's realtime backend instead of the study's wsRelayService/logEvent.
 *
 * Prop contract (EditorPage — UNCHANGED): { role, projectId, user, state,
 * version, sources, descriptions, tasks, applyAndSave, channel, remote,
 * onCreateTask, onSetTaskStatus, syncDown }.
 *
 * Stripped per the adaptation contract (vs the probe creator branch):
 * - wsRelayService PLAY/PAUSE/SEEK/EDIT_STATE_UPDATE sends → channel.send* +
 *   applyAndSave (EditorPage persists + Realtime distributes)
 * - EventLoggerContext / logEvent / EventTypes / Actors — deleted
 * - the Phase 3 AI-suggestion engine (AIAnalysisTriggerCard, curatedSuggestions,
 *   sceneIndicesWithSuggestions, suggestion routing) — deferred to Phase 3
 * - vqaHistories / awarenessData / onAwarenessViewed — the per-scene VQA lives
 *   inside SceneActions (Task 2); awareness telemetry is study-only
 *
 * Replaced:
 * - PLAY/PAUSE/SEEK WS sends → channel.sendTransport({ action, time })
 * - 2s STATE_UPDATE cadence → channel.sendPlayhead({ isPlaying, time, segmentId })
 * - probe VideoPlayer (visual-only, aria-hidden + inert) → the same pattern
 *   driven directly by usePlaybackEngine over the `sources` signed URLs
 */

const PLAYHEAD_INTERVAL_MS = 2000
const SEGMENT_END_EPSILON = 0.05

const TASK_STATUS_TEXT = {
  pending: 'Sent to helper',
  done: 'Helper: Done',
  needs_discussion: 'Helper: Needs discussion',
  cant_do: "Helper: Can't do",
}

const ACCENT = '#9B59B6' // Probe 3 creator primary (purple)

export default function CreatorDevice({
  projectId,
  state,
  sources,
  descriptions,
  tasks,
  applyAndSave,
  channel,
  onCreateTask,
  initialVideoId = null,
}) {
  const clips = useMemo(() => state?.clips ?? [], [state])
  const captions = state?.captions ?? []

  // Optional "open from a chosen video" landing: resolve the index of the first
  // clip belonging to initialVideoId so SceneBlockList can expand/scroll to it
  // once on mount. The whole-project timeline is unchanged; this is a view jump.
  // Absent or unmatched id → null → SceneBlockList expands nothing.
  const initialExpandedIndex = useMemo(() => {
    if (!initialVideoId) return null
    const idx = clips.findIndex((clip) => clip.sourceId === initialVideoId)
    return idx === -1 ? null : idx
  }, [clips, initialVideoId])

  // clipId → clip, so renderSceneActions can resolve the real (camelCase) app
  // clip from the snake_case scene SceneBlockList hands it.
  const clipsById = useMemo(() => new Map(clips.map((c) => [c.id, c])), [clips])

  // ---------------------------------------------------------------------------
  // Playback — one hidden <video> per source, sequenced by the EDL engine
  // (the probe's creator player was identical: aria-hidden + inert, visual/audio
  // only; the scene-block list below is the accessible surface).
  // ---------------------------------------------------------------------------
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

  // Bounded "Play this scene": the EDL offset at which playback should stop.
  // While set, the SceneBlockList auto-follow is suppressed (disableAutoFollow)
  // so a timeUpdate tick that lands a few ms past the boundary can't expand the
  // next block before the boundary pause takes effect (probe Day-1 fix #2).
  const [playingSegmentEnd, setPlayingSegmentEnd] = useState(null)

  const activeClip = clips[engine.currentClipIndex] ?? null

  // ---- Colour → CSS for the active scene (helper colour sync) ----
  // The helper grades colour into state.colour[rootSegmentId(sceneId)]; that map
  // rides the same project_state → realtime → state path the creator already
  // consumes. We render the SAME filter/transform the helper preview does (via
  // the shared colourValuesToFilter/Transform) so the BLV creator's pinned
  // video reflects the adjustment — previously this <video> had no filter at all
  // and the colour change reached the creator invisibly.
  const colour = state?.colour ?? {}
  const activeColour = activeClip ? colour?.[rootSegmentId(activeClip.id)] : null
  const videoFilter = useMemo(() => colourValuesToFilter(activeColour), [activeColour])
  const videoTransform = useMemo(() => colourValuesToTransform(activeColour), [activeColour])

  // Refs so the broadcast effects/interval + the boundary watcher read fresh
  // values without re-running.
  const playingRef = useRef(false)
  playingRef.current = isPlaying
  const timeRef = useRef(0)
  timeRef.current = engine.edlTime
  const activeClipRef = useRef(null)
  activeClipRef.current = activeClip
  const stateRef = useRef(state)
  stateRef.current = state

  // Bounded-playback boundary watcher: pause at the scene end and KEEP
  // playingSegmentEnd set through the pause so disableAutoFollow holds (probe
  // handleTimeUpdate). Stop also when playback runs off the end of the timeline.
  useEffect(() => {
    if (!isPlaying) return
    if (playingSegmentEnd != null && engine.edlTime >= playingSegmentEnd - SEGMENT_END_EPSILON) {
      engine.pause()
      setIsPlaying(false)
      return
    }
    if (engine.totalDuration > 0 && engine.edlTime >= engine.totalDuration) {
      setIsPlaying(false)
    }
  }, [isPlaying, engine, engine.edlTime, engine.totalDuration, playingSegmentEnd])

  // Send play/pause to the helper when the transport flips (probe cadence).
  const prevPlayingRef = useRef(false)
  useEffect(() => {
    if (prevPlayingRef.current === isPlaying) return
    prevPlayingRef.current = isPlaying
    channel.sendTransport({ action: isPlaying ? 'play' : 'pause', time: timeRef.current })
  }, [isPlaying, channel])

  // Periodic playhead broadcast (~2s — the probe's STATE_UPDATE cadence).
  useEffect(() => {
    const interval = setInterval(() => {
      channel.sendPlayhead({
        isPlaying: playingRef.current,
        time: timeRef.current,
        segmentId: activeClipRef.current?.id ?? null,
      })
    }, PLAYHEAD_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [channel])

  const seekToClip = useCallback(
    (clip) => {
      if (!clip) return null
      const layout = computeClipLayout(stateRef.current?.clips ?? [])
      const entry = layout.find((e) => e.clip.id === clip.id)
      if (!entry) return null
      engine.seekEdl(entry.edlOffset)
      channel.sendTransport({ action: 'seek', time: entry.edlOffset })
      return entry
    },
    [engine, channel]
  )

  // Bounded "Play this scene": seek to the clip start, play, and stop at the
  // clip's EDL end. disableAutoFollow holds while playingSegmentEnd is set.
  const playScene = useCallback(
    (clip) => {
      const entry = seekToClip(clip)
      if (!entry) return
      setPlayingSegmentEnd(entry.edlOffset + entry.duration)
      engine.play()
      setIsPlaying(true)
    },
    [seekToClip, engine]
  )

  // Unbounded "Play from here": seek + play, continues across scene boundaries;
  // auto-follow stays on (playingSegmentEnd cleared).
  const playFromHere = useCallback(
    (clip) => {
      setPlayingSegmentEnd(null)
      seekToClip(clip)
      engine.play()
      setIsPlaying(true)
    },
    [seekToClip, engine]
  )

  const pause = useCallback(() => {
    setPlayingSegmentEnd(null)
    engine.pause()
    setIsPlaying(false)
  }, [engine])

  // Auto-follow seek (SceneBlockList onSeek): expand-driven seeks that should
  // NOT start a bounded segment. Used when the user expands a block.
  const handleSeek = useCallback(
    (edlTime) => {
      setPlayingSegmentEnd(null)
      engine.seekEdl(edlTime)
      channel.sendTransport({ action: 'seek', time: edlTime })
    },
    [engine, channel]
  )

  // ---------------------------------------------------------------------------
  // Edit stamps (amber "Edited" badge + "what changed" line).
  //
  // Approach: a single state-diff watcher. Whenever the `state` prop changes
  // (local applyAndSave optimistic apply OR a remote insert landing via
  // EditorPage), diff the previous state against the next with the purpose-built
  // `buildEditChangeSceneStamp` (ported from the study probe). It resolves the
  // edited scene id and the "what changed" text TOGETHER from one diff, so the
  // badge text and the scene it lands on can never disagree (the old approach
  // derived text and scene id from two separate helpers, which could drift —
  // e.g. on delete the text said one scene while the id pointed at another).
  // We don't attribute actor precisely (local edits stamp 'You'); the goal is
  // the badge + change line appearing on the freshly-edited scene. Stamps
  // overwrite per scene id in the map.
  // ---------------------------------------------------------------------------
  const [editedScenes, setEditedScenes] = useState({})
  const prevStateForStampRef = useRef(state)
  useEffect(() => {
    const prev = prevStateForStampRef.current
    prevStateForStampRef.current = state
    if (!prev || prev === state) return
    const stamp = buildEditChangeSceneStamp(prev, state, {
      fallbackSceneId: activeClip?.id,
    })
    if (!stamp?.sceneId) return
    setEditedScenes((cur) => ({
      ...cur,
      [stamp.sceneId]: { text: stamp.text, actor: 'You', timestamp: Date.now() },
    }))
  }, [state, activeClip?.id])

  // ---------------------------------------------------------------------------
  // Scene shape SceneBlockList consumes (snake_case + level_N descriptions),
  // derived from state.clips + descriptions[rootSegmentId(clip.id)].
  // ---------------------------------------------------------------------------
  const scenes = useMemo(
    () =>
      clips.map((clip) => {
        const desc = descriptions[rootSegmentId(clip.id)] ?? {}
        return {
          id: clip.id,
          name: clip.name,
          color: clip.color,
          start_time: clip.startTime,
          end_time: clip.endTime,
          descriptions: { level_1: desc[1], level_2: desc[2], level_3: desc[3] },
        }
      }),
    [clips, descriptions]
  )

  const renderSceneActions = useCallback(
    (args) => {
      const { scene, currentLevel, onLevelChange, isPlaying: ip, currentTime: ct } = args
      const clip = clipsById.get(scene.id)
      if (!clip) return null
      const isActiveScene =
        ip && ct >= scene.start_time && ct < scene.end_time
      return (
        <SceneActions
          clip={clip}
          allClips={clips}
          projectId={projectId}
          level={currentLevel}
          onLevelChange={onLevelChange}
          descriptions={descriptions}
          isPlaying={ip}
          isActiveScene={isActiveScene}
          onPlayScene={playScene}
          onPlayFromHere={playFromHere}
          onPause={pause}
          applyAndSave={applyAndSave}
          onCreateTask={onCreateTask}
        />
      )
    },
    [clipsById, clips, projectId, descriptions, playScene, playFromHere, pause, applyAndSave, onCreateTask]
  )

  return (
    <div role="region" aria-label="Creator device" className="flex flex-col flex-1 min-h-0 max-w-lg mx-auto w-full">
      {/* Video player — visual only (probe pattern: out of the AT tree; the
          scene-block list below is the accessible surface).
          React 19: `inert` is a real boolean prop. */}
      <div aria-hidden="true" inert className="flex-shrink-0 pointer-events-none mb-2">
        <div
          className="relative bg-black mx-auto overflow-hidden rounded-xl"
          style={{ aspectRatio: '16 / 9', width: '100%', maxHeight: '32vh' }}
        >
          {sources.map((source, idx) => {
            const isActive = engine.activeSourceId ? engine.activeSourceId === source.id : idx === 0
            return (
              <video
                key={source.id}
                ref={(el) => {
                  if (videoRefs[source.id]) videoRefs[source.id].current = el
                }}
                src={source.src ?? undefined}
                className="w-full h-full object-contain absolute inset-0"
                style={{
                  display: isActive ? 'block' : 'none',
                  // The active scene's grade applies to whichever source is
                  // visible; only the active source is shown, so applying to all
                  // is harmless. Mirrors EditorVideoPlayer's helper preview.
                  filter: videoFilter || undefined,
                  transform: videoTransform || undefined,
                  transformOrigin: 'center center',
                  transition: 'transform 0.2s ease-out',
                }}
                preload="metadata"
                playsInline
                aria-hidden="true"
                tabIndex={-1}
              />
            )
          })}
          {engine.activeCaption && (
            <div
              className="absolute bottom-0 left-0 right-0 flex justify-center pointer-events-none"
              style={{ padding: '0 8px 16px' }}
            >
              <div
                className="px-4 py-2 rounded text-white text-center max-w-[90%]"
                style={{ backgroundColor: 'rgba(0, 0, 0, 0.75)', textShadow: '0 1px 3px rgba(0,0,0,0.8)', lineHeight: 1.4 }}
              >
                {engine.activeCaption.text}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Probe 3 scene-block list — the accessible scene-by-scene surface.
          It owns its own keyboard model (expand/collapse/detail/auto-follow). */}
      <SceneBlockList
        scenes={scenes}
        currentTime={engine.edlTime}
        isPlaying={isPlaying}
        onSeek={handleSeek}
        onPlay={playFromHere}
        onPause={pause}
        accentColor={ACCENT}
        videoCount={sources.length || 1}
        disableAutoFollow={playingSegmentEnd != null}
        editedScenes={editedScenes}
        editState={state}
        initialExpandedIndex={initialExpandedIndex}
        renderSceneActions={renderSceneActions}
      />

      {/* Recent Tasks — rendered from the tasks prop; status-change
          announcements happen in EditorPage, not here. */}
      {tasks.length > 0 && (
        <div role="region" aria-label="Recent tasks" className="flex-shrink-0 border-2 border-[#64748b] rounded-xl overflow-hidden bg-white mt-3">
          <div className="bg-[#f1f5f9] px-3 py-2.5 border-b border-[#cbd5e1]">
            <span className="text-xs font-bold tracking-wide text-[#475569] uppercase">
              Recent Tasks ({tasks.length})
            </span>
          </div>
          <div className="divide-y divide-gray-100 max-h-48 overflow-y-auto">
            {tasks.slice(0, 10).map((task) => (
              <div key={task.id} className="px-4 py-2.5 flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-800 truncate">{task.text}</p>
                  {task.segment_label && (
                    <p className="text-xs text-gray-500 mt-0.5">{task.segment_label}</p>
                  )}
                  <p className="text-xs text-gray-600 mt-0.5">
                    {TASK_STATUS_TEXT[task.status] ?? task.status}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
