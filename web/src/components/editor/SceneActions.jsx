import { useState, useCallback } from 'react'
import { announce } from '../../utils/announcer'
import ttsService from '../../services/ttsService'
import { useAccessibility } from '../../contexts/AccessibilityContext'
import { serverPost } from '../../lib/serverApi'
import { applyOperation } from '../../lib/editor/sceneEditOps'
import { rootSegmentId } from '../../lib/editor/stateStore'
import DetailLevelSelector from './sceneblocks/DetailLevelSelector'
import VoiceComposer from './VoiceComposer'
import ConfirmAiEditDialog, { proposalToOpFn, describeProposal } from './ConfirmAiEditDialog'

/**
 * Per-scene action set rendered inside an expanded SceneBlock (Phase 2a Task 2).
 *
 * This is what SceneBlockList's `renderSceneActions` render-prop renders. It is
 * a faithful UX port of the probe's
 * video-collab-probe/src/components/probe2/Probe2bSceneActions.jsx — same action
 * ORDER and inline toggle-panel pattern (DetailLevelSelector, the two play
 * buttons, Ask AI about scene = VQA, Edit by Myself, Ask AI to Edit, Ask Helper
 * to Edit) — but wired to THIS app's handlers instead of the study's logEvent /
 * webrtc plumbing.
 *
 * Stripped per the adaptation contract: useEventLogger / logEvent / EventTypes /
 * Actors; the probe's keep/discard `onToggleKeep` is folded into a real
 * applyOperation('delete') (this app removes clips, it doesn't carry a kept-flag
 * the engine reads). The probe's InlineVQAComposer / TaskRouterPanel inline
 * forms are inlined here as plain textbox panels so we don't pull more probe UI
 * than needed.
 *
 * WIRING — how the rendered (snake_case) scene becomes the app clip (for Task 3):
 *   SceneBlockList calls renderSceneActions({ scene, index, currentLevel,
 *   onLevelChange, isPlaying, currentTime, onSeek, onPlay, onPause, ... }) where
 *   `scene` is the snake_case shape (scene.id IS the clip id). Task 3
 *   (CreatorDevice) keeps a clipsById = new Map(state.clips.map(c => [c.id, c]))
 *   and, inside its renderSceneActions closure, resolves `clip =
 *   clipsById.get(scene.id)` and computes `isActiveScene = isPlaying &&
 *   currentTime >= scene.start_time && currentTime < scene.end_time`, then
 *   renders <SceneActions clip={clip} level={currentLevel}
 *   onLevelChange={onLevelChange} isPlaying={isPlaying}
 *   isActiveScene={isActiveScene} onPlayScene={...} onPlayFromHere={...}
 *   onPause={onPause} applyAndSave={applyAndSave} onCreateTask={onCreateTask}
 *   projectId={projectId} descriptions={descriptions} />. SceneActions therefore
 *   never has to touch the snake_case scene — it consumes the real app clip
 *   (with `.id` for opFns and rootSegmentId for VQA) plus the precomputed
 *   isActiveScene boolean.
 *
 * Props:
 *   clip            the app clip object (camelCase: id, name, startTime, ...)
 *   projectId       project id (for the AI-edit endpoint)
 *   level           current detail level (1..3) — owned by SceneBlockList
 *   onLevelChange   level setter from SceneBlockList
 *   descriptions    descriptions[rootSegmentId(clip.id)]?.[level] (kept for parity)
 *   isPlaying       whole-timeline playing flag
 *   isActiveScene   true when THIS scene is the one bounded-playing right now
 *   onPlayScene     (clip) => void  — bounded "Play this scene" (pauses at end)
 *   onPlayFromHere  (clip) => void  — unbounded "Play from here"
 *   onPause         () => void
 *   applyAndSave    (opFn, announceText, opts?) => Promise — persists + distributes
 *   onCreateTask    ({ text, segmentLabel }) => Promise — Ask Helper route
 */

const ACCENT = '#9B59B6' // Probe 3 creator primary (purple)
const AI_EDIT_COLOR = '#F0AD4E' // amber — "Ask AI to Edit"
const SELF_EDIT_COLOR = '#2B579A' // blue — "Edit by Myself"

const AI_INVALID_PROPOSAL_TEXT =
  "The AI suggested an edit that doesn't match the current timeline — try asking again"
const AI_FAILED_TEXT = 'The AI request failed — try again'
const VQA_FAILED_TEXT = "The question couldn't be answered — try again"

