# Visual Edits in "Ask AI to Edit" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let "Ask AI to Edit" propose the editor's visual/audio fixes (brightness, contrast, saturation, zoom, rotate, mute, unmute) with an AI-chosen, range-validated value — reusing the existing suggestions "fix" machinery — on top of the current 7 structural ops.

**Architecture:** Extract the shared value-range validator into `fixActions.js` (used by both suggestions and ai-edit). The server ai-edit allow-list + prompt + validation gain the visual ops with a `params.value`. The client AI-edit confirm path routes visual ops through the existing `fixTemplateToOpFn` (apply) and `describeFixTemplate` (deterministic confirm sentence) — the same helpers suggestions already use. Confirm-first flow unchanged.

**Tech Stack:** Node 22, Express, Vitest (server); React + Vitest/RTL (web). Gemini for the AI-edit proposal (mocked in tests). Spec: `docs/superpowers/specs/2026-06-16-visual-ai-edit-design.md`.

---

## File Structure

- **Create** `server/src/services/fixActions.js` — shared, pure: `AI_FIXABLE_ACTIONS`, `FIX_VALUE_RANGES`, `inRangeValue(action, value)`.
- **Create** `server/src/services/fixActions.test.js` — unit tests for the validator.
- **Modify** `server/src/services/suggestions.js` — import from `fixActions`, re-export `AI_FIXABLE_ACTIONS`, refactor `cleanFixTemplate` to use `inRangeValue` (behaviour identical).
- **Modify** `server/src/services/aiEdit.js` — extend `AI_EDIT_OPS`; validate visual `params.value`; whitelist `value` on output.
- **Modify** `server/src/services/aiEdit.test.js` — visual validation tests.
- **Modify** `server/src/prompts/ai_edit.txt` — offer the visual ops with ranges; drop the colour/audio redirect.
- **Modify** `web/src/components/editor/ConfirmAiEditDialog.jsx` — route visual ops through `fixTemplateToOpFn` / `describeFixTemplate`.
- **Modify** `web/src/components/editor/ConfirmAiEditDialog.test.jsx` — visual routing tests.

Server test commands run from `server/`; web from `web/`.

---

### Task 1: Extract the shared fix-action validator

**Files:**
- Create: `server/src/services/fixActions.js`
- Create: `server/src/services/fixActions.test.js`
- Modify: `server/src/services/suggestions.js` (lines 11, 20-25, 29-40 region)

- [ ] **Step 1: Write the failing test**

Create `server/src/services/fixActions.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { AI_FIXABLE_ACTIONS, FIX_VALUE_RANGES, inRangeValue } from './fixActions.js'

describe('fixActions', () => {
  it('lists the fixable actions', () => {
    expect(AI_FIXABLE_ACTIONS).toEqual(['brightness', 'contrast', 'saturation', 'zoom', 'rotate', 'mute', 'unmute'])
  })

  it('defines numeric ranges for the colour/geometry ops only', () => {
    expect(FIX_VALUE_RANGES.brightness).toEqual([-100, 100])
    expect(FIX_VALUE_RANGES.zoom).toEqual([100, 250])
    expect(FIX_VALUE_RANGES.rotate).toEqual([-180, 180])
    expect(FIX_VALUE_RANGES.mute).toBeUndefined()
  })

  it('inRangeValue accepts in-range finite numbers, rejects the rest', () => {
    expect(inRangeValue('brightness', 30)).toBe(true)
    expect(inRangeValue('brightness', -100)).toBe(true)
    expect(inRangeValue('brightness', 101)).toBe(false)
    expect(inRangeValue('zoom', 99)).toBe(false)
    expect(inRangeValue('rotate', 90)).toBe(true)
    expect(inRangeValue('brightness', NaN)).toBe(false)
    expect(inRangeValue('brightness', '30')).toBe(false)
    expect(inRangeValue('mute', 1)).toBe(false) // not a numeric op
    expect(inRangeValue('nope', 1)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/services/fixActions.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `fixActions.js`**

```js
// Shared definition of the AI-fixable visual/audio actions and their numeric
// ranges. Used by BOTH the suggestions "fix_template" path and "Ask AI to Edit",
// so the two features validate values identically.
export const AI_FIXABLE_ACTIONS = ['brightness', 'contrast', 'saturation', 'zoom', 'rotate', 'mute', 'unmute']

