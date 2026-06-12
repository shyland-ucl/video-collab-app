import { buildAllSegments, getTotalDuration } from './buildInitialSources.js';

export function formatDuration(seconds) {
  const totalSeconds = Math.max(0, Math.round(seconds || 0));
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;

  if (minutes > 0 && remainingSeconds > 0) {
    return `${minutes} min ${remainingSeconds} sec`;
  }

  if (minutes > 0) {
    return `${minutes} min`;
  }

  return `${totalSeconds} sec`;
}

export function getEffectiveClipDuration(clip) {
  if (!clip) return 0;
  const start = (clip.startTime || 0) + (clip.trimStart || 0);
  const end = (clip.endTime || 0) - (clip.trimEnd || 0);
  return Math.max(0, end - start);
}

export function getTimelineDuration(editState, fallbackDuration = 0) {
  const clips = editState?.clips || [];
  if (clips.length === 0) return fallbackDuration || 0;
  return clips.reduce((sum, clip) => sum + getEffectiveClipDuration(clip), 0);
}

export function getClipLengthSeconds(clips = []) {
  if (clips.length === 0) return null;
  const firstDuration = getEffectiveClipDuration(clips[0]);
  if (!firstDuration) return null;

  const sameLength = clips.every((clip) => Math.abs(getEffectiveClipDuration(clip) - firstDuration) < 0.01);
  return sameLength ? Math.round(firstDuration) : null;
}

export function buildProjectStats({
  projectData = null,
  editState = null,
  role = null,
  mode = null,
} = {}) {
  const derivedSegments = buildAllSegments(projectData);
  const clips = editState?.clips?.length ? editState.clips : derivedSegments.map((segment) => ({
    id: segment.id,
    startTime: segment.start_time,
    endTime: segment.end_time,
    trimStart: 0,
    trimEnd: 0,
  }));
  const sources = editState?.sources?.length
    ? editState.sources
    : projectData?.videos?.length
      ? projectData.videos
      : projectData?.video
        ? [projectData.video]
        : [];
  const captions = editState?.captions || [];
  const textOverlays = editState?.textOverlays || [];
  const fallbackDuration = getTotalDuration(projectData);
  const totalDuration = getTimelineDuration(editState, fallbackDuration);

  return {
    role,
    mode,
    videoCount: sources.length,
    totalDuration,
    clipCount: clips.length,
    clipLengthSeconds: getClipLengthSeconds(clips),
    captionCount: captions.length,
    textOverlayCount: textOverlays.length,
  };
}

export function getProjectOverviewText(projectStats = {}) {
  const {
    totalDuration = 0,
    clipCount = 0,
    captionCount = 0,
    textOverlayCount = 0,
  } = projectStats;

  const parts = [
    `${clipCount} ${clipCount === 1 ? 'clip' : 'clips'}`,
    `${formatDuration(totalDuration)} total length`,
  ];

  if (captionCount > 0) {
    parts.push(`${captionCount} ${captionCount === 1 ? 'caption' : 'captions'}`);
  }

  if (textOverlayCount > 0) {
    parts.push(`${textOverlayCount} ${textOverlayCount === 1 ? 'text overlay' : 'text overlays'}`);
  }

  return `Current project overview: ${parts.join(', ')}.`;
}

