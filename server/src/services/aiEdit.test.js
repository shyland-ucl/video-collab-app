import { describe, it, expect, vi } from 'vitest'
import { buildSceneList, proposeEdit, validateProposal, AI_EDIT_OPS } from './aiEdit.js'

const CLIPS = [
  { id: 'g1', name: 'Scene 1', duration_seconds: 5 },
  { id: 'g2', name: 'Scene 2', duration_seconds: 3 },
]
const DESCRIPTIONS = { g1: 'A person stirs a pot.', g2: 'They taste the food.' }

function fakeModel(text) {
  return { generateContent: vi.fn(async () => ({ response: { text: () => text } })) }
}

describe('buildSceneList', () => {
  it('renders one line per clip with description', () => {
    const list = buildSceneList(CLIPS, DESCRIPTIONS)
    expect(list).toMatch(/g1 \| Scene 1 \| 5s \| A person stirs a pot\./)
    expect(list.split('\n')).toHaveLength(2)
  })
})

describe('validateProposal', () => {
  const ids = new Set(['g1', 'g2'])
  it('accepts a valid delete', () => {
    expect(validateProposal({ op: 'delete', target_clip_id: 'g1', params: {}, summary: 'x' }, ids).ok).toBe(true)
  })
  it('rejects unknown ops, unknown targets, missing caption text', () => {
    expect(validateProposal({ op: 'explode', target_clip_id: 'g1', params: {}, summary: 'x' }, ids).ok).toBe(false)
    expect(validateProposal({ op: 'delete', target_clip_id: 'nope', params: {}, summary: 'x' }, ids).ok).toBe(false)
    expect(validateProposal({ op: 'add_caption', target_clip_id: 'g1', params: {}, summary: 'x' }, ids).ok).toBe(false)
  })

  it('accepts trims without params', () => {
    expect(validateProposal({ op: 'trim_start', target_clip_id: 'g1', params: {}, summary: 'x' }, ids).ok).toBe(true)
  })
  it('accepts a clarification', () => {
    expect(validateProposal({ clarification: 'Which scene?' }, ids).ok).toBe(true)
  })
})

describe('proposeEdit', () => {
  it('returns a validated proposal from clean JSON', async () => {
    const model = fakeModel(JSON.stringify({ op: 'delete', target_clip_id: 'g2', params: {}, summary: 'I will delete Scene 2.' }))
    const result = await proposeEdit(model, 'remove the tasting scene', CLIPS, DESCRIPTIONS)
    expect(result).toMatchObject({ op: 'delete', target_clip_id: 'g2' })
  })

  it('strips markdown fences', async () => {
    const model = fakeModel('```json\n{"clarification":"Which scene do you mean?"}\n```')
    const result = await proposeEdit(model, 'cut it', CLIPS, DESCRIPTIONS)
    expect(result.clarification).toMatch(/Which scene/)
  })

  it('turns junk or invalid proposals into a clarification', async () => {
    const junk = await proposeEdit(fakeModel('I think you should...'), 'x', CLIPS, DESCRIPTIONS)
    expect(junk.clarification).toBeTruthy()
    const badTarget = await proposeEdit(fakeModel(JSON.stringify({ op: 'delete', target_clip_id: 'zzz', params: {}, summary: 's' })), 'x', CLIPS, DESCRIPTIONS)
    expect(badTarget.clarification).toBeTruthy()
  })
})
