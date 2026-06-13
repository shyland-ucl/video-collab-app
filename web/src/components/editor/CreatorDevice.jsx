import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { announce } from '../../utils/announcer'
import ttsService from '../../services/ttsService'
import { serverPost } from '../../lib/serverApi'
import { rootSegmentId } from '../../lib/editor/stateStore'
import { useAccessibility } from '../../contexts/AccessibilityContext'
import usePlaybackEngine, { computeClipLayout } from '../../hooks/usePlaybackEngine'
import ExplorationMode from './ExplorationMode'
import TaskRequestModal from './TaskRequestModal'
import ConfirmAiEditDialog, { proposalToOpFn, describeProposal } from './ConfirmAiEditDialog'

/**
 * Creator device — the primary interface for a blind/low-vision creator.
 * Ported from probe src/components/decoupled/DecoupledCreatorDevice.jsx (Task 9).
 *
 * Prop contract (EditorPage): { role, projectId, user, state, version,
 * sources, descriptions, tasks, applyAndSave, channel, remote, onCreateTask,
 * onSetTaskStatus, syncDown }.
 *
 * Stripped per the adaptation contract:
 * - webrtcService EDIT_STATE_UPDATE / TASK_TO_HELPER sends → `applyAndSave`
 *   and `onCreateTask` props (EditorPage persists + Realtime distributes)
 * - window.__taskStatusUpdate / __aiEditReceive / __aiEditResponse WoZ hooks —
 *   deleted; task status arrives via the `tasks` prop re-rendering, AI edits
 *   go through the real `/api/projects/:id/ai-edit` endpoint
 * - EventLoggerContext / logEvent / eventTypes — deleted
 * - useSceneSoundPlayback (placeholder sound catalogue) and projectUpdate
 *   toast (EditorPage owns the toast + announce for remote changes)
 * - condition prop — only the probe2b/3 behavior remains
 *
 * Replaced:
 * - PLAY/PAUSE/SEEK WS sends → `channel.sendTransport({ action, time })`
 * - 2s STATE_UPDATE cadence → `channel.sendPlayhead({ isPlaying, time,
 *   segmentId })` on the same cadence
 * - probe VideoPlayer (visual-only, aria-hidden + inert) → the same pattern
 *   driven directly by usePlaybackEngine over the `sources` signed URLs
 */

const PLAYHEAD_INTERVAL_MS = 2000

const TASK_STATUS_TEXT = {
  pending: 'Sent to helper',
  done: 'Helper: Done',
  needs_discussion: 'Helper: Needs discussion',
  cant_do: "Helper: Can't do",
}

const AI_INVALID_PROPOSAL_TEXT =
  "The AI suggested an edit that doesn't match the current timeline — try asking again"
const AI_FAILED_TEXT = 'The AI request failed — try again'
const VQA_FAILED_TEXT = "The question couldn't be answered — try again"

