# Video-Clip Scene Descriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate each scene's level 1/2/3 descriptions from the actual per-scene video clip (frames + audio) via Gemini 2.5 Flash, replacing the single midpoint keyframe, with a keyframe fallback so it never regresses.

**Architecture:** During processing, `cutSegment` already writes the scene clip + keyframe; add a downscaled (480p, mono-audio) model-input clip. `processVideo` sends that clip to a new `describeScene`; on any failure or oversize it falls back to today's `describeKeyframe`. Suggestions/VQA and the thumbnail keyframe are untouched. (Spec: `docs/superpowers/specs/2026-06-16-video-clip-descriptions-design.md`.)

**Tech Stack:** Node 22, ffmpeg-static, `@google/generative-ai` (Gemini 2.5 Flash, native video input), Vitest. Server only — no web changes.

---

## File Structure

- `server/src/services/descriptions.js` — add `describeScene` + DRY `describeMedia`; keep `describeKeyframe`.
- `server/src/services/descriptions.test.js` — tests for `describeScene` + prompt wording.
- `server/src/services/segmentation.js` — add `buildModelClipArgs`; `cutSegment` returns `modelClipFile`.
- `server/src/services/segmentation.test.js` — tests for `buildModelClipArgs` + extend `cutSegment` integration test.
- `server/src/services/processVideo.js` — describe from the clip with keyframe fallback + `DESCRIBE_FROM_CLIP` flag + size guard.
- `server/src/services/processVideo.test.js` — clip path, fallback, flag-off.
- `server/src/prompts/_shared_style.txt` — flip "WHAT YOU CAN PERCEIVE" to video+audio.
- `server/src/prompts/description_generation.txt` — keyframe → clip wording.
- `server/scripts/diag-describe-clip.mjs` — optional live quality check.

All test commands run from the `server/` directory.

---

### Task 1: `describeScene` + DRY `describeMedia` refactor

**Files:**
- Modify: `server/src/services/descriptions.js:38-53` (the `describeKeyframe` block)
- Test: `server/src/services/descriptions.test.js`

- [ ] **Step 1: Write the failing test**

In `server/src/services/descriptions.test.js`, change the import to add `describeScene`:

```js
import {
  parseLevels,
  describeKeyframe,
  describeScene,
  answerQuestion,
  loadDescriptionPrompt,
} from './descriptions.js'
```

Add this block after the `describeKeyframe` describe block (after line ~78):

```js
describe('describeScene', () => {
  it('sends a video/mp4 inline part and returns parsed levels', async () => {
    const model = fakeModel([GOOD_JSON])
    const levels = await describeScene(model, 'PROMPT', { data: 'clipb64', mimeType: 'video/mp4' })
    expect(levels.level_1).toMatch(/hallway/)
    const parts = model.calls[0]
    expect(parts[0].inlineData).toMatchObject({ mimeType: 'video/mp4', data: 'clipb64' })
    expect(parts[1].text).toBe('PROMPT')
  })

  it('defaults the mime type to video/mp4', async () => {
    const model = fakeModel([GOOD_JSON])
    await describeScene(model, 'PROMPT', { data: 'clipb64' })
    expect(model.calls[0][0].inlineData.mimeType).toBe('video/mp4')
  })

  it('retries once with a JSON reminder on junk, then parses', async () => {
    const model = fakeModel(['not json at all', GOOD_JSON])
    const levels = await describeScene(model, 'PROMPT', { data: 'c' })
    expect(levels.level_3).toMatch(/Handheld/)
    expect(model.generateContent).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/descriptions.test.js`
Expected: FAIL — `describeScene is not a function` (or import error).

- [ ] **Step 3: Write minimal implementation**

In `server/src/services/descriptions.js`, replace the whole `describeKeyframe` function (lines 38-53) with:

```js
// Shared image/video → level_1/2/3 describer: one generateContent call with a
// single JSON-reminder retry if the model returns non-JSON.
async function describeMedia(model, promptTemplate, inlineData) {
  const parts = [{ inlineData }, { text: promptTemplate }]
  const first = await model.generateContent(parts)
  try {
    return parseLevels(first.response.text())
  } catch {
    const retry = await model.generateContent([
      ...parts,
      { text: '\n\nIMPORTANT: Return only valid JSON. No markdown, no explanation.' },
    ])
    return parseLevels(retry.response.text())
  }
}

export async function describeKeyframe(model, promptTemplate, jpegBase64) {
  return describeMedia(model, promptTemplate, { mimeType: 'image/jpeg', data: jpegBase64 })
}

// Describe a scene from its short video CLIP (frames + audio) — richer than one
// keyframe. Gemini 2.5 Flash samples video frames + the audio track natively.
export async function describeScene(model, promptTemplate, { data, mimeType = 'video/mp4' }) {
  return describeMedia(model, promptTemplate, { mimeType, data })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/descriptions.test.js`
