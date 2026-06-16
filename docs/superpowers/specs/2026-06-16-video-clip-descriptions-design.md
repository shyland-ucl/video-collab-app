# Scene descriptions from the video clip (not a single keyframe)

**Date:** 2026-06-16
**Status:** Design — approved, pending implementation plan

## Problem

Scene descriptions, AI suggestions, and VQA all derive from **one keyframe** per
scene — a single JPEG extracted at the scene midpoint
(`segmentation.js` → `buildKeyframeArgs`, `-ss midpoint -frames:v 1`). A single
still misses, by the creators' own account, four things at once:

- **Motion / action** unfolding over the ~5s scene (movement, an activity, a camera pan).
- **Spoken audio** — narration, dialogue, sound. The frame is silent.
- **The most-informative moment** — the midpoint can be blurry or transitional.
- **Multiple shots / subjects** that appear at different times in the scene.

For a blind/low-vision creator whose entire understanding of their own footage
comes from these descriptions, this is a core-value limitation.

## Goal

Generate each scene's description from the **actual scene video clip** (frames +
audio + full timespan) using Gemini 2.5 Flash's native video understanding.
Suggestions improve indirectly via the richer descriptions. VQA and the keyframe
thumbnail are unchanged. The change must **never regress** below today's
keyframe-quality behaviour.

## Approach (chosen: A — native video clip)

Gemini 2.5 Flash natively samples video frames (~1 fps) **and** the audio track.
The processing pipeline already cuts each scene to `seg_NNN.mp4` on disk
(`processVideo` → `cutSegment`), so the clip is available at description time
with **no extra download**. We send a small (downscaled) copy of that clip to the
model instead of the keyframe.

Considered and rejected:
- **B — several frames + an audio transcript:** captures motion + speech but adds
  a transcription step and misses between-frame motion / audio tone.
- **C — multiple frames only:** no audio, leaving one of the four gaps unsolved.

## Scope

**In scope**
- Descriptions generated from the per-scene clip (with audio) instead of the keyframe.
- A downscaled (~480p, audio-bearing) model-input clip produced during segmentation.
- Keyframe fallback when the video call fails or the clip exceeds the inline size guard.
- Reword `description_generation.txt` for "short video clip with audio" (same JSON contract).

**Out of scope (explicit)**
- Suggestions sending clips at analyse-time. `proposeSuggestions` already consumes
  the level 1/2/3 text (now video-derived and far richer) + the per-scene keyframes,
  so it improves with **no clip downloads**. Mechanism unchanged.
- VQA ("ask AI about this scene") — real-time interaction; downloading + sending
  video would add latency. Stays on the keyframe. Easy to revisit later.
- The keyframe thumbnail — still extracted for the library/editor display.

## Architecture & data flow

`processVideo`, per scene (today's steps in plain text, **NEW** marked):

1. `cutSegment` produces `segFile` (full-res scene clip) + `kfFile` (keyframe). *(today)*
2. **NEW** produce a downscaled model-input clip (`modelClipFile`, ~480p, same
   start/end window, **audio kept**). Predictable small size → reliable inline send.
3. **NEW** `describeScene(model, prompt, { data: clipBase64, mimeType: 'video/mp4' })`
   → `{ level_1, level_2, level_3 }`.
   - On throw **or** clip over the size guard → `describeKeyframe(model, prompt, kfBase64)`
     (today's exact path).
4. Upload segment + keyframe; insert descriptions. *(today, unchanged)*

Suggestions path is untouched: `proposeSuggestions(model, scenes, keyframesBase64)`
benefits from the richer `level_*` text already passed in `buildScenesBlock`.

## Components & interfaces

- **`segmentation.js`**
  - `buildKeyframeArgs` — unchanged (thumbnail).
  - **NEW** `buildModelClipArgs(sourceFile, clipFile, plan)` → ffmpeg args:
    `-ss start -to end -i src -vf scale=-2:480 -c:v libx264 -preset fast
    <x264ThreadArgs()> -c:a aac -ac 1 modelClipFile` (480p, mono audio, thread-capped
    via the existing OOM fix). Downscale keeps inline size + cost predictable;
    Gemini samples ~1 fps so higher res buys nothing.
  - `cutSegment` returns `{ segFile, kfFile, modelClipFile }` (or `processVideo`
    calls a small new helper) — injectable for tests.
- **`descriptions.js`**
  - **NEW** `describeScene(model, promptTemplate, { data, mimeType = 'video/mp4' })`
    — sends `{ inlineData: { mimeType, data } }` + the prompt; reuses `parseLevels`
    + the existing one-retry-on-bad-JSON logic.
  - `describeKeyframe` stays (VQA + fallback).
  - `DESCRIPTION_MODEL` unchanged — `gemini-2.5-flash` supports video input.
- **`processVideo.js`**
  - Read `modelClipFile` bytes; call `describeScene`; on throw/oversize fall back to
    `describeKeyframe(kfBytes)`. `describe` stays injectable via `deps` (testability).
- **`prompts/description_generation.txt`**
  - Reword "image/frame" → "a short video clip (with audio) of one scene"; instruct
    the model to use motion **and** spoken content. **Keep the `level_1/2/3` JSON
    contract identical** (consumers + `parseLevels` unchanged).

## Size / cost / latency

- 480p, mono, ≤ segment length (~5s) ⇒ ~0.3–1.5 MB ⇒ base64 fits well under the
  ~20 MB inline-request cap.
- **Size guard:** if `clipBase64.length` > ~14 MB, skip video → keyframe fallback.
  (No File API needed for short 480p clips — keeps it simple.)
- Flash video ≈ a few hundred–thousand tokens/scene — cheap. Latency +~1–3 s/scene,
  **background processing only** (no user blocked).
- One extra thread-capped encode per scene; bounded by `FFMPEG_THREADS`.

## Error handling (never regress)

- `describeScene` throws (model error, JSON-parse-after-retry, or oversize) →
  `processVideo` catches and calls `describeKeyframe`. A description is **always**
  produced — at worst at today's keyframe quality.
- Existing per-step failure handling (`status='failed'` + `formatExecError`) is unchanged.

## Rollout / revert

- Safe by construction (keyframe fallback), so no flag is strictly required.
- Optional env switch `DESCRIBE_FROM_CLIP` (default on) to force the old keyframe
  path instantly without a redeploy if a problem surfaces in the study.

## Testing

- **`descriptions.test`**: `describeScene` sends a `video/mp4` inlineData part +
  parses `level_1/2/3`; retry path on bad JSON.
- **`processVideo.test`**: the model clip is passed to `describe`; when the video
  describe **throws**, the keyframe fallback runs and processing still reaches
  `ready` with all three levels.
- **`segmentation.test`**: `buildModelClipArgs` scales to 480p, keeps an audio
  stream, caps threads, output last.
- **Live diag** (`scripts/`): run one real audio-bearing clip through `describeScene`
  and eyeball that motion/spoken content appears in the description vs the keyframe
  version (quality gate).

## Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Unexpectedly large clip | Size guard + keyframe fallback |
| Model ignores audio | Prompt explicitly asks for spoken content |
| Extra encode slows processing | Short 480p clip, thread-capped; background job |
| Model/SDK video-input quirk | Fallback path keeps output at today's quality |
