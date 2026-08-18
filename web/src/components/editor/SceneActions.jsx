import { useState, useCallback } from 'react'
import { announce } from '../../utils/announcer'
import ttsService from '../../services/ttsService'
import { useAccessibility } from '../../contexts/AccessibilityContext'
import { serverPost } from '../../lib/serverApi'
import { applyOperation, getClipMuted } from '../../lib/editor/sceneEditOps'
import { rootSegmentId } from '../../lib/editor/stateStore'
import DetailLevelSelector from './sceneblocks/DetailLevelSelector'
import VoiceComposer from './VoiceComposer'
import ConfirmAiEditDialog, { proposalToOpFn, describeProposal } from './ConfirmAiEditDialog'
import ConfirmEditDialog from './ConfirmEditDialog'

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
 *   index           0-based position of this scene in the timeline (for
 *                   scene-numbered, synchronous self-edit confirmations — the
 *                   probe announces "Scene N …" the instant the button is hit)
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

// Action-family hues are design tokens now (see index.css themes):
// self-edit -> brand, Ask-AI -> helper (amber), Ask-Helper -> creator (purple).

const AI_INVALID_PROPOSAL_TEXT =
  "The AI suggested an edit that doesn't match the current timeline — try asking again"
const AI_FAILED_TEXT = 'The AI request failed — try again'
const VQA_FAILED_TEXT = "The question couldn't be answered — try again"