export function buildSessionGuide({ condition, projectStats = {} }) {
  const {
    role = 'creator',
    videoCount = 0,
    totalDuration = 0,
    clipCount = 0,
    clipLengthSeconds = null,
  } = projectStats;
  const videoLabel = videoCount === 1 ? 'video' : 'videos';
  const clipLabel = clipCount === 1 ? 'clip' : 'clips';
  const clipLengthLabel = clipLengthSeconds
    ? `${clipCount} ${clipLengthSeconds}-second ${clipLabel}`
    : `${clipCount} ${clipLabel}`;
  const totalDurationLabel = formatDuration(totalDuration);

  if (condition === 'probe2') {
    if (role === 'helper') {
      return {
        title: 'Helper Editing Page',
        color: '#5CB85C',
        summary: `${videoCount} ${videoLabel}, ${totalDurationLabel} total, ${clipLengthLabel} in the shared project.`,
        sectionTitle: 'Guide Tour',
        steps: [
          { icon: '1', text: 'Check the task card or live collaboration card first.' },
          { icon: '2', text: 'Use the visual editor to split, move, trim, caption, or annotate clips.' },
          { icon: '3', text: 'Return the device with a short summary when you are done.' },
        ],
        dismissLabel: 'Start helping',
      };
    }

    return {
      title: 'Creator Editing Page',
      color: '#5CB85C',
      summary: `${videoCount} ${videoLabel}, ${totalDurationLabel} total, ${clipLengthLabel} ready for review and handover.`,
      sectionTitle: 'Guide Tour',
      steps: [
        { icon: '1', text: 'Use Previous and Next to move scene by scene.' },
        { icon: '2', text: 'Tap Less or More to change the description detail.' },
        { icon: '3', text: 'Use Mark to flag a scene and record a voice note.' },
        { icon: '4', text: 'Start a handover when you want the helper to take over.' },
      ],
      dismissLabel: 'Start editing',
    };
  }

  if (condition === 'probe2b') {
    if (role === 'helper') {
      return {
        title: 'Helper Collaboration Page',
        color: '#5CB85C',
        summary: `${videoCount} ${videoLabel}, ${totalDurationLabel} total, ${clipLengthLabel} in the shared project.`,
        sectionTitle: 'Guide Tour',
        steps: [
          { icon: '1', text: 'Use the activity feed to review creator tasks.' },
          { icon: '2', text: 'Use the visual editor to split, reorder, trim, caption, or annotate clips.' },
          { icon: '3', text: 'Your edits sync back to the creator automatically.' },
        ],
        dismissLabel: 'Open helper view',
      };
    }

    return {
      title: 'Creator Collaboration Page',
      color: '#5CB85C',
      summary: `${videoCount} ${videoLabel}, ${totalDurationLabel} total, ${clipLengthLabel} ready for shared editing.`,
      sectionTitle: 'Guide Tour',
      steps: [
        { icon: '1', text: 'Move through scenes with Previous and Next.' },
        { icon: '2', text: 'Use Less or More to change the description detail.' },
        { icon: '3', text: 'Use Edit Myself, Ask AI, or Ask Helper on the current scene.' },
        { icon: '4', text: 'Listen for project updates when the helper changes the video.' },
      ],
      dismissLabel: 'Open creator view',
    };
  }

  if (condition === 'probe3') {
    if (role === 'helper') {
      return {
        title: 'Helper AI Collaboration Page',
        color: '#9B59B6',
        summary: `${videoCount} ${videoLabel}, ${totalDurationLabel} total, ${clipLengthLabel} in the shared project.`,
        sectionTitle: 'Guide Tour',
        steps: [
          { icon: '1', text: 'Review creator tasks and AI observations in the activity feed.' },
          { icon: '2', text: 'Use the editor to make visual changes, including captions and text overlays.' },
          { icon: '3', text: 'Respond when the creator routes an AI observation to you.' },
        ],
        dismissLabel: 'Open helper view',
      };
    }

    return {
      title: 'Creator AI Collaboration Page',
      color: '#9B59B6',
      summary: `${videoCount} ${videoLabel}, ${totalDurationLabel} total, ${clipLengthLabel} ready for AI and helper collaboration.`,
      sectionTitle: 'Guide Tour',
      steps: [
        { icon: '1', text: 'Move scene by scene with Previous and Next.' },
        { icon: '2', text: 'Use Edit Myself, Ask AI, or Ask Helper on the current scene.' },
        { icon: '3', text: 'Watch for AI suggestions that appear while you explore.' },
        { icon: '4', text: 'Review updates when the helper changes the video.' },
      ],
      dismissLabel: 'Open creator view',
    };
  }

  return null;
}

