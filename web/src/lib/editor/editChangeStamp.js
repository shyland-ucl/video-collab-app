/**
 * buildEditChangeSceneStamp — purpose-built util that returns a CONSISTENT
 * { sceneId, text } pair describing the single most-salient edit between two
 * edit states. Ported from the study probe
 * (video-collab-probe/src/utils/editChangeStamp.js).
 *
 * Why this exists: CreatorDevice previously derived the amber "Edited" badge
 * text from `summarizeEditStateChange` but resolved the badge's target scene
 * id with a SEPARATE helper. The two could disagree (e.g. on delete the text
 * said "Deleted scene 2" while the id pointed at the survivor clip). This util
 * decides the scene id and the change text TOGETHER from one diff, so they can
 * never drift apart.
 *
 * Adaptation from the probe (per the port contract):
 * - No study-only imports — the probe file is self-contained, so nothing was
 *   stripped from the logic itself.
 * - `baseSceneId` is adapted to THIS app's split-id format. The probe's split
 *   ids end in `-split-<digits>`; the web app's `sceneEditOps.splitClip`
 *   produces `-split-<ts>-<seq>` (see stateStore.rootSegmentId), so the regex
 *   here matches the web format to keep the stamp landing on the originating
 *   root segment (which is the scene still rendered in the list).
 *
 * Returns null when no recognised change is found (caller then stamps nothing).
 */

// Strip a clip id back to its originating segment id. Mirrors
// stateStore.rootSegmentId / sceneEditOps.rootOf so a split piece stamps the
// root scene that is still present in the rendered list.
function baseSceneId(id) {
  if (!id || typeof id !== 'string') return id || null;
  return id.replace(/(-split-\d+-[0-9a-z]+)+$/, '');
}