export default function SceneActions({
  clip,
  index = 0,
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

  // Live count of how many clips this scene currently spans (1 until a Trim
  // splits it). rootSegmentId collapses a clip and all its split halves to the
  // original scene, so counting timeline clips whose root matches this scene's
  // root is exact (probe EditByMyselfPanel clipCountForScene). Drives the
  // "This scene currently has N clips" line under Trim.
  const clipCountForScene = clip
    ? (aiClips.filter((c) => rootSegmentId(c.id) === rootSegmentId(clip.id)).length || 1)
    : 1

  // Inline toggle panels (probe pattern — NOT full-screen modals). Only the
  // confirm-first AI dialog is genuinely modal (it owns useRootInert itself).
  const [showVqa, setShowVqa] = useState(false)
  const [showEditPanel, setShowEditPanel] = useState(false)
  const [showAiEdit, setShowAiEdit] = useState(false)
  const [showHelper, setShowHelper] = useState(false)
  const [deletePending, setDeletePending] = useState(false)

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
  // Prior { request, clarification } rounds of the CURRENT ask-AI exchange, sent
  // back so the server can combine the creator's answer with what they first
  // asked (a stateless answer looped forever — the reported bug). Cleared when
  // the panel toggles or an edit is proposed/applied.
  const [aiClarifyHistory, setAiClarifyHistory] = useState([])

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
      // Speak the answer through a SINGLE channel: announce() reaches the SR
      // (and is what the VQA-failure path uses). The probe speaks the answer
      // once via gated TTS with no announce; we keep announce() for ALL users
      // and DROP the second speakResponse(answer) so an audio-on BLV user
      // doesn't hear the answer read twice. The visible Answer box stays.
      announce(answer)
    } catch {
      setVqaPending(false)
      announce(VQA_FAILED_TEXT, { assertive: true })
    }
  }, [clip])

  // ---------------------------------------------------------------------------
  // Edit by Myself — every edit routes through applyAndSave(opFn, text).
  // ---------------------------------------------------------------------------
  // Push ANY opFn onto the undo stack and persist it. Each edit gets its own
  // undo entry; applyAndSave's opFn closes over EditorPage's live state, so we
  // wrap it to stash the pre-image the moment the real applyAndSave invokes it
  // (first call wins). Shared by self-edits (runEdit) AND applied AI proposals
  // (handleAiConfirm) so both are equally undoable.
  const pushUndoable = useCallback(
    (rawOpFn, text, { rebasable = true } = {}) => {
      const entry = { preImage: null }
      const opFn = (s) => {
        if (entry.preImage === null) entry.preImage = s
        return rawOpFn(s)
      }
      entry.opFn = opFn
      setUndoStack((prev) => [...prev, entry])
      setRedoStack([])
      applyAndSave(opFn, text, { rebasable })
    },
    [applyAndSave]
  )

  const runEdit = useCallback(
    (op, options, text, { rebasable = true } = {}) => {
      if (!clip) return
      const id = clip.id
      pushUndoable((s) => applyOperation(s, id, op, options), text, { rebasable })
    },
    [clip, pushUndoable]
  )

  // Self-edits announce SYNCHRONOUSLY and scene-numbered the instant the button
  // is hit (probe EditByMyselfPanel wording) — this is the creator's immediate
  // confirmation, independent of the network save. applyAndSave's announceText
  // still drives the cross-device summary the HELPER hears, so:
  //  - the IMMEDIATE local announce is the creator's confirmation, and it
  //    survives a save conflict (EditorPage skips the post-save announce then);
  //  - for delete we pass NO announceText so the creator hears the deletion
  //    exactly ONCE (EditorPage's remote summary still announces to the helper).
  const handleConfirmDelete = useCallback(() => {
    if (!clip) return
    setDeletePending(false)
    runEdit('delete', {}, '')
    setShowEditPanel(false)
    announce(`Scene ${index + 1} removed from the edit.`)
  }, [clip, index, runEdit])

  const handleSplit = useCallback(() => {
    if (!clip) return
    runEdit('split', {}, `Split ${clip.name}`)
    announce(`Scene ${index + 1} trimmed at this point.`)
  }, [clip, index, runEdit])

  const handleMoveEarlier = useCallback(() => {
    if (!clip) return
    runEdit('move_earlier', {}, `Moved ${clip.name} earlier`)
    announce(`Scene ${index + 1} moved earlier.`)
  }, [clip, index, runEdit])

  const handleMoveLater = useCallback(() => {
    if (!clip) return
    runEdit('move_later', {}, `Moved ${clip.name} later`)
    announce(`Scene ${index + 1} moved later.`)
  }, [clip, index, runEdit])

  const handleAddCaption = useCallback(() => {
    const text = captionText.trim()
    if (!text || !clip) return
    runEdit('add_caption', { captionText: text }, `Added caption: "${text}"`)
    announce(`Caption added to scene ${index + 1}.`)
    setCaptionText('')
    setShowCaptionInput(false)
  }, [captionText, clip, index, runEdit])

  // Mute / unmute the ORIGINAL scene audio (probe EditByMyselfPanel mute
  // control). applyOperation('toggle_mute') flips clip.muted; the engine reads
  // it on the active clip so the change is audible on both devices. The
  // post-save announceText drives the helper's cross-device summary; the
  // immediate scene-numbered announce is the creator's own confirmation.
  const isMuted = clip ? getClipMuted({ clips: aiClips }, clip.id) : false
  const handleToggleMute = useCallback(() => {
    if (!clip) return
    const next = !getClipMuted({ clips: aiClips }, clip.id)
    runEdit('toggle_mute', {}, next ? `Muted ${clip.name}` : `Unmuted ${clip.name}`)
    announce(
      next
        ? `Original audio muted on scene ${index + 1}.`
        : `Original audio unmuted on scene ${index + 1}.`
    )
  }, [clip, aiClips, index, runEdit])

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
        // Prior rounds of THIS exchange so the server combines the creator's
        // answer with what they first asked (instead of looping statelessly).
        history: aiClarifyHistory,
        clips: aiClips.map((c) => ({
          id: c.id,
          name: c.name,
          duration_seconds:
            c.endTime - (c.trimEnd || 0) - (c.startTime + (c.trimStart || 0)),
        })),
      })
      setAiEditPending(false)
      if (proposal?.clarification) {
        // Clarification: announce + speak, keep the panel open, and remember
        // this round so the creator's next answer is understood in context.
        setAiClarifyHistory((h) => [...h, { request, clarification: proposal.clarification }])
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
      // A real proposal ends the clarification exchange.
      setAiClarifyHistory([])
      setAiProposal(proposal)
    } catch {
      setAiEditPending(false)
      announce(AI_FAILED_TEXT, { assertive: true })
    }
  }, [clip, aiClips, projectId, speakResponse, aiClarifyHistory])

  const handleAiConfirm = useCallback(() => {
    const proposal = aiProposal
    setAiProposal(null)
    const described = describeProposal(proposal, aiClips)
    if (!described) return
    // Route through the shared undo path so an AI-applied edit is as undoable
    // as a self-edit (a BLV creator who mishears the confirmation can revert it).
    pushUndoable(proposalToOpFn(proposal), described.done)
    setShowAiEdit(false)
    setAiClarifyHistory([])
    setAiEditNote(null)
  }, [aiProposal, aiClips, pushUndoable])

  const handleAiCancel = useCallback(() => {
    setAiProposal(null)
    announce('Cancelled — no change was made.')
  }, [])

  // Toggling the Ask-AI panel starts a fresh exchange: drop any carried
  // clarification history and note so a new request isn't coloured by an
  // abandoned one.
  const handleToggleAiEdit = useCallback(() => {
    setShowAiEdit((v) => !v)
    setAiClarifyHistory([])
    setAiEditNote(null)
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
        className="w-full py-3 text-sm font-medium rounded bg-sunken hover:bg-line text-ink transition-colors"
        style={{ minHeight: '48px' }}
        aria-label={isActiveScene ? 'Pause this scene' : `Play scene ${index + 1}, stops at the end of this scene`}
      >
        {isActiveScene ? 'Pause' : 'Play this scene'}
      </button>
      <button
        type="button"
        onClick={handlePlayFromHereOrPause}
        className="w-full py-2 text-sm font-medium rounded bg-surface border border-line-strong hover:bg-sunken text-ink-soft transition-colors"
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
          className="w-full py-3 text-sm font-medium rounded bg-sunken hover:bg-line text-ink transition-colors"
          style={{ minHeight: '48px' }}
        >
          {showVqa ? 'Close Ask AI' : 'Ask AI about Scene'}
        </button>
        {showVqa && (
          <div
            role="group"
            aria-label="Ask AI about Scene"
            className="mt-2 p-3 bg-sunken rounded-lg border border-line flex flex-col gap-2"
          >
            <VoiceComposer
              onSubmit={handleVqaSubmit}
              disabled={vqaPending}
              placeholder="Ask a question about this scene..."
              announcement="Speak now. Ask your question."
              submitLabel="Ask"
              inputAriaLabel="Your question"
            />
            {vqaPending && <p className="text-sm text-ink-soft italic" aria-live="polite">Getting the answer...</p>}
            {vqaAnswer && (
              // Visual only — the answer is spoken once via announce(answer)
              // (handleVqaSubmit). A second role="status"/aria-live region here
              // made VoiceOver read the answer twice and append "status".
              <div className="p-3 bg-success/10 border border-success/40 rounded-lg">
                <p className="text-xs font-semibold text-success uppercase tracking-wide mb-1">Answer</p>
                <p className="text-sm text-ink">{vqaAnswer}</p>
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
          className="w-full py-3 text-sm font-medium rounded bg-brand text-on-brand hover:bg-brand-strong transition-colors"
          style={{ minHeight: '48px' }}
        >
          {showEditPanel ? 'Hide Edit Options' : 'Edit by Myself'}
        </button>
        {showEditPanel && (
          <div
            role="group"
            aria-label="Edit by Myself"
            className="mt-2 p-3 bg-sunken rounded-lg border border-line flex flex-col gap-2"
          >
            {/* Trim (split). The probe labels this "Trim here" with explanatory
                copy + a live clip-count, because pairing Trim with Remove is how
                a BLV creator drops an unwanted part of a scene. */}
            <p className="text-sm text-ink-soft">
              Trims this scene at the current playback time — it splits into two
              clips. Pair with Delete to drop the part you don&apos;t want.
            </p>
            <p
              className="text-xs text-ink-soft"
              data-clip-count-for={clip.id}
            >
              This scene currently has {clipCountForScene} clip
              {clipCountForScene === 1 ? '' : 's'}.
            </p>
            <button
              type="button"
              onClick={handleSplit}
              aria-label="Trim this scene at the current position — splits it into two clips"
              className="w-full py-3 rounded-lg bg-brand text-sm font-bold text-on-brand hover:bg-brand-strong"
              style={{ minHeight: '48px' }}
            >
              Trim here
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleMoveEarlier}
                aria-label="Move this clip earlier in the timeline"
                className="flex-1 py-3 rounded-lg bg-sunken text-sm font-semibold text-ink-soft hover:bg-line"
                style={{ minHeight: '48px' }}
              >
                Move Earlier
              </button>
              <button
                type="button"
                onClick={handleMoveLater}
                aria-label="Move this clip later in the timeline"
                className="flex-1 py-3 rounded-lg bg-sunken text-sm font-semibold text-ink-soft hover:bg-line"
                style={{ minHeight: '48px' }}
              >
                Move Later
              </button>
            </div>
            <button
              type="button"
              onClick={() => setDeletePending(true)}
              aria-label="Delete this clip from the timeline"
              className="w-full rounded-lg bg-danger py-3 text-sm font-bold text-on-accent hover:opacity-90"
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
                className="flex-1 py-3 rounded-lg bg-sunken text-sm font-semibold text-ink-soft hover:bg-line disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ minHeight: '48px' }}
              >
                Undo
              </button>
              <button
                type="button"
                onClick={handleRedo}
                disabled={!canRedo}
                aria-label="Redo last undone edit"
                className="flex-1 py-3 rounded-lg bg-sunken text-sm font-semibold text-ink-soft hover:bg-line disabled:opacity-40 disabled:cursor-not-allowed"
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
                className="w-full rounded-lg bg-helper py-3 text-sm font-bold text-on-accent hover:opacity-90"
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
                  className="flex-1 px-3 py-2 border border-line-strong bg-surface text-ink rounded-lg text-sm"
                  style={{ minHeight: '48px' }}
                  aria-label="Caption text"
                />
                <button
                  type="button"
                  onClick={handleAddCaption}
                  disabled={!captionText.trim()}
                  aria-label="Save caption"
                  className="rounded-lg bg-helper px-4 py-2 text-sm font-bold text-on-accent hover:opacity-90 disabled:opacity-40"
                  style={{ minHeight: '48px', minWidth: '48px' }}
                >
                  Save
                </button>
              </div>
            )}
            {/* Mute / unmute the ORIGINAL scene audio (probe Day 1 D4). */}
            <button
              type="button"
              onClick={handleToggleMute}
              aria-pressed={isMuted}
              aria-label={
                isMuted
                  ? `Unmute the original audio for scene ${index + 1}`
                  : `Mute the original audio for scene ${index + 1}`
              }
              className={`w-full py-3 rounded-lg text-sm font-bold border ${
                isMuted
                  ? 'bg-helper text-on-accent border-transparent hover:opacity-90'
                  : 'bg-surface text-ink border-line-strong hover:bg-sunken'
              }`}
              style={{ minHeight: '48px' }}
            >
              {isMuted ? 'Unmute original audio' : 'Mute original audio'}
            </button>
          </div>
        )}
      </div>

      {/* Ask AI to Edit — amber (AI). Confirm-first via ConfirmAiEditDialog. */}
      <div>
        <button
          type="button"
          onClick={handleToggleAiEdit}
          className="w-full py-3 text-sm font-medium rounded bg-helper text-on-accent hover:opacity-90 transition-colors"
          style={{ minHeight: '48px' }}
        >
          {showAiEdit ? 'Close AI Edit' : 'Ask AI to Edit'}
        </button>
        {showAiEdit && (
          <div
            role="group"
            aria-label="Ask AI to Edit"
            className="mt-2 p-3 bg-sunken rounded-lg border border-line flex flex-col gap-2"
          >
            <VoiceComposer
              onSubmit={handleAiEditSubmit}
              disabled={aiEditPending}
              placeholder="Describe what you want done..."
              announcement="Speak now. Describe the edit."
              submitLabel="Ask AI"
              inputAriaLabel="Task description"
            />
            {aiEditPending && <p className="text-sm text-ink-soft italic" aria-live="polite">AI is working...</p>}
            {aiEditNote && (
              // Visual only — the note is spoken once via announce() in
              // handleAiEditSubmit; a second live region read it twice + "status".
              <div className="p-3 border-2 rounded-lg bg-helper-soft border-helper/50">
                <p className="text-sm text-ink">{aiEditNote}</p>
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
          className="w-full py-3 text-sm font-medium rounded bg-creator text-on-accent hover:opacity-90 transition-colors"
          style={{ minHeight: '48px' }}
        >
          {showHelper ? 'Close Helper Edit' : 'Ask Helper to Edit'}
        </button>
        {showHelper && (
          <div
            role="group"
            aria-label="Ask Helper"
            className="mt-2 p-3 bg-sunken rounded-lg border border-line flex flex-col gap-2"
          >
            <VoiceComposer
              onSubmit={handleHelperSubmit}
              placeholder="Describe what you want done..."
              announcement="Speak now. Describe the task for your helper."
              submitLabel="Send to helper"
              inputAriaLabel="Task description"
              // Helper-task voice FILLS the field for review, then the creator
              // sends explicitly — a blind helper can compose a longer,
              // multi-sentence instruction (probe TaskRouterPanel). VQA + Ask AI
              // to Edit keep the default auto-submit.
              submitOnVoice={false}
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
      {deletePending && clip && (
        <ConfirmEditDialog
          title="Remove scene"
          question={`Remove ${clip.name} from the edit?`}
          confirmLabel="Remove"
          destructive
          onConfirm={handleConfirmDelete}
          onCancel={() => setDeletePending(false)}
        />
      )}
    </>
  )
}
