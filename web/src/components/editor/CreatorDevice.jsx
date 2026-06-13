import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { rootSegmentId } from '../../lib/editor/stateStore'
import { buildEditChangeSceneStamp } from '../../lib/editor/editChangeStamp'
import { suggestionClip, fixTemplateToOpFn, describeFixTemplate } from '../../lib/editor/suggestionRouting'
import { serverPost } from '../../lib/serverApi'
import { announce } from '../../utils/announcer'
import { playEarcon } from '../../utils/earcon'
import usePlaybackEngine, { computeClipLayout } from '../../hooks/usePlaybackEngine'
import { colourValuesToFilter, colourValuesToTransform } from './HelperDevice'
import SceneBlockList from './sceneblocks/SceneBlockList'
import SceneActions from './SceneActions'
import AIAnalysisTriggerCard from './AIAnalysisTriggerCard'
import SuggestionItem from './SuggestionItem'
import ConfirmEditDialog from './ConfirmEditDialog'
import { describeProposal, proposalToOpFn } from './ConfirmAiEditDialog'
import TextOverlay from './TextOverlay'

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
  suggestions = [],
  applyAndSave,
  channel,
  onCreateTask,
  onAnalyse,
  onResolveSuggestion = () => {},
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

  // ---- Helper-added TEXT OVERLAYS for the active scene ----
  // Overlays live in state.textOverlays (same project_state → realtime → state
  // path the creator already consumes for captions + colour). The helper preview
  // (EditorVideoPlayer) and the probe creator both render them; the creator's
  // pinned video must too, or a helper-added overlay reaches the creator
  // invisibly. We mirror EditorVideoPlayer exactly: filter by the active scene's
  // rootSegmentId (so a split's halves resolve to the original scene). Rendered
  // isEditing=false → pointer-events-none + out of the AT tree, preserving the
  // visual-only/inert creator contract.
  const textOverlays = state?.textOverlays ?? []
  const activeSceneId = activeClip?.id ? rootSegmentId(activeClip.id) : null
  const visibleTextOverlays = useMemo(
    () =>
      textOverlays.filter(
        (o) => !o.sceneId || (activeSceneId && rootSegmentId(o.sceneId) === activeSceneId)
      ),
    [textOverlays, activeSceneId]
  )

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

  // ---------------------------------------------------------------------------
  // Phase 3b — AI suggestions. The trigger analyses the focused video (the one
  // the library picker opened, else the first source). Suggestions persist +
  // arrive via realtime as the `suggestions` prop; each renders inside its
  // scene block (resolved by stable segment_id). Routing reuses the existing
  // applyAndSave / onCreateTask / confirm-first dialog seams.
  // ---------------------------------------------------------------------------
  const analyseVideoId = initialVideoId ?? sources[0]?.id ?? null
  const videoSuggestions = useMemo(
    () => suggestions.filter((s) => s.video_id === analyseVideoId),
    [suggestions, analyseVideoId]
  )
  const [analysisStatus, setAnalysisStatus] = useState('idle')
  const effectiveStatus =
    analysisStatus === 'analysing'
      ? 'analysing'
      : analysisStatus === 'done' || videoSuggestions.length > 0
        ? 'done'
        : 'idle'

  // The confirm-first AI dialog for a routed-to-AI suggestion:
  // { question, summary?, done, opFn, suggestionId }.
  const [aiConfirm, setAiConfirm] = useState(null)

  const handleAnalyse = useCallback(async () => {
    if (!analyseVideoId || analysisStatus === 'analysing' || !onAnalyse) return
    setAnalysisStatus('analysing')
    const rows = await onAnalyse(analyseVideoId)
    setAnalysisStatus('done')
    playEarcon(880, 200)
    // Move focus to the first suggested scene's collapsed header (probe parity)
    // so a BLV creator lands on a scene that has a suggestion.
    const first = (rows ?? []).map((r) => suggestionClip(r, clips)).find(Boolean)
    if (first) {
      const idx = clips.findIndex((c) => c.id === first.id)
      if (idx !== -1) {
        requestAnimationFrame(() => {
          document.querySelector(`[data-scene-index="${idx}"]`)?.focus?.()
        })
      }
    }
  }, [analyseVideoId, analysisStatus, onAnalyse, clips])

  // "Ask AI to fix it" — confirm-first. A fix_template (colour/zoom/mute) builds
  // the op directly; otherwise re-run the AI-edit endpoint with the suggestion
  // text to get a concrete, describable op. Both converge on ConfirmEditDialog.
  const routeSuggestionToAI = useCallback(
    async (s, clip) => {
      if (s.fix_template) {
        const described = describeFixTemplate(s.fix_template, clip.name)
        if (!described) return
        setAiConfirm({ question: described.question, done: described.done, opFn: fixTemplateToOpFn(s.fix_template, clip.id), suggestionId: s.id })
        return
      }
      try {
        const proposal = await serverPost(`/api/projects/${projectId}/ai-edit`, {
          request: s.text,
          focused_clip_id: clip.id,
          clips: clips.map((c) => ({
            id: c.id,
            name: c.name,
            duration_seconds: c.endTime - (c.trimEnd || 0) - (c.startTime + (c.trimStart || 0)),
          })),
        })
        if (proposal?.clarification) {
          announce(proposal.clarification)
          return
        }
        const described = describeProposal(proposal, clips)
        if (!described) {
          announce("The AI couldn't turn that into an edit — try Ask AI to Edit.", { assertive: true })
          return
        }
        setAiConfirm({ question: described.question, summary: proposal.summary, done: described.done, opFn: proposalToOpFn(proposal), suggestionId: s.id })
      } catch {
        announce('The AI request failed — try again', { assertive: true })
      }
    },
    [projectId, clips]
  )

  const handleAiConfirmYes = useCallback(() => {
    const c = aiConfirm
    setAiConfirm(null)
    if (!c) return
    applyAndSave(c.opFn, c.done)
    onResolveSuggestion(c.suggestionId, { routedTo: 'ai', outcomeStatus: 'applied' })
  }, [aiConfirm, applyAndSave, onResolveSuggestion])

  const handleAiConfirmNo = useCallback(() => {
    setAiConfirm(null)
    announce('Cancelled — no change was made.')
  }, [])

  const renderSceneActions = useCallback(
    (args) => {
      const { scene, index, currentLevel, onLevelChange, isPlaying: ip, currentTime: ct } = args
      const clip = clipsById.get(scene.id)
      if (!clip) return null
      const isActiveScene =
        ip && ct >= scene.start_time && ct < scene.end_time
      const sceneSuggestions = videoSuggestions.filter((s) => suggestionClip(s, clips)?.id === clip.id)
      return (
        <>
          {sceneSuggestions.map((s) => (
            <SuggestionItem
              key={s.id}
              suggestion={s}
              resolution={s.routed_to ? { routedTo: s.routed_to, outcomeStatus: s.outcome_status } : null}
              onRouteSelf={() => {
                onResolveSuggestion(s.id, { routedTo: 'self', outcomeStatus: 'pending' })
                announce(`Edit by myself opened for ${clip.name}.`)
                requestAnimationFrame(() => {
                  document.querySelector(`[data-edit-self-toggle="${clip.id}"]`)?.focus?.()
                })
              }}
              onRouteHelper={async () => {
                try {
                  const task = await onCreateTask({ text: s.text, segmentLabel: clip.name })
                  await onResolveSuggestion(s.id, { routedTo: 'helper', outcomeStatus: 'pending', taskId: task?.id })
                  announce('Sent to your helper.')
                } catch {
                  /* EditorPage announces the failure assertively */
                }
              }}
              onRouteAI={() => routeSuggestionToAI(s, clip)}
            />
          ))}
          <SceneActions
            clip={clip}
            index={index}
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
        </>
      )
    },
    [clipsById, clips, projectId, descriptions, playScene, playFromHere, pause, applyAndSave, onCreateTask, videoSuggestions, onResolveSuggestion, routeSuggestionToAI]
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
                  // The grade belongs to the ACTIVE scene, so key it on the
                  // active (visible) source only: non-active <video>s carry no
                  // filter/transform. Same visual result as gating display alone
                  // (only the active source shows), but the active-scene keying
                  // is now explicit and testable. Mirrors EditorVideoPlayer's
                  // helper preview.
                  filter: isActive ? videoFilter || undefined : undefined,
                  transform: isActive ? videoTransform || undefined : undefined,
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
          {/* Helper-added text overlays for the active scene — rendered
              isEditing=false so they stay pointer-events-none and out of the AT
              tree (the visual-only/inert creator contract). Same treatment the
              helper preview (EditorVideoPlayer) gives captions + colour. */}
          {visibleTextOverlays.map((o) => (
            <TextOverlay key={o.id} overlay={o} isEditing={false} onMove={() => {}} />
          ))}
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

      {/* Phase 3b — AI analysis trigger (creator-initiated). Sits between the
          pinned video and the scene list, exactly like the probe. */}
      <div className="flex-shrink-0">
        <AIAnalysisTriggerCard
          status={effectiveStatus}
          suggestionCount={videoSuggestions.length}
          onTrigger={handleAnalyse}
          role="creator"
        />
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

      {/* Confirm-first dialog for a routed-to-AI suggestion (fix_template or a
          re-run AI-edit proposal). Same deterministic-sentence dialog the
          Ask-AI-to-Edit panel uses. */}
      {aiConfirm && (
        <ConfirmEditDialog
          question={aiConfirm.question}
          summary={aiConfirm.summary}
          onConfirm={handleAiConfirmYes}
          onCancel={handleAiConfirmNo}
        />
      )}
    </div>
  )
}
