/**
 * Scene-level edit operations for Probe 2a's "Edit by Myself" panel.
 *
 * B2 fix: previously the Trim / Split / Move / Add Caption / Add Note buttons
 * fired a log event but produced no UI change, leaving participants confused
 * about whether their tap registered. These helpers produce real editState
 * mutations so each action has visible consequences in the timeline.
 *
 * Each function takes the current editState and returns a new editState
 * with the operation applied; pass the result to onEditChange. Functions
 * never mutate the input — they're safe to call from React renders.
 */

const TRIM_STEP_SECONDS = 0.5;

// Monotonic suffix so ids generated within the same millisecond don't collide
// (Date.now() alone repeats within a tick for rapid split/caption/note actions,
// which would produce duplicate React keys and clip ids).
let _idSeq = 0;
function uniqueSuffix() {
  return `${Date.now()}-${(_idSeq++).toString(36)}`;
}

export function trimClipStart(editState, sceneId, direction) {
  // direction: +1 trims more from start (clip becomes shorter from the front),
  //            -1 untrims (clip recovers length up to original start).
  const delta = direction * TRIM_STEP_SECONDS;
  return mapClips(editState, sceneId, (c) => ({
    ...c,
    trimStart: Math.max(0, (c.trimStart || 0) + delta),
  }));
}

export function trimClipEnd(editState, sceneId, direction) {
  const delta = direction * TRIM_STEP_SECONDS;
  return mapClips(editState, sceneId, (c) => ({
    ...c,
    trimEnd: Math.max(0, (c.trimEnd || 0) + delta),
  }));
}

export function splitClip(editState, sceneId, splitTime) {
  const clips = editState.clips || [];
  const idx = clips.findIndex((c) => c.id === sceneId);
  if (idx === -1) return editState;
  const clip = clips[idx];
  // Default to mid-clip if no explicit time provided. We never split exactly
  // at a boundary (would create a zero-length clip).
  const epsilon = 0.05;
  const start = clip.startTime + (clip.trimStart || 0);
  const end = clip.endTime - (clip.trimEnd || 0);
  let at = typeof splitTime === 'number' ? splitTime : (start + end) / 2;
  at = Math.max(start + epsilon, Math.min(end - epsilon, at));
  const first = { ...clip, endTime: at, trimEnd: 0 };
  const second = {
    ...clip,
    id: `${clip.id}-split-${uniqueSuffix()}`,
    startTime: at,
    trimStart: 0,
  };
  return {
    ...editState,
    clips: [...clips.slice(0, idx), first, second, ...clips.slice(idx + 1)],
  };
}

export function moveClip(editState, sceneId, direction) {
  const clips = editState.clips || [];
  const idx = clips.findIndex((c) => c.id === sceneId);
  if (idx === -1) return editState;
  const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= clips.length) return editState;
  const next = clips.slice();
  [next[idx], next[targetIdx]] = [next[targetIdx], next[idx]];
  return { ...editState, clips: next };
}

export function addCaption(editState, sceneId, text) {
  const clean = (text || '').trim();
  if (!clean) return editState;
  const clip = (editState.clips || []).find((c) => c.id === sceneId);
  if (!clip) return editState;
  const caption = {
    id: `caption-${uniqueSuffix()}`,
    sceneId,
    text: clean,
    startTime: clip.startTime,
    endTime: clip.endTime,
  };
  return {
    ...editState,
    captions: [...(editState.captions || []), caption],
  };
}

export function addNote(editState, sceneId, text) {
  // Notes are scene-level annotations that don't render in the timeline —
  // they're for the creator's own memory or for the helper to read on
  // handover. Stored in editState.notes (a new array, optional).
  const clean = (text || '').trim();
  if (!clean) return editState;
  const note = {
    id: `note-${uniqueSuffix()}`,
    sceneId,
    text: clean,
    timestamp: Date.now(),
  };
  return {
    ...editState,
    notes: [...(editState.notes || []), note],
  };
}

export function getClipForScene(editState, sceneId) {
  return (editState?.clips || []).find((c) => c.id === sceneId) || null;
}

export function getCaptionsForScene(editState, sceneId) {
  return (editState?.captions || []).filter((c) => c.sceneId === sceneId);
}

export function getNotesForScene(editState, sceneId) {
  return (editState?.notes || []).filter((n) => n.sceneId === sceneId);
}

function mapClips(editState, sceneId, fn) {
  const clips = (editState.clips || []).map((c) => (c.id === sceneId ? fn(c) : c));
  return { ...editState, clips };
}

export function deleteClip(editState, sceneId) {
  const clips = (editState.clips || []).filter((c) => c.id !== sceneId);
  const captions = (editState.captions || []).filter((cap) => cap.sceneId !== sceneId);
  return { ...editState, clips, captions };
}