export default function CreatorDevice({
  projectId,
  state,
  sources,
  descriptions,
  tasks,
  applyAndSave,
  channel,
  onCreateTask,
}) {
  const { audioEnabled, speechRate } = useAccessibility()
  const clips = state?.clips ?? []
  const captions = state?.captions ?? []

  // ---------------------------------------------------------------------------
  // Playback — one hidden <video> per source, sequenced by the EDL engine
  // (the probe's creator player was identical: aria-hidden + inert, visual/audio
  // only; the exploration UI is the accessible surface).
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

  const activeClip = clips[engine.currentClipIndex] ?? null

  // Refs so the broadcast effects/interval read fresh values without re-running.
  const stateRef = useRef(state)
  stateRef.current = state
  const playingRef = useRef(false)
  playingRef.current = isPlaying
  const timeRef = useRef(0)
  timeRef.current = engine.edlTime
  const activeClipRef = useRef(null)
  activeClipRef.current = activeClip

  // Stop when playback runs off the end of the timeline.
  useEffect(() => {
    if (isPlaying && engine.totalDuration > 0 && engine.edlTime >= engine.totalDuration) {
      setIsPlaying(false)
    }
  }, [isPlaying, engine.edlTime, engine.totalDuration])

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
      if (!clip) return
      const layout = computeClipLayout(stateRef.current?.clips ?? [])
      const entry = layout.find((e) => e.clip.id === clip.id)
      if (!entry) return
      engine.seekEdl(entry.edlOffset)
      channel.sendTransport({ action: 'seek', time: entry.edlOffset })
    },
    [engine, channel]
  )

  const handlePlay = useCallback(
    (clip) => {
      seekToClip(clip) // probe: play restarts from the current scene's start
      engine.play()
      setIsPlaying(true)
    },
    [seekToClip, engine]
  )

  const handlePause = useCallback(() => {
    engine.pause()
    setIsPlaying(false)
  }, [engine])

  // ---------------------------------------------------------------------------
  // Task routing (Ask Helper / Ask AI / VQA) + confirm-first AI edits
  // ---------------------------------------------------------------------------
  const [taskModal, setTaskModal] = useState(null) // { mode: 'ai'|'helper'|'vqa', clip }
  const [taskPending, setTaskPending] = useState(false)
  const [taskResponse, setTaskResponse] = useState(null)
  const [aiProposal, setAiProposal] = useState(null)

  const openTaskModal = useCallback((mode, clip) => {
    setTaskModal({ mode, clip })
    setTaskPending(false)
    setTaskResponse(null)
  }, [])

  const closeTaskModal = useCallback(() => {
    setTaskModal(null)
    setTaskPending(false)
    setTaskResponse(null)
  }, [])

  const speakResponse = useCallback(
    (text) => {
      if (audioEnabled) ttsService.speak(text, { rate: speechRate })
    },
    [audioEnabled, speechRate]
  )

  const handleTaskSend = useCallback(
    async (text) => {
      if (!taskModal) return
      const { mode, clip } = taskModal

      if (mode === 'helper') {
        try {
          await onCreateTask({ text, segmentLabel: clip?.name ?? null })
          announce('Sent to helper.')
        } catch {
          // EditorPage already announces the failure assertively.
        }
        return
      }

      if (mode === 'vqa') {
        setTaskPending(true)
        try {
          const { answer } = await serverPost(`/api/segments/${rootSegmentId(clip.id)}/vqa`, {
            question: text,
          })
          setTaskPending(false)
          setTaskResponse(answer)
          announce(answer)
          speakResponse(answer)
        } catch {
          setTaskPending(false)
          announce(VQA_FAILED_TEXT, { assertive: true })
        }
        return
      }

      // mode === 'ai'
      setTaskPending(true)
      try {
        const currentClips = stateRef.current?.clips ?? []
        const proposal = await serverPost(`/api/projects/${projectId}/ai-edit`, {
          request: text,
          clips: currentClips.map((c) => ({
            id: c.id,
            name: c.name,
            duration_seconds: (c.endTime - c.trimEnd) - (c.startTime + c.trimStart),
          })),
        })
        setTaskPending(false)
        if (proposal?.clarification) {
          // Clarification: speak it and keep the modal open for a follow-up.
          setTaskResponse(proposal.clarification)
          announce(proposal.clarification)
          speakResponse(proposal.clarification)
          return
        }
        if (!describeProposal(proposal, stateRef.current?.clips ?? [])) {
          setTaskResponse(AI_INVALID_PROPOSAL_TEXT)
          announce(AI_INVALID_PROPOSAL_TEXT, { assertive: true })
          return
        }
        closeTaskModal()
        setAiProposal(proposal)
      } catch {
        setTaskPending(false)
        announce(AI_FAILED_TEXT, { assertive: true })
      }
    },
    [taskModal, onCreateTask, projectId, speakResponse, closeTaskModal]
  )

  const handleAiConfirm = useCallback(() => {
    const proposal = aiProposal
    setAiProposal(null)
    const described = describeProposal(proposal, stateRef.current?.clips ?? [])
    if (!described) return
    applyAndSave(proposalToOpFn(proposal), described.done)
  }, [aiProposal, applyAndSave])

  const handleAiCancel = useCallback(() => {
    setAiProposal(null)
    announce('Cancelled — no change was made.')
  }, [])

  const handleAskAI = useCallback((clip) => openTaskModal('ai', clip), [openTaskModal])
  const handleAskHelper = useCallback((clip) => openTaskModal('helper', clip), [openTaskModal])
  const handleAskQuestion = useCallback((clip) => openTaskModal('vqa', clip), [openTaskModal])

  return (
    <div role="region" aria-label="Creator device">
      {/* Video player — visual only (probe pattern: out of the AT tree;
          the exploration UI below is the accessible surface). */}
      {/* React 19: `inert` is a real boolean prop (the probe's React-18
          `inert=""` idiom would be treated as FALSE here). */}
      <div aria-hidden="true" inert className="pointer-events-none mb-4">
        <div className="relative bg-black mx-auto overflow-hidden rounded-xl" style={{ aspectRatio: '16 / 9', width: '100%', maxHeight: '40vh' }}>
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
                style={{ display: isActive ? 'block' : 'none' }}
                preload="metadata"
                playsInline
                aria-hidden="true"
                tabIndex={-1}
              />
            )
          })}
          {engine.activeCaption && (
            <div className="absolute bottom-0 left-0 right-0 flex justify-center pointer-events-none" style={{ padding: '0 8px 16px' }}>
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

      {/* Exploration Mode — the accessible scene-by-scene surface */}
      <ExplorationMode
        state={state}
        descriptions={descriptions}
        isPlaying={isPlaying}
        currentTime={engine.edlTime}
        activeClipIndex={engine.currentClipIndex}
        applyAndSave={applyAndSave}
        onPlay={handlePlay}
        onPause={handlePause}
        onSeekToClip={seekToClip}
        onAskAI={handleAskAI}
        onAskHelper={handleAskHelper}
        onAskQuestion={handleAskQuestion}
        suspendKeys={Boolean(taskModal || aiProposal)}
      />

      {/* Task Request Modal (Ask AI / Ask Helper / Ask about this scene) */}
      {taskModal && (
        <TaskRequestModal
          mode={taskModal.mode}
          clip={taskModal.clip}
          onSend={handleTaskSend}
          onClose={closeTaskModal}
          pending={taskPending}
          response={taskResponse}
        />
      )}

      {/* Confirm-first AI edit dialog */}
      {aiProposal && (
        <ConfirmAiEditDialog
          proposal={aiProposal}
          clips={clips}
          onConfirm={handleAiConfirm}
          onCancel={handleAiCancel}
        />
      )}

      {/* Recent Tasks — rendered from the tasks prop; status-change
          announcements happen in EditorPage, not here. */}
      {tasks.length > 0 && (
        <div role="region" aria-label="Recent tasks" className="border-2 border-[#64748b] rounded-xl overflow-hidden bg-white mt-3">
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
