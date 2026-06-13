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

  return null;
}
