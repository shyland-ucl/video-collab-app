// Ported verbatim from video-collab-probe/src/utils/descriptionAddenda.js
// (Phase 2a Task 1). This is a pure text util with no study-only imports, so
// nothing was stripped. It builds the "what's on screen now" sentences
// (captions / text overlays / visual-grade summary) appended to a scene's
// description at detail level >= 2. SceneBlockList feeds it `editState`
// (this app's `state` — captions/textOverlays) and `editSummary`
// (the per-scene `editedScenes[id]` entry).

function clipBaseSceneId(id) {
  if (typeof id !== 'string') return id;
  const idx = id.lastIndexOf('-split-');
  return idx >= 0 ? id.slice(0, idx) : id;
}

function sameSceneId(a, b) {
  if (!a || !b) return false;
  return clipBaseSceneId(a) === clipBaseSceneId(b);
}

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function quotedList(items) {
  const cleaned = items.map(cleanText).filter(Boolean);
  if (cleaned.length === 0) return '';
  const quoted = cleaned.map((item) => `"${item}"`);
  if (quoted.length === 1) return quoted[0];
  if (quoted.length === 2) return `${quoted[0]} and ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(', ')}, and ${quoted[quoted.length - 1]}`;
}

function captionMatchesScene(caption, scene) {
  if (!caption || !scene) return false;
  if (caption.sceneId) return sameSceneId(caption.sceneId, scene.id);
  const captionStart = Number(caption.startTime);
  const captionEnd = Number(caption.endTime);
  if (!Number.isFinite(captionStart) || !Number.isFinite(captionEnd)) return false;
  return captionStart < scene.end_time && captionEnd > scene.start_time;
}

function overlayMatchesScene(overlay, scene) {
  if (!overlay?.sceneId) return true;
  return sameSceneId(overlay.sceneId, scene?.id);
}

function overlayPosition(overlay) {
  const x = Number(overlay?.x);
  const y = Number(overlay?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return '';
  const vertical = y < 35 ? 'top' : y > 65 ? 'bottom' : 'middle';
  const horizontal = x < 35 ? 'left' : x > 65 ? 'right' : 'center';
  if (vertical === 'middle' && horizontal === 'center') return ' near the center';
  return ` near the ${vertical} ${horizontal}`;
}

function visualSummarySentence(editSummary) {
  const text = cleanText(editSummary?.text);
  if (!text) return '';
  const lower = text.toLowerCase();
  if (!/(brightness|contrast|saturation|zoom|rotat|visual)/.test(lower)) return '';
  return `The scene has been visually adjusted: ${lower}.`;
}

export function buildSceneDescriptionAddendum({
  scene,
  currentLevel,
  editState,
  editSummary,
} = {}) {
  if (!scene || currentLevel < 2) return '';

  const sentences = [];
  const captions = (editState?.captions || [])
    .filter((caption) => captionMatchesScene(caption, scene))
    .map((caption) => caption.text);
  const captionText = quotedList([...new Set(captions.map(cleanText).filter(Boolean))]);
  if (captionText) {
    sentences.push(`A caption reading ${captionText} is showing in this scene.`);
  }

  const overlays = (editState?.textOverlays || [])
    .filter((overlay) => overlayMatchesScene(overlay, scene))
    .filter((overlay) => cleanText(overlay.content));
  if (overlays.length === 1) {
    const overlay = overlays[0];
    sentences.push(`A text overlay reading "${cleanText(overlay.content)}" is shown${overlayPosition(overlay)} in this scene.`);
  } else if (overlays.length > 1) {
    sentences.push(`Text overlays reading ${quotedList(overlays.map((overlay) => overlay.content))} are shown in this scene.`);
  }

  const visualSentence = visualSummarySentence(editSummary);
  if (visualSentence) sentences.push(visualSentence);

  return sentences.join(' ');
}