// Numeric ranges for the colour/geometry ops (mute/unmute carry no value).
// Mirrors the editor's slider bounds.
export const FIX_VALUE_RANGES = {
  brightness: [-100, 100],
  contrast: [-100, 100],
  saturation: [-100, 100],
  zoom: [100, 250],
  rotate: [-180, 180],
}

// True iff `value` is a finite number within the range for a numeric op.
// Returns false for mute/unmute (no range) and unknown actions.
export function inRangeValue(action, value) {
  const r = FIX_VALUE_RANGES[action]
  return Boolean(r) && typeof value === 'number' && Number.isFinite(value) && value >= r[0] && value <= r[1]
}
```

- [ ] **Step 4: Refactor `suggestions.js` to use it (behaviour identical)**

In `server/src/services/suggestions.js`:

Replace line 11:
```js
export const AI_FIXABLE_ACTIONS = ['brightness', 'contrast', 'saturation', 'zoom', 'rotate', 'mute', 'unmute']
```
with an import at the top of the file (just below the existing imports) and a re-export to preserve the public API:
```js
import { AI_FIXABLE_ACTIONS, inRangeValue } from './fixActions.js'
export { AI_FIXABLE_ACTIONS }
```

Delete the now-duplicated `FIX_VALUE_RANGES` declaration (the `// Same numeric bounds...` comment + `const FIX_VALUE_RANGES = {...}` line) and the `inRange` helper:
```js
// Same numeric bounds the editor's colour/zoom/rotate ops accept.
const FIX_VALUE_RANGES = { brightness: [-100, 100], contrast: [-100, 100], saturation: [-100, 100], zoom: [100, 250], rotate: [-180, 180] }

function inRange(n, [lo, hi]) {
  return typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi
}
```

In `cleanFixTemplate`, change the numeric-range branch from `inRange(fix.value, FIX_VALUE_RANGES[action])` to `inRangeValue(action, fix.value)`:
```js
  else { if (!inRangeValue(action, fix.value)) return null; value = fix.value }
```
Leave the rest of `cleanFixTemplate` (mute/unmute checks, the label requirement) and `PROTOTYPE_ACTIONS` (which spreads the now-imported `AI_FIXABLE_ACTIONS`) unchanged.

- [ ] **Step 5: Run tests**

Run: `cd server && npx vitest run src/services/fixActions.test.js src/services/suggestions.test.js`
Expected: PASS — new `fixActions` tests green AND the existing `suggestions.test.js` unchanged-and-green (proves the refactor preserved `cleanFixTemplate`).

- [ ] **Step 6: Commit**

```bash
git add server/src/services/fixActions.js server/src/services/fixActions.test.js server/src/services/suggestions.js
git commit -m "refactor(server): extract shared fixActions validator (suggestions + ai-edit)"
```

---

### Task 2: Server allow-list + value validation for visual ops

**Files:**
- Modify: `server/src/services/aiEdit.js` (lines 7, 19-31, 58-63)
- Modify: `server/src/services/aiEdit.test.js`

- [ ] **Step 1: Write the failing tests**