Expected: PASS — all `describeScene` + existing `describeKeyframe` tests green (the refactor preserves `describeKeyframe`'s behaviour).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/descriptions.js server/src/services/descriptions.test.js
git commit -m "feat(server): describeScene (video clip) + DRY describeMedia"
```

---

### Task 2: `buildModelClipArgs` + `cutSegment` returns the model clip

**Files:**
- Modify: `server/src/services/segmentation.js` (add builder; update `cutSegment`)
- Test: `server/src/services/segmentation.test.js`

- [ ] **Step 1: Write the failing test**

In `server/src/services/segmentation.test.js`, add `buildModelClipArgs` to the import:

```js
import { planSegments, cutSegment, buildSegmentArgs, buildModelClipArgs } from './segmentation.js'
```

Add this describe block next to `buildSegmentArgs`:

```js
describe('buildModelClipArgs', () => {
  it('downscales to 480p, keeps an audio stream, caps threads, output last', () => {
    const [plan] = planSegments(10, 5)
    const args = buildModelClipArgs('/in.mp4', '/out/seg_001_model.mp4', plan)
    expect(args.join(' ')).toContain('scale=-2:480')
    expect(args).toContain('-c:a')          // audio kept...
    expect(args).not.toContain('-an')       // ...NOT stripped
    const i = args.indexOf('-threads')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(Number(args[i + 1])).toBeLessThanOrEqual(8)
    expect(args[args.length - 1]).toBe('/out/seg_001_model.mp4')
  })
})
```

Also extend the existing `cutSegment` integration test (`it('produces a playable segment file and a keyframe jpeg', ...)`) to assert the model clip — change its first line and add two assertions:

```js
    const { segFile, kfFile, modelClipFile } = await cutSegment(clipPath, workDir, plan)
    // ...existing seg + keyframe assertions stay...
    const modelStat = await fs.stat(modelClipFile)
    expect(modelStat.size).toBeGreaterThan(0)
    expect(modelClipFile.endsWith('seg_001_model.mp4')).toBe(true)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/segmentation.test.js`
Expected: FAIL — `buildModelClipArgs is not a function`, and `modelClipFile` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `server/src/services/segmentation.js`, add the builder after `buildKeyframeArgs`:

```js
// Downscaled (480p, mono-audio) copy of the scene used as the MODEL INPUT for
// descriptions. Gemini samples video ~1 fps so higher res buys nothing, and the
// small size keeps the inline request well under the 20 MB limit. Audio is kept
// (the point is motion + speech). Thread-capped like the other encodes.
export function buildModelClipArgs(sourceFile, clipFile, plan) {
  return [
    '-y', '-ss', String(plan.start_seconds), '-to', String(plan.end_seconds),
    '-i', sourceFile,
    '-vf', 'scale=-2:480',
    '-c:v', 'libx264', '-preset', 'fast', ...x264ThreadArgs(),
    '-c:a', 'aac', '-ac', '1',
    clipFile,
  ]
}
```

Replace the body of `cutSegment` with:

```js
export async function cutSegment(sourceFile, outDir, plan) {
  const segFile = path.join(outDir, `${plan.id}.mp4`)
  const kfFile = path.join(outDir, `${plan.id}_kf.jpg`)
  const modelClipFile = path.join(outDir, `${plan.id}_model.mp4`)

  await runFfmpeg(buildSegmentArgs(sourceFile, segFile, plan))
  await runFfmpeg(buildKeyframeArgs(sourceFile, kfFile, plan))
  await runFfmpeg(buildModelClipArgs(sourceFile, modelClipFile, plan))

  return { segFile, kfFile, modelClipFile }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/segmentation.test.js`
Expected: PASS (the integration test runs real ffmpeg and now also produces the 480p model clip).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/segmentation.js server/src/services/segmentation.test.js
git commit -m "feat(server): cut a downscaled audio-bearing model clip per scene"
```

---

### Task 3: Reword the prompts for video + audio

**Files:**
- Modify: `server/src/prompts/_shared_style.txt` (the "WHAT YOU CAN PERCEIVE" section)
- Modify: `server/src/prompts/description_generation.txt` (keyframe → clip)
- Test: `server/src/services/descriptions.test.js` (assert new wording)

- [ ] **Step 1: Confirm `_shared_style.txt` is description-only**

Run: `grep -rl "_shared_style" src/`
Expected: only `src/services/descriptions.js` references it (it is loaded by `loadDescriptionPrompt`, which feeds the description path only — VQA uses `vqa.txt`, suggestions use `suggestions.txt`). If anything else references it, stop and reconsider scoping.

- [ ] **Step 2: Write the failing test**

In `server/src/services/descriptions.test.js`, add to the `loadDescriptionPrompt` describe block:

```js
  it('frames the input as a video clip with audio (not a silent still)', async () => {
    const prompt = (await loadDescriptionPrompt()).toLowerCase()
    expect(prompt).toMatch(/video clip/)
    expect(prompt).toMatch(/audio/)
    expect(prompt).not.toMatch(/cannot hear audio/)
    expect(prompt).not.toMatch(/still keyframe/)
  })
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/services/descriptions.test.js -t "video clip with audio"`
Expected: FAIL — the current prompt says "still keyframe" and "cannot hear audio".

- [ ] **Step 4: Edit the prompt files**

In `server/src/prompts/_shared_style.txt`, replace the entire "WHAT YOU CAN PERCEIVE" section (from the `====` header line above `WHAT YOU CAN PERCEIVE` through the line ending `...when even that is uncertain.`) with:

```
================================================================
WHAT YOU CAN PERCEIVE
================================================================

You are given a short video clip (3 to 5 seconds) of one scene, WITH its
audio. Use BOTH what you see across the whole clip AND what you hear.

- Motion: describe how the scene changes over its few seconds — someone
  enters or leaves, an action begins and completes, the camera pans or
  shakes — not just one frozen moment.
- Audio: if there is clearly intelligible speech, convey the gist (a short
  paraphrase, or a brief verbatim quote of a distinctive phrase). Note
  notable non-speech sound when present (music, applause, traffic, singing).
  If the audio is silent, unclear, or absent, say nothing about sound rather
  than guessing — never invent speech, lyrics, or sounds.
- Accuracy still rules: if unsure what was said or shown, hedge ("appears
  to", "a phrase that sounds like") rather than committing to a confident
  wrong reading.
```

In `server/src/prompts/description_generation.txt`:

Replace lines 5-7:
```
You will be given a single keyframe from a short video segment (3 to 5
seconds long). Generate three descriptions of this segment at three
different levels of detail. Apply the style rules above.
```
with:
```
You will be given a short video clip (3 to 5 seconds long) of one scene,
with audio. Generate three descriptions of this segment at three different
levels of detail. Apply the style rules above.
```

Replace `Generate all three levels for the same keyframe.` with `Generate all three levels for the same clip.`

In the LEVEL 1 paragraph, replace `Who is present, what action is occurring, where it` with `Who is present, what action occurs across the clip, the gist of any clear speech, and where it`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/services/descriptions.test.js`
Expected: PASS (new wording test + existing `loadDescriptionPrompt` length test still pass).

- [ ] **Step 6: Commit**

```bash
git add server/src/prompts/_shared_style.txt server/src/prompts/description_generation.txt server/src/services/descriptions.test.js
git commit -m "feat(server): description prompt now reads a video clip with audio"
```

---

### Task 4: `processVideo` describes from the clip, falls back to keyframe

**Files:**
- Modify: `server/src/services/processVideo.js` (import, deps, the per-scene describe call)
- Test: `server/src/services/processVideo.test.js`

- [ ] **Step 1: Write the failing tests**

In `server/src/services/processVideo.test.js`, update `makeDeps` so `cut` also writes the model clip and add a `describeFromClip` dep:

```js
function makeDeps({ describeFails = false } = {}) {
  return {
    getMeta: vi.fn(async () => ({
      duration_seconds: 7, width: 320, height: 240, fps: 24, size_bytes: 1000,
    })),
    cut: vi.fn(async (_src, outDir, plan) => {
      const segFile = path.join(outDir, `${plan.id}.mp4`)
      const kfFile = path.join(outDir, `${plan.id}_kf.jpg`)
      const modelClipFile = path.join(outDir, `${plan.id}_model.mp4`)
      await fs.writeFile(segFile, 'seg-bytes')
      await fs.writeFile(kfFile, 'kf-bytes')
      await fs.writeFile(modelClipFile, 'model-clip-bytes')
      return { segFile, kfFile, modelClipFile }
    }),
    describe: vi.fn(async () => {
      if (describeFails) throw new Error('gemini_down')
      return { level_1: 'kf one', level_2: 'kf two', level_3: 'kf three' }
    }),
    describeFromClip: vi.fn(async () => {
      if (describeFails) throw new Error('clip_gemini_down')
      return { level_1: 'clip one', level_2: 'clip two', level_3: 'clip three' }
    }),
    loadPrompt: vi.fn(async () => 'PROMPT'),
  }
}
```

Add these tests inside `describe('processVideo', ...)`:

```js
  it('describes from the model clip (not the keyframe) on the happy path', async () => {
    const supabase = makeFakeSupabase()
    const deps = makeDeps()
    await processVideo({ supabase, model: {}, videoId: 'vid-1' }, deps)

    expect(deps.describeFromClip).toHaveBeenCalled()
    expect(deps.describe).not.toHaveBeenCalled()
    const [, , media] = deps.describeFromClip.mock.calls[0]
    expect(media).toMatchObject({ mimeType: 'video/mp4' })
    expect(typeof media.data).toBe('string') // base64 of the clip
    // descriptions came from the CLIP path
    expect(supabase.inserted.descriptions.some((d) => d.text === 'clip one')).toBe(true)
  })

  it('falls back to the keyframe when the clip describe throws (still ready)', async () => {
    const supabase = makeFakeSupabase()
    const deps = makeDeps()
    deps.describeFromClip = vi.fn(async () => { throw new Error('clip boom') })

    await processVideo({ supabase, model: {}, videoId: 'vid-1' }, deps)

    expect(deps.describe).toHaveBeenCalled() // keyframe fallback ran
    const statuses = supabase.updates.filter((u) => u.table === 'videos' && u.patch.status).map((u) => u.patch.status)
    expect(statuses[statuses.length - 1]).toBe('ready')
    expect(supabase.inserted.descriptions.some((d) => d.text === 'kf one')).toBe(true)
  })

  it('forces the keyframe path when DESCRIBE_FROM_CLIP=0', async () => {
    const prev = process.env.DESCRIBE_FROM_CLIP
    process.env.DESCRIBE_FROM_CLIP = '0'
    try {
      const supabase = makeFakeSupabase()
      const deps = makeDeps()
      await processVideo({ supabase, model: {}, videoId: 'vid-1' }, deps)
      expect(deps.describeFromClip).not.toHaveBeenCalled()
      expect(deps.describe).toHaveBeenCalled()
    } finally {
      if (prev === undefined) delete process.env.DESCRIBE_FROM_CLIP
      else process.env.DESCRIBE_FROM_CLIP = prev
    }
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/processVideo.test.js`
Expected: FAIL — `describeFromClip` is never called (processVideo still uses the keyframe `describe`).

- [ ] **Step 3: Write the implementation**

In `server/src/services/processVideo.js`, update the import to add `describeScene`:

```js
import { describeKeyframe, describeScene, loadDescriptionPrompt, DESCRIPTION_MODEL } from './descriptions.js'
```

Add these module-level constants near the top (after the imports):

```js
// base64 length guard — keep inline Gemini requests comfortably under the 20 MB
// cap; an oversize clip falls back to the keyframe. Set DESCRIBE_FROM_CLIP=0 to
// force the legacy keyframe path without a redeploy.
const MAX_CLIP_INLINE_B64 = 14 * 1024 * 1024

async function describeWithFallback({ describeFromClip, describe, model, prompt, modelClipFile, kfBytes, planId, log }) {
  const kfB64 = kfBytes.toString('base64')
  if (process.env.DESCRIBE_FROM_CLIP !== '0' && modelClipFile) {
    try {
      const clipB64 = (await fs.readFile(modelClipFile)).toString('base64')
      if (clipB64.length <= MAX_CLIP_INLINE_B64) {
        return await describeFromClip(model, prompt, { data: clipB64, mimeType: 'video/mp4' })
      }
      log(`clip ${planId} too large to send inline (${clipB64.length}b) — using keyframe`)
    } catch (err) {
      log(`clip describe failed for ${planId} (${String(err?.message ?? err)}) — using keyframe`)
    }
  }
  return describe(model, prompt, kfB64)
}
```

In the `processVideo` deps destructure, add `describeFromClip`:

```js
  const {
    getMeta = getVideoMeta,
    cut = cutSegment,
    describe = describeKeyframe,
    describeFromClip = describeScene,
    loadPrompt = loadDescriptionPrompt,
  } = deps
```

In the per-scene loop, change the `cut` destructure to capture the clip and replace the single `describe(...)` call:

```js
      const { segFile, kfFile, modelClipFile } = await cut(sourceFile, workDir, plan)
```

Replace:
```js
      const levels = await describe(model, prompt, kfBytes.toString('base64'))
```
with:
```js
      const levels = await describeWithFallback({
        describeFromClip, describe, model, prompt,
        modelClipFile, kfBytes, planId: plan.id, log,
      })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/processVideo.test.js`
Expected: PASS — clip path used on the happy path; keyframe fallback on clip failure and on `DESCRIBE_FROM_CLIP=0`; the existing "marks failed" test still fails as expected (both clip + keyframe throw on `describeFails`, so the error propagates).

- [ ] **Step 5: Run the full server suite**

Run: `npm test`
Expected: PASS — all server tests green.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/processVideo.js server/src/services/processVideo.test.js
git commit -m "feat(server): describe scenes from the clip with a keyframe fallback"
```

---

### Task 5 (optional): Live quality diag

**Files:**
- Create: `server/scripts/diag-describe-clip.mjs`

- [ ] **Step 1: Write the diag script**

```js
// Manual quality check: build a 480p model clip from a sample video and print
// the clip-based description. Requires GEMINI_API_KEY.
// Usage: node --env-file=.env scripts/diag-describe-clip.mjs <path-to-video.mp4>
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { makeGeminiModel, loadDescriptionPrompt, describeScene, describeKeyframe } from '../src/services/descriptions.js'
import { buildModelClipArgs, buildKeyframeArgs, planSegments } from '../src/services/segmentation.js'

const exec = promisify(execFile)
const src = process.argv[2]
if (!src) { console.error('usage: diag-describe-clip.mjs <video.mp4>'); process.exit(1) }

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diag-clip-'))
const plan = planSegments(5, 5)[0] // first ~5s scene
const clip = path.join(dir, 'm.mp4')
const kf = path.join(dir, 'k.jpg')
await exec(ffmpegPath, buildModelClipArgs(src, clip, plan))
await exec(ffmpegPath, buildKeyframeArgs(src, kf, plan))

const model = makeGeminiModel()
const prompt = await loadDescriptionPrompt()
const clipB64 = (await fs.readFile(clip)).toString('base64')
const kfB64 = (await fs.readFile(kf)).toString('base64')

console.log('=== FROM CLIP (frames + audio) ===')
console.log(JSON.stringify(await describeScene(model, prompt, { data: clipB64 }), null, 2))
console.log('\n=== FROM KEYFRAME (today) ===')
console.log(JSON.stringify(await describeKeyframe(model, prompt, kfB64), null, 2))

await fs.rm(dir, { recursive: true, force: true })
```

- [ ] **Step 2: Run it on a real audio-bearing clip (manual)**

Run: `node --env-file=.env scripts/diag-describe-clip.mjs <some-video.mp4>`
Expected: the CLIP description mentions motion and/or spoken content that the KEYFRAME description omits. (Eyeball the difference — this is the quality gate, not an assertion.)

- [ ] **Step 3: Commit**

```bash
git add server/scripts/diag-describe-clip.mjs
git commit -m "chore(server): live diag comparing clip vs keyframe descriptions"
```

---

## Self-Review

**Spec coverage:**
- Descriptions from the clip → Task 1 (`describeScene`) + Task 4 (wired with fallback). ✓
- Downscaled 480p audio-bearing model clip → Task 2 (`buildModelClipArgs`). ✓
- Keyframe fallback on failure/oversize → Task 4 (`describeWithFallback`, `MAX_CLIP_INLINE_B64`). ✓
- Prompt reworded for video + audio → Task 3. ✓
- Env revert switch (`DESCRIBE_FROM_CLIP`) → Task 4. ✓
- Suggestions/VQA unchanged → no task touches `suggestions.js` or `answerQuestion`. ✓
- Testing (describeScene, processVideo fallback, buildModelClipArgs, live diag) → Tasks 1,2,4,5. ✓

**Type/name consistency:** `describeScene(model, prompt, { data, mimeType })`, `describeFromClip` dep, `modelClipFile`, `buildModelClipArgs`, `describeWithFallback`, `MAX_CLIP_INLINE_B64`, `DESCRIBE_FROM_CLIP` — used identically across Tasks 1, 2, 4. `cutSegment` returns `{ segFile, kfFile, modelClipFile }` in Task 2 and is destructured to match in Task 4. ✓

**Placeholders:** none — every step has concrete code/commands.
