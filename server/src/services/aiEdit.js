import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AI_FIXABLE_ACTIONS, inRangeValue } from './fixActions.js'

const promptsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts')

const STRUCTURAL_OPS = ['delete', 'split', 'move_earlier', 'move_later', 'add_caption', 'trim_start', 'trim_end']
export const AI_EDIT_OPS = [...STRUCTURAL_OPS, ...AI_FIXABLE_ACTIONS]
const NUMERIC_VISUAL_OPS = ['brightness', 'contrast', 'saturation', 'zoom', 'rotate']

export function buildSceneList(clips, descriptionsById) {
  return clips
    .map((c) => {
      const safeName = String(c.name).replace(/[\n|]/g, ' ')
      const safeDesc = String(descriptionsById[c.id] ?? 'no description').replace(/[\n|]/g, ' ')
      return `${c.id} | ${safeName} | ${Math.round(c.duration_seconds)}s | ${safeDesc}`
    })
    .join('\n')
}

// After this many prior clarification rounds, tell the model to stop asking and
// commit to its best single-operation guess. The confirm dialog is the safety
// net (a wrong proposal is cancellable; an endless clarification loop is not).
export const MAX_CLARIFY_ROUNDS = 2

// The scene the creator is asking from. When the request is deictic ("this
// scene", "it", "trim the start"), naming this scene is what lets the model
// resolve a target instead of asking "which scene?". Empty when no/undefined
// focus, or when the focused id isn't one of the offered clips (never trust it).
function buildFocusBlock(clips, focusedClipId) {
  if (!focusedClipId) return ''
  const clip = clips.find((c) => c.id === focusedClipId)
  if (!clip) return ''
  const safeName = String(clip.name).replace(/[\n|]/g, ' ')
  return (
    `\n\nThe creator is currently working on ${safeName} (id: ${clip.id}). ` +
    `If the request does not name a specific scene, it refers to THIS scene.`
  )
}

// Prior { request, clarification } rounds of THIS same exchange, so the model
// combines the creator's earlier request with their current answer instead of
// treating the answer as a brand-new (context-free) request.
function buildHistoryBlock(history) {
  if (!Array.isArray(history) || history.length === 0) return ''
  const lines = history
    .map((h, i) => {
      const req = String(h?.request ?? '').replace(/\s+/g, ' ').trim()
      const clar = String(h?.clarification ?? '').replace(/\s+/g, ' ').trim()
      return `${i + 1}. The creator asked: "${req}" — you replied asking: "${clar}"`
    })
    .join('\n')
  return (
    `\n\nEarlier turns of THIS request (the creator is now answering your last ` +
    `question — combine everything into one operation on one scene):\n${lines}`
  )
}

function buildFinalRoundBlock(history) {
  const rounds = Array.isArray(history) ? history.length : 0
  if (rounds < MAX_CLARIFY_ROUNDS) return ''
  return (
    `\n\nThis is the final round: do NOT ask another question. Choose the single ` +
    `most likely operation and scene from everything above and return a proposal.`
  )
}

// Honest, reason-specific fallback spoken to the creator when the model's
// proposal fails validation. The generic "name the scene number" line is only
// right for a genuinely unresolved target — using it for a bad value or a
// missing caption sent the creator in circles (the reported bug).
const FALLBACK_BY_REASON = {
  bad_value:
    "I understood the kind of change, but not by how much — tell me an amount, like 'a little' or 'by 20'.",
  missing_caption_text: 'What would you like the caption to say?',
  unknown_target: "I couldn't tell which scene you meant — try naming it, like 'scene 2'.",
}
const GENERIC_FALLBACK =
  "I couldn't match that to one of the scenes — could you name the scene number?"

export function validateProposal(proposal, validIds) {
  if (proposal && typeof proposal.clarification === 'string' && proposal.clarification.trim()) {
    return { ok: true, kind: 'clarification' }
  }
  if (!proposal || !AI_EDIT_OPS.includes(proposal.op)) return { ok: false, reason: 'unknown_op' }
  if (!validIds.has(proposal.target_clip_id)) return { ok: false, reason: 'unknown_target' }
  if (typeof proposal.summary !== 'string' || !proposal.summary.trim()) return { ok: false, reason: 'missing_summary' }
  const params = proposal.params ?? {}
  if (proposal.op === 'add_caption' && !(typeof params.caption_text === 'string' && params.caption_text.trim())) {
    return { ok: false, reason: 'missing_caption_text' }
  }
  if (NUMERIC_VISUAL_OPS.includes(proposal.op) && !inRangeValue(proposal.op, params.value)) {
    return { ok: false, reason: 'bad_value' }
  }
  return { ok: true, kind: 'proposal' }
}

function parseJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```[\s\S]*$/, '')
  return JSON.parse(cleaned)
}

export async function proposeEdit(model, request, clips, descriptionsById, options = {}) {
  const { focusedClipId = null, history = [], log = () => {} } = options
  const promptTemplate = await fs.readFile(path.join(promptsDir, 'ai_edit.txt'), 'utf-8')
  const sceneList = buildSceneList(clips, descriptionsById)
  const prompt =
    `${promptTemplate.trim()}` +
    buildFocusBlock(clips, focusedClipId) +
    `\n\nScenes:\n${sceneList}` +
    buildHistoryBlock(history) +
    buildFinalRoundBlock(history) +
    `\n\nCreator's request: ${request}\n`

  let proposal
  try {
    const result = await model.generateContent(prompt)
    proposal = parseJson(result.response.text())
  } catch {
    return { clarification: "I couldn't work out an edit for that — could you say it another way?" }
  }

  const verdict = validateProposal(proposal, new Set(clips.map((c) => c.id)))
  if (!verdict.ok) {
    // Log the real reason (masked from the creator) so a looping exchange is
    // diagnosable, and speak a reason-specific question instead of always
    // blaming an unresolved scene.
    log(`ai-edit invalid proposal: ${verdict.reason}`)
    return { clarification: FALLBACK_BY_REASON[verdict.reason] ?? GENERIC_FALLBACK }
  }
  if (verdict.kind === 'clarification') {
    return { clarification: String(proposal.clarification).slice(0, 500) }
  }
  return {
    op: proposal.op,
    target_clip_id: proposal.target_clip_id,
    params:
      proposal.op === 'add_caption'
        ? { caption_text: String(proposal.params.caption_text).slice(0, 500) }
        : NUMERIC_VISUAL_OPS.includes(proposal.op)
          ? { value: proposal.params.value }
          : {},
    summary: String(proposal.summary).slice(0, 500),
  }
}