In `server/src/services/aiEdit.test.js`, add (import `validateProposal` and `proposeEdit` if not already imported at the top — they are exported from `./aiEdit.js`):
```js
describe('validateProposal — visual ops', () => {
  const ids = new Set(['c1'])

  it('accepts an in-range numeric visual op', () => {
    expect(validateProposal({ op: 'brightness', target_clip_id: 'c1', params: { value: 30 }, summary: 'brighten' }, ids))
      .toEqual({ ok: true, kind: 'proposal' })
  })

  it('rejects an out-of-range value', () => {
    expect(validateProposal({ op: 'brightness', target_clip_id: 'c1', params: { value: 500 }, summary: 'x' }, ids))
      .toEqual({ ok: false, reason: 'bad_value' })
  })

  it('rejects a missing value on a numeric op', () => {
    expect(validateProposal({ op: 'zoom', target_clip_id: 'c1', params: {}, summary: 'x' }, ids))
      .toEqual({ ok: false, reason: 'bad_value' })
  })

  it('accepts mute/unmute with no value', () => {
    expect(validateProposal({ op: 'mute', target_clip_id: 'c1', params: {}, summary: 'silence it' }, ids))
      .toEqual({ ok: true, kind: 'proposal' })
  })
})

describe('proposeEdit — visual output whitelist', () => {
  it('forwards a clamped-in-range value for numeric ops, {} for mute', async () => {
    const clips = [{ id: 'c1', name: 'Scene 1', duration_seconds: 5 }]
    const brightnessModel = { generateContent: async () => ({ response: { text: () => JSON.stringify({ op: 'brightness', target_clip_id: 'c1', params: { value: 30, sneaky: 'x' }, summary: 'brighten Scene 1' }) } }) }
    const out = await proposeEdit(brightnessModel, 'brighten scene 1', clips, {})
    expect(out).toEqual({ op: 'brightness', target_clip_id: 'c1', params: { value: 30 }, summary: 'brighten Scene 1' })

    const muteModel = { generateContent: async () => ({ response: { text: () => JSON.stringify({ op: 'mute', target_clip_id: 'c1', params: {}, summary: 'mute Scene 1' }) } }) }
    const muteOut = await proposeEdit(muteModel, 'mute scene 1', clips, {})
    expect(muteOut).toEqual({ op: 'mute', target_clip_id: 'c1', params: {}, summary: 'mute Scene 1' })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/services/aiEdit.test.js`
Expected: FAIL — `brightness`/`mute` rejected as `unknown_op`; value not whitelisted.

- [ ] **Step 3: Implement**

In `server/src/services/aiEdit.js`:

Add an import at the top (below the existing `node:` imports):
```js
import { AI_FIXABLE_ACTIONS, inRangeValue } from './fixActions.js'
```

Replace the `AI_EDIT_OPS` line and add a numeric-op set just after it:
```js
const STRUCTURAL_OPS = ['delete', 'split', 'move_earlier', 'move_later', 'add_caption', 'trim_start', 'trim_end']
export const AI_EDIT_OPS = [...STRUCTURAL_OPS, ...AI_FIXABLE_ACTIONS]
const NUMERIC_VISUAL_OPS = ['brightness', 'contrast', 'saturation', 'zoom', 'rotate']
```

In `validateProposal`, add the value check after the `add_caption` check (before the final `return { ok: true, kind: 'proposal' }`):
```js
  if (NUMERIC_VISUAL_OPS.includes(proposal.op) && !inRangeValue(proposal.op, params.value)) {
    return { ok: false, reason: 'bad_value' }
  }
```

In `proposeEdit`, replace the `params:` line of the returned object so numeric ops forward the validated value:
```js
    params:
      proposal.op === 'add_caption'
        ? { caption_text: String(proposal.params.caption_text).slice(0, 500) }
        : NUMERIC_VISUAL_OPS.includes(proposal.op)
          ? { value: proposal.params.value }
          : {},
```
(`proposal.params.value` is already validated finite + in-range by `validateProposal`, so it is safe to forward directly. mute/unmute fall through to `{}`.)

- [ ] **Step 4: Run tests**