function overlaysChanged(prevOverlays = [], nextOverlays = []) {
  if (prevOverlays.length !== nextOverlays.length) {
    if (nextOverlays.length > prevOverlays.length) {
      const prevIds = new Set(prevOverlays.map((overlay) => overlay.id));
      return { type: 'added', overlay: nextOverlays.find((overlay) => !prevIds.has(overlay.id)) };
    }
    const nextIds = new Set(nextOverlays.map((overlay) => overlay.id));
    return { type: 'removed', overlay: prevOverlays.find((overlay) => !nextIds.has(overlay.id)) };
  }

  for (let i = 0; i < nextOverlays.length; i += 1) {
    const prev = prevOverlays[i];
    const next = nextOverlays[i];
    if (!prev || !next) continue;
    if (prev.id !== next.id) {
      return { type: 'reordered' };
    }
    if (prev.appliedAt !== next.appliedAt) {
      return { type: 'applied', overlay: next };
    }
    if (prev.content !== next.content || prev.size !== next.size || prev.color !== next.color) {
      return { type: 'updated', overlay: next };
    }
    if (prev.x !== next.x || prev.y !== next.y) {
      return { type: 'moved', overlay: next };
    }
  }

  return null;
}

function findAddedItem(prevItems = [], nextItems = []) {
  const prevIds = new Set(prevItems.map((item) => item.id));
  return nextItems.find((item) => !prevIds.has(item.id)) || null;
}

function textContentPhrase(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean ? ` with text: ${clean}` : '';
}

function trimsChanged(prevClips = [], nextClips = []) {
  if (prevClips.length !== nextClips.length) return false;
  return prevClips.some((clip, index) => {
    const nextClip = nextClips[index];
    if (!nextClip || clip.id !== nextClip.id) return false;
    return clip.trimStart !== nextClip.trimStart || clip.trimEnd !== nextClip.trimEnd;
  });
}

function findFirstDifferingIndex(prevClips, nextClips) {
  const len = Math.min(prevClips.length, nextClips.length);
  for (let i = 0; i < len; i += 1) {
    if (prevClips[i]?.id !== nextClips[i]?.id) return i;
  }
  return -1;
}

function findDeletedSceneIndex(prevClips, nextClips) {
  const nextIds = new Set(nextClips.map((c) => c.id));
  return prevClips.findIndex((c) => !nextIds.has(c.id));
}

function findSplitSceneIndex(prevClips, nextClips) {
  // splitClip replaces clip at idx with `first` (same id) and inserts `second`
  // (id ending in -split-) right after. The first differing index points at
  // the new `second` clip; the original is at i - 1.
  const i = findFirstDifferingIndex(prevClips, nextClips);
  if (i === -1) return Math.max(0, prevClips.length - 1);
  // Prefer the original clip's prev-index when we can resolve it.
  const splitClip = nextClips[i];
  if (splitClip && typeof splitClip.id === 'string') {
    const baseId = splitClip.id.replace(/-split-\d+$/, '');
    const origIdx = prevClips.findIndex((c) => c.id === baseId);
    if (origIdx !== -1) return origIdx;
  }
  return Math.max(0, i - 1);
}

function findReorderedSceneInfo(prevClips, nextClips) {
  const i = findFirstDifferingIndex(prevClips, nextClips);
  if (i === -1) return null;
  const movedClipId = nextClips[i]?.id;
  if (!movedClipId) return null;
  const fromIndex = prevClips.findIndex((c) => c.id === movedClipId);
  if (fromIndex === -1 || fromIndex === i) return null;
  return {
    fromIndex,
    toIndex: i,
    direction: fromIndex > i ? 'earlier' : 'later',
  };
}

function findTrimmedSceneIndex(prevClips, nextClips) {
  for (let i = 0; i < prevClips.length; i += 1) {
    const prev = prevClips[i];
    const next = nextClips[i];
    if (!next || prev.id !== next.id) continue;
    if (prev.trimStart !== next.trimStart || prev.trimEnd !== next.trimEnd) {
      return i;
    }
  }
  return -1;
}

