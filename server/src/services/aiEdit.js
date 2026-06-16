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

export async function proposeEdit(model, request, clips, descriptionsById) {
  const promptTemplate = await fs.readFile(path.join(promptsDir, 'ai_edit.txt'), 'utf-8')
  const sceneList = buildSceneList(clips, descriptionsById)
  const prompt = `${promptTemplate.trim()}\n\nScenes:\n${sceneList}\n\nCreator's request: ${request}\n`

  let proposal
  try {
    const result = await model.generateContent(prompt)
    proposal = parseJson(result.response.text())
  } catch {
    return { clarification: "I couldn't work out an edit for that — could you say it another way?" }
  }

  const verdict = validateProposal(proposal, new Set(clips.map((c) => c.id)))
  if (!verdict.ok) {
    return { clarification: "I couldn't match that to one of the scenes — could you name the scene number?" }
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