export default function SceneActions({
  clip,
  allClips,
  projectId,
  level = 1,
  onLevelChange,
  descriptions,
  isPlaying = false,
  isActiveScene = false,
  onPlayScene,
  onPlayFromHere,
  onPause,
  applyAndSave,
  onCreateTask,
}) {
  // The AI-edit endpoint wants the WHOLE timeline so it can target any clip
  // (not just the focused one); CreatorDevice (Task 3) passes state.clips.
  // Default to [clip] so the unit test / standalone use still self-contains.
  const aiClips = allClips && allClips.length > 0 ? allClips : (clip ? [clip] : [])
  const { audioEnabled, speechRate } = useAccessibility()

  // Inline toggle panels (probe pattern — NOT full-screen modals). Only the
  // confirm-first AI dialog is genuinely modal (it owns useRootInert itself).
  const [showVqa, setShowVqa] = useState(false)
  const [showEditPanel, setShowEditPanel] = useState(false)
  const [showAiEdit, setShowAiEdit] = useState(false)
  const [showHelper, setShowHelper] = useState(false)

  // Per-panel composer text. VQA / AI-edit / helper text now lives inside the
  // VoiceComposer (which feeds it here via voice or typing); only the caption
  // sub-input keeps its own controlled state.
  const [captionText, setCaptionText] = useState('')
  const [showCaptionInput, setShowCaptionInput] = useState(false)

  // Async / response state.
  const [vqaPending, setVqaPending] = useState(false)
  const [vqaAnswer, setVqaAnswer] = useState(null)
  const [aiEditPending, setAiEditPending] = useState(false)
  const [aiEditNote, setAiEditNote] = useState(null) // clarification / invalid note
  const [aiProposal, setAiProposal] = useState(null) // drives ConfirmAiEditDialog

  // Local undo/redo snapshots (probe behavior) — applied non-rebasable so a
  // conflict resyncs instead of clobbering a concurrent helper edit. Each
  // stack entry is { opFn, preImage } where preImage is the timeline state the
  // edit's opFn saw (captured when the real applyAndSave invoked it). Undo
  // replaces with preImage; redo re-applies opFn.
  const [undoStack, setUndoStack] = useState([])
  const [redoStack, setRedoStack] = useState([])

  const speakResponse = useCallback(
    (text) => {
      if (audioEnabled) ttsService.speak(text, { rate: speechRate })
    },
    [audioEnabled, speechRate]
  )

  // ---------------------------------------------------------------------------
  // Play controls — the two distinct play buttons (probe Day-1 fix #2).
  // ---------------------------------------------------------------------------
  const handlePlayThisScene = useCallback(() => {
    if (isActiveScene) {
      onPause?.()
      return
    }
    onPlayScene?.(clip)
  }, [isActiveScene, onPause, onPlayScene, clip])

  const handlePlayFromHereOrPause = useCallback(() => {
    if (isPlaying) {
      onPause?.()
      return
    }
    onPlayFromHere?.(clip)
  }, [isPlaying, onPause, onPlayFromHere, clip])

  // ---------------------------------------------------------------------------
  // VQA (Ask AI about this scene) — serverPost to the segment vqa endpoint.
  // ---------------------------------------------------------------------------
  const handleVqaSubmit = useCallback(async (text) => {
    const question = (text || '').trim()
    if (!question || !clip) return
    setVqaPending(true)
    setVqaAnswer(null)
    try {
      const { answer } = await serverPost(`/api/segments/${rootSegmentId(clip.id)}/vqa`, { question })
      setVqaPending(false)
      setVqaAnswer(answer)
      announce(answer)
      speakResponse(answer)
    } catch {
      setVqaPending(false)
      announce(VQA_FAILED_TEXT, { assertive: true })
    }
  }, [clip, speakResponse])

  // ---------------------------------------------------------------------------
  // Edit by Myself — every edit routes through applyAndSave(opFn, text).
  // ---------------------------------------------------------------------------
  const runEdit = useCallback(
    (op, options, text, { rebasable = true } = {}) => {
      if (!clip) return
      const id = clip.id
      // Each edit gets its own undo entry. applyAndSave's opFn closes over
      // EditorPage's live state, so we wrap it to stash the pre-image the
      // moment the real applyAndSave invokes it (first call wins).
      const entry = { preImage: null }
      const opFn = (s) => {
        if (entry.preImage === null) entry.preImage = s
        return applyOperation(s, id, op, options)
      }
      entry.opFn = opFn
      setUndoStack((prev) => [...prev, entry])
      setRedoStack([])
      applyAndSave(opFn, text, { rebasable })
    },
    [clip, applyAndSave]
  )

  const handleDelete = useCallback(() => {
    if (!clip) return
    runEdit('delete', {}, `Deleted clip: ${clip.name}`)
    setShowEditPanel(false)
    announce(`Deleted ${clip.name}.`)
  }, [clip, runEdit])

  const handleSplit = useCallback(() => {
    if (!clip) return
    runEdit('split', {}, `Split ${clip.name}`)
  }, [clip, runEdit])

  const handleMoveEarlier = useCallback(() => {
    if (!clip) return
    runEdit('move_earlier', {}, `Moved ${clip.name} earlier`)
  }, [clip, runEdit])

  const handleMoveLater = useCallback(() => {
    if (!clip) return
    runEdit('move_later', {}, `Moved ${clip.name} later`)
  }, [clip, runEdit])

  const handleAddCaption = useCallback(() => {
    const text = captionText.trim()
    if (!text || !clip) return
    runEdit('add_caption', { captionText: text }, `Added caption: "${text}"`)
    setCaptionText('')
    setShowCaptionInput(false)
  }, [captionText, clip, runEdit])

  // Undo/redo: state-REPLACING opFns, non-rebasable (probe contract). Undo
  // replaces the timeline with the edit's captured pre-image; redo re-applies
  // its opFn. Both are non-rebasable so a conflicting concurrent helper edit
  // surfaces and resyncs instead of being clobbered by a stale snapshot.
  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) return
    const entry = undoStack[undoStack.length - 1]
    setUndoStack((u) => u.slice(0, -1))
    setRedoStack((r) => [...r, entry])
    applyAndSave((s) => entry.preImage ?? s, 'Undo', { rebasable: false })
  }, [undoStack, applyAndSave])

  const handleRedo = useCallback(() => {
    if (redoStack.length === 0) return
    const entry = redoStack[redoStack.length - 1]
    setRedoStack((r) => r.slice(0, -1))
    setUndoStack((u) => [...u, entry])
    applyAndSave(entry.opFn, 'Redo', { rebasable: false })
  }, [redoStack, applyAndSave])

  // ---------------------------------------------------------------------------
  // Ask AI to Edit — confirm-first. serverPost → describeProposal → dialog.
  // ---------------------------------------------------------------------------
  const handleAiEditSubmit = useCallback(async (text) => {
    const request = (text || '').trim()
    if (!request || !clip) return
    setAiEditPending(true)
    setAiEditNote(null)
    try {
      // The endpoint wants the whole timeline (so the AI can target any clip);
      // applyAndSave will receive the live state when the user confirms.
      // focused_clip_id tells the model which scene the request came from; the
      // server accepts a clips array and ignores unknown body fields.
      const proposal = await serverPost(`/api/projects/${projectId}/ai-edit`, {
        request,
        focused_clip_id: clip.id,
        clips: aiClips.map((c) => ({
          id: c.id,
          name: c.name,
          duration_seconds:
            c.endTime - (c.trimEnd || 0) - (c.startTime + (c.trimStart || 0)),
        })),
      })
      setAiEditPending(false)
      if (proposal?.clarification) {
        // Clarification: announce + speak, keep the panel open for a follow-up.
        setAiEditNote(proposal.clarification)
        announce(proposal.clarification)
        speakResponse(proposal.clarification)
        return
      }
      // The deterministic sentence is composed against the FULL timeline so a
      // proposal targeting a non-focused clip still validates + names correctly.
      if (!describeProposal(proposal, aiClips)) {
        setAiEditNote(AI_INVALID_PROPOSAL_TEXT)
        announce(AI_INVALID_PROPOSAL_TEXT, { assertive: true })
        return
      }
      setAiProposal(proposal)
    } catch {
      setAiEditPending(false)
      announce(AI_FAILED_TEXT, { assertive: true })
    }
  }, [clip, aiClips, projectId, speakResponse])

  const handleAiConfirm = useCallback(() => {
    const proposal = aiProposal
    setAiProposal(null)
    const described = describeProposal(proposal, aiClips)
    if (!described) return
    applyAndSave(proposalToOpFn(proposal), described.done)
    setShowAiEdit(false)
  }, [aiProposal, aiClips, applyAndSave])

  const handleAiCancel = useCallback(() => {
    setAiProposal(null)
    announce('Cancelled — no change was made.')
  }, [])

  // ---------------------------------------------------------------------------
  // Ask Helper to Edit — onCreateTask({ text, segmentLabel: clip.name }).
  // ---------------------------------------------------------------------------
  const handleHelperSubmit = useCallback(async (rawText) => {
    const text = (rawText || '').trim()
    if (!text || !clip) return
    try {
      await onCreateTask({ text, segmentLabel: clip.name })
      announce('Sent to helper.')
      setShowHelper(false)
    } catch {
      // EditorPage already announces the failure assertively.
    }
  }, [clip, onCreateTask])

  if (!clip) return null

  const canUndo = undoStack.length > 0
  const canRedo = redoStack.length > 0

  return (
    <>
      {/* Detail level selector (probe renders it first inside the actions). */}
      <DetailLevelSelector currentLevel={level} onLevelChange={onLevelChange} />

      {/* Two distinct play actions.
          "Play this scene" is bounded (pauses at the scene end); when this
          scene is the one playing it flips to Pause.
          "Play from here" is unbounded; while the timeline plays it flips to
          Pause so focus can stay put across scene boundaries. */}
      <button
        type="button"
        onClick={handlePlayThisScene}
        data-scene-play-button="true"
        className="w-full py-3 text-sm font-medium rounded bg-gray-100 hover:bg-gray-200 text-gray-800 transition-colors focus:outline-2 focus:outline-offset-2 focus:outline-blue-500"
        style={{ minHeight: '48px' }}
        aria-label={isActiveScene ? 'Pause this scene' : `Play scene, stops at the end of this scene`}
      >
        {isActiveScene ? 'Pause' : 'Play this scene'}
      </button>
      <button
        type="button"
        onClick={handlePlayFromHereOrPause}
        className="w-full py-2 text-sm font-medium rounded bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 transition-colors focus:outline-2 focus:outline-offset-2 focus:outline-blue-500"
        style={{ minHeight: '44px' }}
        aria-label={isPlaying ? 'Double tap to pause' : 'Play the whole video from here'}
      >
        {isPlaying ? 'Pause' : 'Play from here'}
      </button>

      {/* Ask AI about Scene (VQA) — inline toggle panel. */}
      <div>
        <button
          type="button"
          onClick={() => setShowVqa((v) => !v)}
          className="w-full py-3 text-sm font-medium rounded bg-gray-100 hover:bg-gray-200 text-gray-800 transition-colors focus:outline-2 focus:outline-offset-2 focus:outline-blue-500"
          style={{ minHeight: '48px' }}
        >
          {showVqa ? 'Close Ask AI' : 'Ask AI about Scene'}
        </button>
        {showVqa && (
          <div
            role="group"
            aria-label="Ask AI about Scene"
            className="mt-2 p-3 bg-gray-50 rounded-lg border border-gray-200 flex flex-col gap-2"
          >
            <VoiceComposer
              onSubmit={handleVqaSubmit}
              disabled={vqaPending}
              placeholder="Ask a question about this scene..."
              announcement="Speak now. Ask your question."
              submitLabel="Ask"
              inputAriaLabel="Your question"
            />
            {vqaPending && <p className="text-sm text-gray-700 italic" aria-live="polite">Getting the answer...</p>}
            {vqaAnswer && (
              // Visual only — the answer is spoken once via announce(answer)
              // (handleVqaSubmit). A second role="status"/aria-live region here
              // made VoiceOver read the answer twice and append "status".
              <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                <p className="text-xs font-semibold text-green-700 uppercase tracking-wide mb-1">Answer</p>
                <p className="text-sm text-gray-800">{vqaAnswer}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Edit by Myself — blue (creator/self) inline toggle panel. */}
      <div>
        <button
          type="button"
          data-edit-self-toggle={clip.id}
          onClick={() => setShowEditPanel((v) => !v)}
          className="w-full py-3 text-sm font-medium rounded text-white transition-colors focus:outline-2 focus:outline-offset-2 focus:outline-blue-500"
          style={{ backgroundColor: SELF_EDIT_COLOR, minHeight: '48px' }}
        >
          {showEditPanel ? 'Hide Edit Options' : 'Edit by Myself'}
        </button>
        {showEditPanel && (
          <div
            role="group"
            aria-label="Edit by Myself"
            className="mt-2 p-3 bg-gray-50 rounded-lg border border-gray-200 flex flex-col gap-2"
          >
            <button
              type="button"
              onClick={handleSplit}
              aria-label="Split this clip at the current playback position"
              className="w-full py-3 rounded-lg bg-[#2B579A] text-sm font-bold text-white hover:bg-[#1e3f6f] focus:outline-none focus:ring-2 focus:ring-[#2B579A] focus:ring-offset-1"
              style={{ minHeight: '48px' }}
            >
              Split
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleMoveEarlier}
                aria-label="Move this clip earlier in the timeline"
                className="flex-1 py-3 rounded-lg bg-gray-100 text-sm font-semibold text-gray-700 hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-[#2B579A] focus:ring-offset-1"
                style={{ minHeight: '48px' }}
              >
                Move Earlier
              </button>
              <button
                type="button"
                onClick={handleMoveLater}
                aria-label="Move this clip later in the timeline"
                className="flex-1 py-3 rounded-lg bg-gray-100 text-sm font-semibold text-gray-700 hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-[#2B579A] focus:ring-offset-1"
                style={{ minHeight: '48px' }}
              >
                Move Later
              </button>
            </div>
            <button
              type="button"
              onClick={handleDelete}
              aria-label="Delete this clip from the timeline"
              className="w-full py-3 rounded-lg bg-red-500 text-sm font-bold text-white hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-400 focus:ring-offset-2"
              style={{ minHeight: '48px' }}
            >
              Delete
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleUndo}
                disabled={!canUndo}
                aria-label="Undo last edit"
                className="flex-1 py-3 rounded-lg bg-gray-100 text-sm font-semibold text-gray-700 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-[#2B579A] focus:ring-offset-1"
                style={{ minHeight: '48px' }}
              >
                Undo
              </button>
              <button
                type="button"
                onClick={handleRedo}
                disabled={!canRedo}
                aria-label="Redo last undone edit"
                className="flex-1 py-3 rounded-lg bg-gray-100 text-sm font-semibold text-gray-700 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-[#2B579A] focus:ring-offset-1"
                style={{ minHeight: '48px' }}
              >
                Redo
              </button>
            </div>
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
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddCaption() }}
                  placeholder="Enter caption text..."
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-2 focus:outline-[#2B579A]"
                  style={{ minHeight: '48px' }}
                  aria-label="Caption text"
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
              </div>
            )}
          </div>
        )}
      </div>

      {/* Ask AI to Edit — amber (AI). Confirm-first via ConfirmAiEditDialog. */}
      <div>
        <button
          type="button"
          onClick={() => setShowAiEdit((v) => !v)}
          className="w-full py-3 text-sm font-medium rounded text-white transition-colors focus:outline-2 focus:outline-offset-2 focus:outline-blue-500"
          style={{ backgroundColor: AI_EDIT_COLOR, minHeight: '48px' }}
        >
          {showAiEdit ? 'Close AI Edit' : 'Ask AI to Edit'}
        </button>
        {showAiEdit && (
          <div
            role="group"
            aria-label="Ask AI to Edit"
            className="mt-2 p-3 bg-gray-50 rounded-lg border border-gray-200 flex flex-col gap-2"
          >
            <VoiceComposer
              onSubmit={handleAiEditSubmit}
              disabled={aiEditPending}
              placeholder="Describe what you want done..."
              announcement="Speak now. Describe the edit."
              submitLabel="Ask AI"
              inputAriaLabel="Task description"
            />
            {aiEditPending && <p className="text-sm text-gray-700 italic" aria-live="polite">AI is working...</p>}
            {aiEditNote && (
              // Visual only — the note is spoken once via announce() in
              // handleAiEditSubmit; a second live region read it twice + "status".
              <div className="p-3 border-2 rounded-lg bg-yellow-50 border-yellow-300">
                <p className="text-sm text-yellow-800">{aiEditNote}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Ask Helper to Edit — purple (accent). */}
      <div>
        <button
          type="button"
          onClick={() => setShowHelper((v) => !v)}
          className="w-full py-3 text-sm font-medium rounded text-white transition-colors focus:outline-2 focus:outline-offset-2 focus:outline-blue-500"
          style={{ backgroundColor: ACCENT, minHeight: '48px' }}
        >
          {showHelper ? 'Close Helper Edit' : 'Ask Helper to Edit'}
        </button>
        {showHelper && (
          <div
            role="group"
            aria-label="Ask Helper"
            className="mt-2 p-3 bg-gray-50 rounded-lg border border-gray-200 flex flex-col gap-2"
          >
            <VoiceComposer
              onSubmit={handleHelperSubmit}
              placeholder="Describe what you want done..."
              announcement="Speak now. Describe the task for your helper."
              submitLabel="Send to helper"
              inputAriaLabel="Task description"
            />
          </div>
        )}
      </div>

      {/* Confirm-first AI edit dialog — the only genuinely modal surface here
          (it owns useRootInert internally). */}
      {aiProposal && (
        <ConfirmAiEditDialog
          proposal={aiProposal}
          clips={aiClips}
          onConfirm={handleAiConfirm}
          onCancel={handleAiCancel}
        />
      )}
    </>
  )
}