function findCaptionChangeSceneIndex(prevCaptions, nextCaptions, prevClips, nextClips) {
  if (nextCaptions.length > prevCaptions.length) {
    const prevIds = new Set(prevCaptions.map((c) => c.id));
    const added = nextCaptions.find((c) => !prevIds.has(c.id));
    if (added?.sceneId) {
      const idx = nextClips.findIndex((c) => c.id === added.sceneId);
      if (idx !== -1) return idx;
    }
  } else if (nextCaptions.length < prevCaptions.length) {
    const nextIds = new Set(nextCaptions.map((c) => c.id));
    const removed = prevCaptions.find((c) => !nextIds.has(c.id));
    if (removed?.sceneId) {
      const idx = prevClips.findIndex((c) => c.id === removed.sceneId);
      if (idx !== -1) return idx;
    }
  }
  return -1;
}

function findSoundChange(prevClips, nextClips) {
  if (prevClips.length !== nextClips.length) return null;
  for (let i = 0; i < prevClips.length; i += 1) {
    const prev = prevClips[i];
    const next = nextClips[i];
    if (!next || prev.id !== next.id) continue;
    const prevSound = prev.sound || null;
    const nextSound = next.sound || null;
    if (!prevSound && nextSound) return { type: 'added', index: i, sound: nextSound };
    if (prevSound && !nextSound) return { type: 'removed', index: i, sound: prevSound };
    if (prevSound && nextSound && prevSound.id !== nextSound.id) {
      return { type: 'changed', index: i, sound: nextSound };
    }
  }
  return null;
}

function findVolumeChange(prevClips, nextClips) {
  if (prevClips.length !== nextClips.length) return null;
  for (let i = 0; i < prevClips.length; i += 1) {
    const prev = prevClips[i];
    const next = nextClips[i];
    if (!next || prev.id !== next.id) continue;
    const prevVol = typeof prev.volume === 'number' ? prev.volume : 100;
    const nextVol = typeof next.volume === 'number' ? next.volume : 100;
    if (prevVol !== nextVol) {
      return { index: i, prevVolume: prevVol, nextVolume: nextVol };
    }
  }
  return null;
}

function sceneLabel(index) {
  return `scene ${index + 1}`;
}

export function labelEditActor(actor, fallback = 'Helper') {
  switch (actor) {
    case 'CREATOR':
      return 'Creator';
    case 'HELPER':
      return 'Helper';
    case 'RESEARCHER':
      return 'AI';
    case 'AI':
      return 'AI';
    default:
      return fallback;
  }
}

/**
 * Day 1 fix #3: short, human-readable label for a single scene-level edit.
 * The result is what we render in the SceneBlock's "What changed:" line and
 * include in the TalkBack-readable aria-label on the header.
 *
 * Operations include both editState ops (split, delete, move, captions, sound)
 * and the visual adjustments wired through COLOUR_UPDATE (brightness, contrast,
 * saturation, zoom, rotate). The latter are passed with `value` and a sign
 * so we can render "+15" / "-5" / "120%".
 */
