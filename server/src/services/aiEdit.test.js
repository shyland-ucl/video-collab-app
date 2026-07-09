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

  it('sanitizes newlines and pipes in name and description to prevent scene-list forgery', () => {
    const clips = [{ id: 'x1', name: 'Real\nINJECTED-LINE | Fake', duration_seconds: 2 }]
    const descs = { x1: 'desc with | pipe\nand newline' }
    const list = buildSceneList(clips, descs)
    const lines = list.split('\n')
    // Must be exactly one line per clip — newline injection must not create extra lines
    expect(lines).toHaveLength(1)
    // No raw newlines should be present inside name or description fields
    expect(lines[0]).not.toMatch(/INJECTED-LINE \| Fake/)
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

  it('strips extra top-level keys and junk params — only whitelisted keys returned for delete', async () => {
    const raw = { op: 'delete', target_clip_id: 'g2', params: { evil: 'x' }, summary: 's', extra_key: 'y' }
    const model = fakeModel(JSON.stringify(raw))
    const result = await proposeEdit(model, 'remove scene 2', CLIPS, DESCRIPTIONS)
    expect(Object.keys(result).sort()).toEqual(['op', 'params', 'summary', 'target_clip_id'])
    expect(result.params).toEqual({})
    expect(result).not.toHaveProperty('extra_key')
  })

  it('includes caption_text in params for add_caption but strips other params', async () => {
    const raw = { op: 'add_caption', target_clip_id: 'g1', params: { caption_text: 'Hello world', evil: 'x' }, summary: 'add caption' }
    const model = fakeModel(JSON.stringify(raw))
    const result = await proposeEdit(model, 'add caption to scene 1', CLIPS, DESCRIPTIONS)
    expect(Object.keys(result).sort()).toEqual(['op', 'params', 'summary', 'target_clip_id'])
    expect(result.params).toEqual({ caption_text: 'Hello world' })
  })

  it('truncates clarification to 500 chars', async () => {
    const longClarification = 'x'.repeat(600)
    const raw = { clarification: longClarification }
    const model = fakeModel(JSON.stringify(raw))
    const result = await proposeEdit(model, 'do something', CLIPS, DESCRIPTIONS)
    expect(result.clarification.length).toBeLessThanOrEqual(500)
  })
})

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
  it('forwards an in-range value for numeric ops, {} for mute', async () => {
    const clips = [{ id: 'c1', name: 'Scene 1', duration_seconds: 5 }]
    const brightnessModel = { generateContent: async () => ({ response: { text: () => JSON.stringify({ op: 'brightness', target_clip_id: 'c1', params: { value: 30, sneaky: 'x' }, summary: 'brighten Scene 1' }) } }) }
    const out = await proposeEdit(brightnessModel, 'brighten scene 1', clips, {})
    expect(out).toEqual({ op: 'brightness', target_clip_id: 'c1', params: { value: 30 }, summary: 'brighten Scene 1' })

    const muteModel = { generateContent: async () => ({ response: { text: () => JSON.stringify({ op: 'mute', target_clip_id: 'c1', params: {}, summary: 'mute Scene 1' }) } }) }
    const muteOut = await proposeEdit(muteModel, 'mute scene 1', clips, {})
    expect(muteOut).toEqual({ op: 'mute', target_clip_id: 'c1', params: {}, summary: 'mute Scene 1' })
  })
})

// Regression coverage for the reported bug: deictic requests ("make it
// brighter", "trim the start") looped on clarifications because the focused
// scene was never given to the model and clarification answers carried no
// context. These assert the prompt-assembly contract; the live model behaviour
// is verified separately by scripts/diag-aiedit.mjs.
describe('proposeEdit — focused scene + clarification history', () => {
  const CLIPS3 = [
    { id: 'g1', name: 'Scene 1', duration_seconds: 5 },
    { id: 'g2', name: 'Scene 2', duration_seconds: 3 },
  ]

  it('names the focused scene in the prompt so a deictic request resolves', async () => {
    const model = fakeModel(JSON.stringify({ op: 'brightness', target_clip_id: 'g2', params: { value: 20 }, summary: 'brighten Scene 2' }))
    await proposeEdit(model, 'make it brighter', CLIPS3, {}, { focusedClipId: 'g2' })
    const prompt = model.generateContent.mock.calls[0][0]
    expect(prompt).toMatch(/working on Scene 2/i)
    expect(prompt).toContain('g2')
  })

  it('omits the focus line when the focused id is not one of the clips', async () => {
    const model = fakeModel(JSON.stringify({ clarification: 'Which scene?' }))
    await proposeEdit(model, 'make it brighter', CLIPS3, {}, { focusedClipId: 'nope' })
    // The dynamic focus block names a real scene ("working on Scene 2"); assert
    // THAT is absent (the static template mentions a lowercase "currently
    // working on" scene, so a looser matcher would false-positive on it).
    expect(model.generateContent.mock.calls[0][0]).not.toMatch(/working on Scene \d/i)
  })

  it('renders prior clarification rounds so the answer is combined with the original request', async () => {
    const model = fakeModel(JSON.stringify({ op: 'delete', target_clip_id: 'g2', params: {}, summary: 'delete Scene 2' }))
    const history = [{ request: 'get rid of it', clarification: 'Which scene would you like to delete?' }]
    await proposeEdit(model, 'scene 2', CLIPS3, {}, { history })
    const prompt = model.generateContent.mock.calls[0][0]
    expect(prompt).toMatch(/earlier/i)
    expect(prompt).toContain('get rid of it')
    expect(prompt).toContain('Which scene would you like to delete?')
  })

  it('instructs the model to stop asking once the clarification round cap is reached', async () => {
    const model = fakeModel(JSON.stringify({ op: 'delete', target_clip_id: 'g2', params: {}, summary: 'delete Scene 2' }))
    const history = [
      { request: 'do the thing', clarification: 'Which scene?' },
      { request: 'that one', clarification: 'What would you like to do?' },
    ]
    await proposeEdit(model, 'delete it', CLIPS3, {}, { history })
    expect(model.generateContent.mock.calls[0][0]).toMatch(/do not ask|final/i)
  })

  it('returns an amount-specific clarification (not the generic one) when a numeric value is out of range', async () => {
    const model = fakeModel(JSON.stringify({ op: 'brightness', target_clip_id: 'g1', params: { value: 999 }, summary: 'x' }))
    const result = await proposeEdit(model, 'much brighter', CLIPS3, {})
    expect(result.clarification).toMatch(/amount|how much/i)
    expect(result.clarification).not.toMatch(/name the scene number/i)
  })

  it('logs the validation-failure reason via the injected logger', async () => {
    const log = vi.fn()
    const model = fakeModel(JSON.stringify({ op: 'brightness', target_clip_id: 'g1', params: { value: 999 }, summary: 'x' }))
    await proposeEdit(model, 'much brighter', CLIPS3, {}, { log })
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/bad_value/))
  })
})