Run: `cd server && npx vitest run src/services/aiEdit.test.js`
Expected: PASS — visual validation + whitelist tests green; existing structural tests still green.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/aiEdit.js server/src/services/aiEdit.test.js
git commit -m "feat(server): ai-edit validates + proposes visual ops (value-range checked)"
```

---

### Task 3: Reword the ai-edit prompt to offer the visual ops

**Files:**
- Modify: `server/src/prompts/ai_edit.txt`

(No unit test — this is prompt data; behaviour is covered by Task 2's validation tests and the existing route test. Run the suite after editing.)

- [ ] **Step 1: Edit the prompt**

In `server/src/prompts/ai_edit.txt`, replace the "Allowed operations:" block (lines 5-10) with:
```
Allowed operations:
- delete: remove a scene
- split: cut a scene into two at its midpoint
- move_earlier / move_later: swap a scene with its neighbour
- add_caption: attach caption text to a scene (params.caption_text required)
- trim_start / trim_end: trim half a second off a scene's start or end
- brightness / contrast / saturation: adjust the look; params.value from -100 to 100 (0 = no change, negative = less, positive = more)
- zoom: crop in; params.value from 100 (none) to 250 (maximum)
- rotate: rotate the scene; params.value from -180 to 180 degrees (e.g. 90 to fix a sideways clip)
- mute / unmute: silence or restore the scene's original audio (no params)
```

Replace the success-shape rule and the out-of-scope rule (lines 14 and 18) so they read:
```
- Success shape: {"op": "...", "target_clip_id": "...", "params": {...}, "summary": "..."}. For brightness/contrast/saturation/zoom/rotate, params MUST be {"value": <number in range>}; for add_caption, {"caption_text": "..."}; for all others, {}.
```
and
```
- If the request asks for something outside the allowed operations (transitions, on-screen graphics beyond a caption, speed changes, or audio mixing beyond mute), respond with a clarification saying the helper can do that.
```
Keep the remaining rules (JSON-only, summary-naming-the-scene, target_clip_id must be a listed id, clarify-if-ambiguous) unchanged.

- [ ] **Step 2: Run the full server suite**

Run: `cd server && npm test`
Expected: PASS — nothing regresses (the route test and Task 2 validation cover the behaviour).

- [ ] **Step 3: Commit**

```bash
git add server/src/prompts/ai_edit.txt
git commit -m "feat(server): ai-edit prompt offers colour/zoom/rotate/mute with a value"
```

---

### Task 4: Client routes visual proposals through the fix helpers

**Files:**
- Modify: `web/src/components/editor/ConfirmAiEditDialog.jsx` (lines 1-2, 20-23, 29-34)
- Modify: `web/src/components/editor/ConfirmAiEditDialog.test.jsx`

- [ ] **Step 1: Write the failing tests**

In `web/src/components/editor/ConfirmAiEditDialog.test.jsx`, add (import `proposalToOpFn, describeProposal` from the component file if not already):
```js
describe('visual ops routing', () => {
  const clips = [{ id: 's1', name: 'Scene 1', startTime: 0, endTime: 5 }]

  it('describeProposal uses the fix-template sentence for brightness', () => {
    const d = describeProposal({ op: 'brightness', target_clip_id: 's1', params: { value: 30 } }, clips)
    expect(d.question).toBe('Increase the brightness on Scene 1?')
    expect(d.done).toBe('Increased the brightness on Scene 1.')
  })

  it('describeProposal handles zoom and mute', () => {
    expect(describeProposal({ op: 'zoom', target_clip_id: 's1', params: { value: 150 } }, clips).question)
      .toBe('Zoom Scene 1 to 150%?')
    expect(describeProposal({ op: 'mute', target_clip_id: 's1', params: {} }, clips).question)
      .toBe('Mute the original audio on Scene 1?')
  })

  it('proposalToOpFn applies brightness to the scene colour map', () => {
    const opFn = proposalToOpFn({ op: 'brightness', target_clip_id: 's1', params: { value: 30 } })
    const next = opFn({ clips, colour: {} })
    expect(next.colour.s1.brightness).toBe(30)
  })

  it('proposalToOpFn mutes via the existing op', () => {
    const opFn = proposalToOpFn({ op: 'mute', target_clip_id: 's1', params: {} })
    const next = opFn({ clips })
    // setClipMuted(true) sets muted on the clip
    expect(next.clips.find((c) => c.id === 's1').muted).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/components/editor/ConfirmAiEditDialog.test.jsx`
Expected: FAIL — `describeProposal` returns null for `brightness` (hits `default`), `proposalToOpFn` calls `applyOperation` with an unknown op (no-op), so colour is unchanged.

- [ ] **Step 3: Implement**

In `web/src/components/editor/ConfirmAiEditDialog.jsx`:

Add the import below the existing imports (lines 1-2):
```js
import { fixTemplateToOpFn, describeFixTemplate } from '../../lib/editor/suggestionRouting'
```

Add a shared constant above `proposalToOpFn`:
```js
const VISUAL_OPS = ['brightness', 'contrast', 'saturation', 'zoom', 'rotate', 'mute', 'unmute']

// mute/unmute carry no server value; fixTemplateToOpFn/describeFixTemplate ignore
// the value for them, but build the canonical bool for clarity.
function visualFixTemplate(op, params = {}) {
  const value = op === 'mute' ? true : op === 'unmute' ? false : params.value
  return { action: op, value }
}
```

Replace `proposalToOpFn` (lines 20-23) with:
```js
export function proposalToOpFn(proposal) {
  const { op, target_clip_id: id, params = {} } = proposal
  if (VISUAL_OPS.includes(op)) {
    return fixTemplateToOpFn(visualFixTemplate(op, params), id)
  }
  return (state) => applyOperation(state, id, op, { captionText: params.caption_text })
}
```

In `describeProposal`, add the visual branch right after the `const name = clip.name` line (before `const caption = ...`):
```js
  if (VISUAL_OPS.includes(proposal.op)) {
    return describeFixTemplate(visualFixTemplate(proposal.op, proposal.params), name)
  }
```
Leave the existing structural `switch` unchanged.

- [ ] **Step 4: Run tests**

Run: `cd web && npx vitest run src/components/editor/ConfirmAiEditDialog.test.jsx`
Expected: PASS — visual routing tests green; existing structural tests still green.

- [ ] **Step 5: Run the full web suite**

Run: `cd web && npx vitest run`
Expected: PASS — no regressions.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/editor/ConfirmAiEditDialog.jsx web/src/components/editor/ConfirmAiEditDialog.test.jsx
git commit -m "feat(web): ai-edit confirm routes visual ops through the fix helpers"
```

---

## Self-Review

**Spec coverage:**
- Server allow-list + prompt + validation for the 6 visual capabilities (7 op strings) → Tasks 2 + 3. ✓
- Client routing via `fixTemplateToOpFn` / `describeFixTemplate` → Task 4. ✓
- Shared value-range validator extracted (suggestions + ai-edit one copy) → Task 1. ✓
- Value model = AI-chosen, range-validated; out-of-range → clarification → Task 2 (`bad_value` → `proposeEdit` returns clarification). ✓
- Suggestions behaviour preserved → Task 1 Step 5 runs `suggestions.test.js` unchanged. ✓
- Confirm-first + deterministic sentence preserved → reuses `describeFixTemplate`; `ConfirmAiEditDialog`'s confirm-first wiring untouched. ✓
- Structural ops unchanged → Tasks only ADD branches; `STRUCTURAL_OPS` keeps the original 7. ✓

**Placeholder scan:** none — every step has concrete code + commands.

**Type/name consistency:** `AI_FIXABLE_ACTIONS`, `FIX_VALUE_RANGES`, `inRangeValue(action, value)` defined in Task 1 and used identically in Tasks 1 (suggestions) + 2 (aiEdit). `NUMERIC_VISUAL_OPS` (server, 5 ops) vs `VISUAL_OPS` (client, 7 ops incl. mute/unmute) are intentionally different sets — server range-checks only numeric ops, client routes all 7 through the fix helpers; both correct. `visualFixTemplate(op, params)` defined once in Task 4 and used by both `proposalToOpFn` and `describeProposal`. Proposal shape `{op, target_clip_id, params:{value}, summary}` consistent server (Task 2 output) → client (Task 4 input). `describeFixTemplate`/`fixTemplateToOpFn` signatures match `suggestionRouting.js` (`(fixTemplate, clipName)` / `(fixTemplate, clipId)`).
