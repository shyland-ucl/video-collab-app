/**
 * Live Ask-AI-to-Edit check — the quality gate for the clarification fix.
 * Runs the REAL proposeEdit + REAL Gemini and prints, for every allowed op,
 * whether a natural in-panel ("deictic") request now resolves to a proposal on
 * the focused scene. Also demonstrates the carried-history clarification loop
 * converging. Never run in CI; never gates a build — a human judges the output.
 *
 * Run from repo root (the E: clone has no server/.env — point at wherever your
 * filled env lives):
 *   node --env-file=server/.env scripts/diag-aiedit.mjs
 *
 * Requires GEMINI_API_KEY (+ optional GEMINI_MODEL) in the env file.
 */
import { randomUUID } from 'node:crypto'
import { proposeEdit, MAX_CLARIFY_ROUNDS } from '../server/src/services/aiEdit.js'
import { makeGeminiModel } from '../server/src/services/descriptions.js'

const model = makeGeminiModel()

const u = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
const CLIPS = [
  { id: u[0], name: 'Scene 1', duration_seconds: 8 },
  { id: u[1], name: 'Scene 2', duration_seconds: 5 },
  { id: u[2], name: 'Scene 3', duration_seconds: 12 },
  { id: u[3], name: 'Scene 4', duration_seconds: 6 },
]
const DESCRIPTIONS = {
  [u[0]]: 'A kitchen bench with ingredients laid out; steady framing, well lit.',
  [u[1]]: 'The creator stirs a pot on the stove; slight camera shake, a bit dark.',
  [u[2]]: 'Close-up of plating the finished dish; crisp focus.',
  [u[3]]: 'The creator tastes the food and smiles; loud background music.',
}

// The real app always sends the scene the panel belongs to. Focus on Scene 2.
const FOCUS = CLIPS[1]

// Natural, deictic phrasings — how a creator talks from inside a scene's panel.
const CASES = [
  ['delete', 'delete this scene'],
  ['split', 'split this scene in two'],
  ['move_earlier', 'move this one earlier'],
  ['move_later', 'move this scene later'],
  ['add_caption', 'add a caption to this scene saying Fresh pasta'],
  ['trim_start', 'trim the start a little'],
  ['trim_end', 'cut a bit off the end'],
  ['brightness', 'make it brighter'],
  ['contrast', 'add more contrast'],
  ['saturation', 'boost the colours a bit'],
  ['zoom', 'zoom in a little'],
  ['rotate', 'it is sideways, fix it'],
  ['mute', 'silence this scene'],
  ['unmute', 'turn the sound back on for this scene'],
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function classify(result) {
  if (result?.clarification) return { kind: 'CLARIFY', note: result.clarification.slice(0, 90) }
  if (result?.op) {
    const scene = CLIPS.find((c) => c.id === result.target_clip_id)?.name ?? '??unknown-id??'
    const v = result.params?.value !== undefined ? ` value=${JSON.stringify(result.params.value)}` : ''
    const cap = result.params?.caption_text ? ` caption=${JSON.stringify(result.params.caption_text)}` : ''
    return { kind: 'PROPOSAL', note: `${result.op}@${scene}${v}${cap}` }
  }
  return { kind: 'OTHER', note: JSON.stringify(result).slice(0, 90) }
}

async function call(request, options) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await proposeEdit(model, request, CLIPS, DESCRIPTIONS, options)
    } catch (err) {
      if (attempt >= 3) throw err
      await sleep(15000) // likely rate limit — back off
    }
  }
}

console.log(`Focused scene: ${FOCUS.name}\n`)
const tally = []
for (const [op, request] of CASES) {
  const { kind, note } = classify(await call(request, { focusedClipId: FOCUS.id, history: [] }))
  tally.push(kind)
  console.log(`${kind.padEnd(9)} ${op.padEnd(13)} "${request}" -> ${note}`)
  await sleep(800)
}

console.log('\n--- carried-history clarification loop (no focus, genuinely ambiguous) ---')
const first = 'do something to make this look better'
const r1 = await call(first, {})
const c1 = classify(r1)
console.log(`round 1  "${first}" -> ${c1.kind}: ${c1.note}`)
if (r1.clarification) {
  const history = [{ request: first, clarification: r1.clarification }]
  const answer = 'the plating close-up — sharpen the colours'
  const r2 = classify(await call(answer, { history }))
  console.log(`round 2  "${answer}" (+history) -> ${r2.kind}: ${r2.note}`)
}

const proposals = tally.filter((k) => k === 'PROPOSAL').length
console.log(`\nDeictic + focus: ${proposals}/${CASES.length} resolved to a proposal (was 1/14 before the fix).`)
console.log(`MAX_CLARIFY_ROUNDS = ${MAX_CLARIFY_ROUNDS}`)