export function describeEditOp(operation, options = {}) {
  if (!operation) return 'Edited';
  const op = String(operation).toLowerCase();
  const value = options.value;
  const num = typeof value === 'number' ? value : null;
  switch (op) {
    case 'trim':
    case 'trim_start':
      return 'Trimmed start';
    case 'trim_end':
      return 'Trimmed end';
    case 'split':
      return 'Trimmed at this point';
    case 'delete':
    case 'remove':
    case 'discard':
      return 'Removed from edit';
    case 'reorder':
    case 'move_earlier':
    case 'move_up':
      return 'Moved earlier';
    case 'move_later':
    case 'move_down':
      return 'Moved later';
    case 'add_caption':
    case 'caption':
      return 'Caption added';
    case 'remove_caption':
      return 'Caption removed';
    case 'add_sound':
    case 'sound':
      return 'Sound added';
    case 'remove_sound':
      return 'Sound removed';
    case 'mute':
    case 'mute_audio':
      return 'Original audio muted';
    case 'unmute':
    case 'unmute_audio':
      return 'Original audio unmuted';
    case 'volume':
      if (num === 0) return 'Muted';
      return num != null ? `Volume ${num}%` : 'Volume changed';
    case 'brightness':
      return num != null ? `Brightness ${num >= 0 ? '+' : ''}${num}` : 'Brightness changed';
    case 'contrast':
      return num != null ? `Contrast ${num >= 0 ? '+' : ''}${num}` : 'Contrast changed';
    case 'saturation':
      return num != null ? `Saturation ${num >= 0 ? '+' : ''}${num}` : 'Saturation changed';
    case 'zoom':
      return num != null ? `Zoom ${num}%` : 'Zoom changed';
    case 'rotate':
      return num != null ? `Rotated ${num}°` : 'Rotation changed';
    case 'success':
    case 'researcher_response':
    case 'visual_adjust':
      return 'AI fix applied';
    default:
      return `${op.replace(/_/g, ' ')} applied`;
  }
}