/**
 * Sound library — placeholder catalogue surfaced to both creator and helper.
 * Per Day 1 feedback: simplified from {music, effect} to a single generic
 * "Add sound" entry. The mute action below covers the "remove the original
 * scene audio" half of the requirement (D4: original audio only).
 *
 * Older clip metadata that referenced 'background_music' / 'sound_effect'
 * still resolves through getSoundById to its known shape — we just no
 * longer surface those as separate buttons.
 */
export const SOUND_LIBRARY = [
  { id: 'sound_effect', name: 'Sample sound', label: '🔊 Add sound' },
];

const LEGACY_SOUNDS = {
  background_music: { id: 'background_music', name: 'Background music', label: '🎵 Music' },
  sound_effect: { id: 'sound_effect', name: 'Sample sound', label: '🔊 Add sound' },
};

export function getSoundById(soundId) {
  return SOUND_LIBRARY.find((s) => s.id === soundId) || LEGACY_SOUNDS[soundId] || null;
}

/**
 * Attach a sound entry to a clip (or all clips matching a scene id after split).
 * Pass `sound = null` to clear. Sound shape: { id, name, addedBy }.
 *
 * Splits create new clip ids of the form `${sceneId}-split-${ts}`; we update
 * every clip that originated from sceneId so post-split timelines stay in sync.
 */
export function setClipSound(editState, sceneId, sound) {
  const clips = (editState.clips || []).map((c) => {
    const matches = c.id === sceneId
      || (typeof c.id === 'string' && c.id.startsWith(`${sceneId}-split-`));
    return matches ? { ...c, sound: sound || null } : c;
  });
  return { ...editState, clips };
}

export function getSoundForScene(editState, sceneId) {
  const clip = (editState?.clips || []).find(
    (c) => c.id === sceneId
      || (typeof c.id === 'string' && c.id.startsWith(`${sceneId}-split-`))
  );
  return clip?.sound || null;
}

/**
 * Mute / unmute the *original* video audio for a scene. Distinct from
 * `setClipSound`: that one attaches an overlay sound, this one silences
 * the source clip's own audio. Per Day 1 D4 — David's case where the DJ
 * background drowned out his vocal needed a way to mute the source so a
 * helper-attached voiceover can be added on top.
 *
 * Like setClipSound, this propagates the flag to every clip derived from
 * a split so the timeline stays consistent.
 */
export function setClipMuted(editState, sceneId, muted) {
  const flag = !!muted;
  const clips = (editState.clips || []).map((c) => {
    const matches = c.id === sceneId
      || (typeof c.id === 'string' && c.id.startsWith(`${sceneId}-split-`));
    return matches ? { ...c, muted: flag } : c;
  });
  return { ...editState, clips };
}

export function getClipMuted(editState, sceneId) {
  const clip = (editState?.clips || []).find(
    (c) => c.id === sceneId
      || (typeof c.id === 'string' && c.id.startsWith(`${sceneId}-split-`))
  );
  return !!clip?.muted;
}

/**
 * Single dispatcher for both AI-accept and self-edit paths. Maps a free-form
 * operation key (from `ai_edits_prepared` keys, Gemini drafts, or self-edit
 * buttons) to the matching scene-edit op. Returns a new editState; never
 * mutates input. If the operation is unknown the original state is returned.
 *
 * options:
 *   currentTime — for `split`, the playhead time; falls back to clip midpoint
 *   captionText — for `add_caption`, the caption text; defaults to a placeholder
 *   direction   — for `reorder`/`move_*`, 'up' (earlier) or 'down' (later)
 */
export function applyOperation(editState, sceneId, operation, options = {}) {
  if (!editState || !sceneId || !operation) return editState;
  const op = String(operation).toLowerCase();
  switch (op) {
    case 'trim':
    case 'trim_start':
      return trimClipStart(editState, sceneId, +1);
    case 'trim_end':
      return trimClipEnd(editState, sceneId, +1);
    case 'split':
      return splitClip(editState, sceneId, options.currentTime);
    case 'delete':
    case 'remove':
    case 'discard':
      return deleteClip(editState, sceneId);
    case 'reorder':
    case 'move_earlier':
    case 'move_up':
      return moveClip(editState, sceneId, 'up');
    case 'move_later':
    case 'move_down':
      return moveClip(editState, sceneId, 'down');
    case 'add_caption':
    case 'caption':
      return addCaption(editState, sceneId, options.captionText || 'AI-added caption');
    case 'add_sound':
    case 'sound': {
      const sound = options.sound
        || getSoundById(options.soundId)
        || SOUND_LIBRARY[0];
      return setClipSound(editState, sceneId, { ...sound, addedBy: options.addedBy || 'ai' });
    }
    case 'remove_sound':
      return setClipSound(editState, sceneId, null);
    case 'mute':
    case 'mute_audio':
      return setClipMuted(editState, sceneId, true);
    case 'unmute':
    case 'unmute_audio':
      return setClipMuted(editState, sceneId, false);
    case 'toggle_mute':
      return setClipMuted(editState, sceneId, !getClipMuted(editState, sceneId));
    default:
      return editState;
  }
}
