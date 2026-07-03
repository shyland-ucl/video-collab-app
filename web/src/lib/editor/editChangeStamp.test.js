/**
 * Characterization tests for buildEditChangeSceneStamp — the single util that
 * resolves the edited-scene id and the "what changed" text TOGETHER from a
 * before/after edit-state diff.
 *
 * These assert the ACTUAL return shape against realistic states produced by
 * the real sceneEditOps (split / delete / addCaption), so the stamp is pinned
 * to the originating scene id the rendered list still holds (root segment for
 * splits; the captioned scene for captions).
 */
import { describe, it, expect } from 'vitest';
import { buildEditChangeSceneStamp } from './editChangeStamp';
import { splitClip, deleteClip, addCaption, setClipMuted, setClipVolume } from './sceneEditOps';

function clip(id, startTime, endTime) {
  return { id, name: id, startTime, endTime, trimStart: 0, trimEnd: 0 };
}

function baseState() {
  return {
    clips: [clip('seg1', 0, 10), clip('seg2', 10, 20), clip('seg3', 20, 30)],
    captions: [],
    sources: [],
    textOverlays: [],
  };
}

describe('buildEditChangeSceneStamp', () => {
  it('returns null when either state is missing', () => {
    expect(buildEditChangeSceneStamp(null, baseState())).toBeNull();
    expect(buildEditChangeSceneStamp(baseState(), null)).toBeNull();
  });

  it('split: stamps the originating ROOT segment id (not the new -split- piece) with "Split scene"', () => {
    const prev = baseState();
    const next = splitClip(prev, 'seg2', 15);
    // sanity: the split produced a new clip whose id derives from seg2
    expect(next.clips.length).toBe(prev.clips.length + 1);
    const added = next.clips.find((c) => !prev.clips.some((p) => p.id === c.id));
    expect(added.id).toMatch(/^seg2-split-/);

    const stamp = buildEditChangeSceneStamp(prev, next, { fallbackSceneId: 'seg2' });
    expect(stamp).toEqual({ sceneId: 'seg2', text: 'Split scene' });
  });

  it('delete: stamps the DELETED scene id with "Removed from edit"', () => {
    const prev = baseState();
    const next = deleteClip(prev, 'seg2');
    expect(next.clips.some((c) => c.id === 'seg2')).toBe(false);

    const stamp = buildEditChangeSceneStamp(prev, next, { fallbackSceneId: 'seg1' });
    expect(stamp).toEqual({ sceneId: 'seg2', text: 'Removed from edit' });
  });

  it('caption: stamps the captioned scene id with "Caption added: <text>"', () => {
    const prev = baseState();
    const next = addCaption(prev, 'seg3', 'Hello world');
    expect(next.captions.length).toBe(1);

    const stamp = buildEditChangeSceneStamp(prev, next, { fallbackSceneId: 'seg1' });
    expect(stamp).toEqual({ sceneId: 'seg3', text: 'Caption added: Hello world' });
  });

  it('caption on a split piece: stamps the ROOT segment id', () => {
    const prev = baseState();
    const split = splitClip(prev, 'seg2', 15);
    const splitPieceId = split.clips.find((c) => c.id !== 'seg2' && /^seg2-split-/.test(c.id)).id;
    const next = addCaption(split, splitPieceId, 'On the second half');

    const stamp = buildEditChangeSceneStamp(split, next, { fallbackSceneId: 'seg1' });
    expect(stamp).toEqual({ sceneId: 'seg2', text: 'Caption added: On the second half' });
  });

  it('no recognised change returns null', () => {
    const prev = baseState();
    const next = baseState();
    expect(buildEditChangeSceneStamp(prev, next, { fallbackSceneId: 'seg1' })).toBeNull();
  });

  it('colour: stamps the graded scene (root segment id) with the property + value', () => {
    const prev = { ...baseState(), colour: {} };
    const next = { ...baseState(), colour: { seg2: { brightness: 15 } } };
    const stamp = buildEditChangeSceneStamp(prev, next, { fallbackSceneId: 'seg1' });
    expect(stamp).toEqual({ sceneId: 'seg2', text: 'Brightness +15' });
  });

  it('colour: a multi-property grade stamps a generic "Colour adjusted"', () => {
    const prev = { ...baseState(), colour: {} };
    const next = { ...baseState(), colour: { seg3: { brightness: 10, zoom: 130 } } };
    const stamp = buildEditChangeSceneStamp(prev, next, { fallbackSceneId: 'seg1' });
    expect(stamp).toEqual({ sceneId: 'seg3', text: 'Colour adjusted' });
  });

  it('colour: a clip/caption change still wins over a colour change', () => {
    const prev = { ...baseState(), colour: {} };
    // delete seg2 AND grade seg3 in the same diff — the clip change is stamped.
    const withColour = { ...baseState(), colour: { seg3: { zoom: 120 } } };
    const next = deleteClip(withColour, 'seg2');
    const stamp = buildEditChangeSceneStamp(prev, next, { fallbackSceneId: 'seg1' });
    expect(stamp).toEqual({ sceneId: 'seg2', text: 'Removed from edit' });
  });

  it('mute: stamps the muted scene with "Original audio muted"', () => {
    const prev = baseState();
    const next = setClipMuted(prev, 'seg2', true);
    const stamp = buildEditChangeSceneStamp(prev, next, { fallbackSceneId: 'seg1' });
    expect(stamp).toEqual({ sceneId: 'seg2', text: 'Original audio muted' });
  });

  it('unmute: stamps the scene with "Original audio unmuted"', () => {
    const muted = setClipMuted(baseState(), 'seg2', true);
    const next = setClipMuted(muted, 'seg2', false);
    const stamp = buildEditChangeSceneStamp(muted, next, { fallbackSceneId: 'seg1' });
    expect(stamp).toEqual({ sceneId: 'seg2', text: 'Original audio unmuted' });
  });

  it('mute on a split piece: stamps the ROOT segment id', () => {
    const split = splitClip(baseState(), 'seg2', 15);
    const splitPieceId = split.clips.find((c) => c.id !== 'seg2' && /^seg2-split-/.test(c.id)).id;
    const next = setClipMuted(split, splitPieceId, true);
    const stamp = buildEditChangeSceneStamp(split, next, { fallbackSceneId: 'seg1' });
    expect(stamp).toEqual({ sceneId: 'seg2', text: 'Original audio muted' });
  });

  it('volume: stamps the scene with "Volume <n>%"', () => {
    const prev = baseState();
    const next = setClipVolume(prev, 'seg2', 80);
    const stamp = buildEditChangeSceneStamp(prev, next, { fallbackSceneId: 'seg1' });
    expect(stamp).toEqual({ sceneId: 'seg2', text: 'Volume 80%' });
  });

  it('volume to 0: stamps "Muted"', () => {
    const prev = baseState();
    const next = setClipVolume(prev, 'seg2', 0);
    const stamp = buildEditChangeSceneStamp(prev, next, { fallbackSceneId: 'seg1' });
    expect(stamp).toEqual({ sceneId: 'seg2', text: 'Muted' });
  });

  it('rotate: stamps the graded scene with "Rotation <n>°"', () => {
    const prev = { ...baseState(), colour: {} };
    const next = { ...baseState(), colour: { seg2: { rotate: 90 } } };
    const stamp = buildEditChangeSceneStamp(prev, next, { fallbackSceneId: 'seg1' });
    expect(stamp).toEqual({ sceneId: 'seg2', text: 'Rotation 90°' });
  });
});