export function summarizeEditStateChange(prevState, nextState, actorLabel = 'Collaborator') {
  const prevClips = prevState?.clips || [];
  const nextClips = nextState?.clips || [];
  const prevCaptions = prevState?.captions || [];
  const nextCaptions = nextState?.captions || [];
  const prevSources = prevState?.sources || [];
  const nextSources = nextState?.sources || [];
  const prevTextOverlays = prevState?.textOverlays || [];
  const nextTextOverlays = nextState?.textOverlays || [];

  // Start empty so we can tell "I detected a real change" apart from "nothing
  // changed but I have to return something". The participant pages key the
  // toast + announce on hasSummaryText; an empty summary stays silent, which
  // matters because a spurious EDIT_STATE_UPDATE re-broadcast (e.g. dashboard
  // remounting on tab switch) used to trigger TalkBack to read "AI updated
  // the project" even though nothing actually changed.
  let actionText = '';
  let promptText = '';

  if (nextSources.length > prevSources.length) {
    actionText = 'imported new footage';
    promptText = 'Check the timeline to review the new source material.';
  } else if (nextClips.length > prevClips.length) {
    const idx = findSplitSceneIndex(prevClips, nextClips);
    actionText = idx >= 0 ? `split ${sceneLabel(idx)}` : 'split a clip';
    promptText = 'Check the timeline to review the new clip boundaries.';
  } else if (nextClips.length < prevClips.length) {
    const idx = findDeletedSceneIndex(prevClips, nextClips);
    actionText = idx >= 0 ? `deleted ${sceneLabel(idx)}` : 'deleted a clip';
    promptText = 'Check the timeline to confirm the updated sequence.';
  } else if (prevClips.map((clip) => clip.id).join('|') !== nextClips.map((clip) => clip.id).join('|')) {
    const info = findReorderedSceneInfo(prevClips, nextClips);
    if (info) {
      actionText = `moved ${sceneLabel(info.fromIndex)} ${info.direction}`;
    } else {
      actionText = 'reordered the clips';
    }
    promptText = 'Check the timeline because the clip order changed.';
  } else if (trimsChanged(prevClips, nextClips)) {
    const idx = findTrimmedSceneIndex(prevClips, nextClips);
    actionText = idx >= 0 ? `trimmed ${sceneLabel(idx)}` : 'trimmed a clip';
    promptText = 'Check the timeline to review the new clip length.';
  } else if (nextCaptions.length > prevCaptions.length) {
    const idx = findCaptionChangeSceneIndex(prevCaptions, nextCaptions, prevClips, nextClips);
    const addedCaption = findAddedItem(prevCaptions, nextCaptions);
    actionText = idx >= 0
      ? `added a caption to ${sceneLabel(idx)}${textContentPhrase(addedCaption?.text)}`
      : `added a caption${textContentPhrase(addedCaption?.text)}`;
    promptText = 'Check the video to review the new caption.';
  } else if (nextCaptions.length < prevCaptions.length) {
    const idx = findCaptionChangeSceneIndex(prevCaptions, nextCaptions, prevClips, nextClips);
    actionText = idx >= 0 ? `removed a caption from ${sceneLabel(idx)}` : 'removed a caption';
    promptText = 'Check the video to confirm the caption changes.';
  } else {
    const soundChange = findSoundChange(prevClips, nextClips);
    const volumeChange = soundChange ? null : findVolumeChange(prevClips, nextClips);
    if (soundChange) {
      const label = sceneLabel(soundChange.index);
      const soundName = soundChange.sound?.name || 'sound';
      if (soundChange.type === 'added') {
        actionText = `added ${soundName} to ${label}`;
        promptText = 'Check the video to hear the new sound.';
      } else if (soundChange.type === 'removed') {
        actionText = `removed sound from ${label}`;
        promptText = 'Check the video to confirm the sound was removed.';
      } else {
        actionText = `changed sound on ${label} to ${soundName}`;
        promptText = 'Check the video to hear the updated sound.';
      }
    } else if (volumeChange) {
      const label = sceneLabel(volumeChange.index);
      const next = volumeChange.nextVolume;
      if (next === 0) {
        actionText = `muted ${label}`;
      } else if (next === 100) {
        actionText = `restored ${label} volume to 100%`;
      } else {
        actionText = `set ${label} volume to ${next}%`;
      }
      promptText = 'Play the scene to hear the volume change.';
    } else {
      const overlayChange = overlaysChanged(prevTextOverlays, nextTextOverlays);
      if (overlayChange?.type === 'added') {
        actionText = 'added a text overlay';
        promptText = 'Check the video to review the new text overlay.';
      } else if (overlayChange?.type === 'applied') {
        actionText = `applied a text overlay${textContentPhrase(overlayChange.overlay?.content)}`;
        promptText = 'Check the video to review the applied text overlay.';
      } else if (overlayChange?.type === 'removed') {
        actionText = 'removed a text overlay';
        promptText = 'Check the video to confirm the text overlay changes.';
      } else if (overlayChange?.type === 'updated') {
        actionText = 'updated a text overlay';
        promptText = 'Check the video to review the updated text overlay.';
      } else if (overlayChange?.type === 'moved') {
        actionText = 'moved a text overlay';
        promptText = 'Check the video to review the new overlay position.';
      } else if (overlayChange?.type === 'reordered') {
        actionText = 'reordered the text overlays';
        promptText = 'Check the video to review the overlay order.';
      }
    }
  }

  const overviewText = getProjectOverviewText({
    clipCount: nextClips.length,
    totalDuration: getTimelineDuration(nextState, 0),
    captionCount: nextCaptions.length,
    textOverlayCount: nextTextOverlays.length,
  });

  // No mutation detected — return an empty summary so the participant page's
  // hasSummaryText check drops the toast + TalkBack announcement.
  if (!actionText) {
    return {
      actionText: '',
      shortText: '',
      overviewText,
      promptText: '',
      announcement: '',
    };
  }

  return {
    actionText,
    shortText: `${actorLabel} ${actionText}`,
    overviewText,
    promptText,
    announcement: `${actorLabel} ${actionText}. ${promptText}`.trim(),
  };
}

export function summarizeVisualAdjustment(property, value, actorLabel = 'Collaborator') {
  const visualText = describeEditOp(property, { value });
  const actionText = `changed ${visualText.toLowerCase()}`;
  const promptText = 'Review the video frame to confirm the visual change.';

  return {
    actionText,
    shortText: `${actorLabel} ${actionText}`,
    overviewText: 'Visual adjustment applied to the video.',
    promptText,
    announcement: `${actorLabel} ${actionText}. ${promptText}`,
  };
}