function cleanText(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

function itemId(item, index) {
  return item?.id || `index-${index}`;
}

function findAddedItem(prevItems = [], nextItems = []) {
  const prevIds = new Set(prevItems.map(itemId));
  return nextItems.find((item, index) => !prevIds.has(itemId(item, index))) || null;
}

function findRemovedItem(prevItems = [], nextItems = []) {
  const nextIds = new Set(nextItems.map(itemId));
  return prevItems.find((item, index) => !nextIds.has(itemId(item, index))) || null;
}

function findCaptionSceneId(caption, clips = [], fallbackSceneId = null) {
  if (caption?.sceneId) return baseSceneId(caption.sceneId);

  const captionStart = Number(caption?.startTime ?? caption?.start_time);
  const captionEnd = Number(caption?.endTime ?? caption?.end_time ?? captionStart);
  if (Number.isFinite(captionStart)) {
    const matchingClip = clips.find((clip) => {
      const clipStart = Number(clip?.startTime ?? clip?.start_time);
      const clipEnd = Number(clip?.endTime ?? clip?.end_time);
      if (!Number.isFinite(clipStart) || !Number.isFinite(clipEnd)) return false;
      return captionStart < clipEnd && captionEnd > clipStart;
    });
    if (matchingClip?.id) return baseSceneId(matchingClip.id);
  }

  return baseSceneId(fallbackSceneId);
}

function findFirstClipChange(prevClips = [], nextClips = []) {
  if (nextClips.length > prevClips.length) {
    const added = findAddedItem(prevClips, nextClips);
    const splitBase = added?.id ? baseSceneId(added.id) : null;
    return splitBase ? { sceneId: splitBase, text: 'Split scene' } : null;
  }

  if (nextClips.length < prevClips.length) {
    const removed = findRemovedItem(prevClips, nextClips);
    return removed?.id ? { sceneId: baseSceneId(removed.id), text: 'Removed from edit' } : null;
  }

  const prevOrder = prevClips.map((clip) => clip.id).join('|');
  const nextOrder = nextClips.map((clip) => clip.id).join('|');
  if (prevOrder !== nextOrder) {
    for (let i = 0; i < nextClips.length; i += 1) {
      if (prevClips[i]?.id !== nextClips[i]?.id) {
        const movedId = nextClips[i]?.id;
        const fromIndex = prevClips.findIndex((clip) => clip.id === movedId);
        const text = fromIndex > i ? 'Moved earlier' : 'Moved later';
        return movedId ? { sceneId: baseSceneId(movedId), text } : null;
      }
    }
  }

  for (let i = 0; i < nextClips.length; i += 1) {
    const prev = prevClips[i];
    const next = nextClips[i];
    if (!prev || !next || prev.id !== next.id) continue;
    if (prev.trimStart !== next.trimStart || prev.trimEnd !== next.trimEnd) {
      return { sceneId: baseSceneId(next.id), text: 'Trimmed scene' };
    }

    const prevSound = prev.sound || null;
    const nextSound = next.sound || null;
    if (!prevSound && nextSound) {
      const soundName = cleanText(nextSound.name);
      return {
        sceneId: baseSceneId(next.id),
        text: soundName ? `Sound added: ${soundName}` : 'Sound added',
      };
    }
    if (prevSound && !nextSound) {
      return { sceneId: baseSceneId(next.id), text: 'Sound removed' };
    }
    if (prevSound && nextSound && prevSound.id !== nextSound.id) {
      const soundName = cleanText(nextSound.name);
      return {
        sceneId: baseSceneId(next.id),
        text: soundName ? `Sound changed: ${soundName}` : 'Sound changed',
      };
    }

    // Per-scene playback volume (0–200%, 100 = unchanged). A volume-only diff
    // changes no other clip field, so without this the stamp fell through to
    // null → no "Edited" badge for a volume change. 0% reads as "Muted".
    const prevVolume = typeof prev.volume === 'number' ? prev.volume : 100;
    const nextVolume = typeof next.volume === 'number' ? next.volume : 100;
    if (prevVolume !== nextVolume) {
      return {
        sceneId: baseSceneId(next.id),
        text: nextVolume === 0 ? 'Muted' : `Volume ${nextVolume}%`,
      };
    }

    // Original-audio mute toggle (clip.muted boolean). Distinct from volume: a
    // mute-only diff touches no other field, so it likewise needs its own branch
    // or the stamp stays empty and the "Edited" badge never appears (the gap that
    // made an AI/self mute look like it did nothing). Mirrors summarizeEditState-
    // Change's findMuteChange + describeEditOp's mute/unmute wording.
    if (!!prev.muted !== !!next.muted) {
      return {
        sceneId: baseSceneId(next.id),
        text: next.muted ? 'Original audio muted' : 'Original audio unmuted',
      };
    }
  }

  return null;
}

function findCaptionStamp(prevCaptions = [], nextCaptions = [], clips = [], fallbackSceneId = null) {
  if (nextCaptions.length > prevCaptions.length) {
    const caption = findAddedItem(prevCaptions, nextCaptions);
    const text = cleanText(caption?.text);
    return {
      sceneId: findCaptionSceneId(caption, clips, fallbackSceneId),
      text: text ? `Caption added: ${text}` : 'Caption added',
    };
  }

  if (nextCaptions.length < prevCaptions.length) {
    const caption = findRemovedItem(prevCaptions, nextCaptions);
    const text = cleanText(caption?.text);
    return {
      sceneId: findCaptionSceneId(caption, clips, fallbackSceneId),
      text: text ? `Caption removed: ${text}` : 'Caption removed',
    };
  }

  return null;
}

function findTextOverlayStamp(prevOverlays = [], nextOverlays = [], fallbackSceneId = null) {
  if (nextOverlays.length < prevOverlays.length) {
    const overlay = findRemovedItem(prevOverlays, nextOverlays);
    const text = cleanText(overlay?.content);
    return {
      sceneId: baseSceneId(overlay?.sceneId || fallbackSceneId),
      text: text ? `Text overlay removed: ${text}` : 'Text overlay removed',
    };
  }

  const prevById = new Map(prevOverlays.map((overlay) => [overlay.id, overlay]));
  for (const overlay of nextOverlays) {
    const prev = prevById.get(overlay.id);
    if (!prev) {
      // Creating the text-overlay draft should not highlight the scene yet.
      // The highlight lands when the overlay is applied (appliedAt is set).
      if (!overlay.appliedAt) continue;
      const text = cleanText(overlay.content);
      return {
        sceneId: baseSceneId(overlay.sceneId || fallbackSceneId),
        text: text ? `Text overlay added: ${text}` : 'Text overlay added',
      };
    }

    if (prev.appliedAt !== overlay.appliedAt && overlay.appliedAt) {
      const text = cleanText(overlay.content);
      return {
        sceneId: baseSceneId(overlay.sceneId || fallbackSceneId),
        text: text ? `Text overlay added: ${text}` : 'Text overlay added',
      };
    }

    if (
      overlay.appliedAt
      && (prev.content !== overlay.content
        || prev.size !== overlay.size
        || prev.color !== overlay.color
        || prev.x !== overlay.x
        || prev.y !== overlay.y)
    ) {
      const text = cleanText(overlay.content);
      return {
        sceneId: baseSceneId(overlay.sceneId || fallbackSceneId),
        text: text ? `Text overlay changed: ${text}` : 'Text overlay changed',
      };
    }
  }

  return null;
}

// Colour grade. The colour map is keyed on the root segment id (the helper
// commits state.colour[rootSegmentId(sceneId)]), which is exactly the scene id
// the rendered list still holds — so the stamp lands on the present clip with
// no further mapping. Detects the first scene whose grade changed and, when one
// property moved, names it; a multi-property change stays generic.
// rotate is the 5th visual slider (EditorTimeline COLOUR_SLIDERS) and rides the
// same state.colour map — it MUST be here, or a rotate-only grade (e.g. an AI
// "rotate scene 2" edit) leaves no "Edited" badge. Mirrors projectOverview's
// COLOUR_PROPS, which already includes it for the cross-device summary.
const COLOUR_STAMP_PROPS = ['brightness', 'contrast', 'saturation', 'zoom', 'rotate'];

function colourPropValue(entry, prop) {
  const fallback = prop === 'zoom' ? 100 : 0;
  const value = entry?.[prop];
  return typeof value === 'number' ? value : fallback;
}

function colourPropLabel(prop, value) {
  switch (prop) {
    case 'brightness':
      return `Brightness ${value >= 0 ? '+' : ''}${value}`;
    case 'contrast':
      return `Contrast ${value >= 0 ? '+' : ''}${value}`;
    case 'saturation':
      return `Saturation ${value >= 0 ? '+' : ''}${value}`;
    case 'zoom':
      return `Zoom ${value}%`;
    case 'rotate':
      // Noun phrase to match projectOverview.describeEditOp ("Rotation 30°").
      return `Rotation ${value}°`;
    default:
      return 'Colour adjusted';
  }
}

function findColourStamp(prevColour = {}, nextColour = {}) {
  const prev = prevColour || {};
  const next = nextColour || {};
  const sceneIds = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const sceneId of sceneIds) {
    const prevEntry = prev[sceneId];
    const nextEntry = next[sceneId];
    const changedProps = COLOUR_STAMP_PROPS.filter(
      (prop) => colourPropValue(prevEntry, prop) !== colourPropValue(nextEntry, prop),
    );
    if (changedProps.length === 0) continue;
    const text = changedProps.length === 1
      ? colourPropLabel(changedProps[0], colourPropValue(nextEntry, changedProps[0]))
      : 'Colour adjusted';
    // sceneId is already the root segment id the rendered list holds.
    return { sceneId: baseSceneId(sceneId), text };
  }
  return null;
}

export function buildEditChangeSceneStamp(prevState, nextState, options = {}) {
  if (!prevState || !nextState) return null;
  const fallbackSceneId = options.fallbackSceneId || null;
  const prevCaptions = prevState.captions || [];
  const nextCaptions = nextState.captions || [];
  const nextClips = nextState.clips || [];

  const captionStamp = findCaptionStamp(prevCaptions, nextCaptions, nextClips, fallbackSceneId);
  if (captionStamp?.sceneId) return captionStamp;

  const overlayStamp = findTextOverlayStamp(
    prevState.textOverlays || [],
    nextState.textOverlays || [],
    fallbackSceneId,
  );
  if (overlayStamp?.sceneId) return overlayStamp;

  const clipStamp = findFirstClipChange(prevState.clips || [], nextClips);
  if (clipStamp?.sceneId) return clipStamp;

  const colourStamp = findColourStamp(prevState.colour || {}, nextState.colour || {});
  if (colourStamp?.sceneId) return colourStamp;

  return null;
}
