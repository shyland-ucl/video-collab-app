import { describe, it, expect, vi } from 'vitest'
import {
  cleanFixTemplate,
  cleanSuggestion,
  curateSuggestions,
  buildScenesBlock,
  proposeSuggestions,
} from './suggestions.js'

const SCENES = [
  { idx: 1, start_seconds: 0, end_seconds: 5, label: 'Scene 1', level1: 'A person stirs a pot.', level2: 'longer', level3: 'longest' },
  { idx: 2, start_seconds: 5, end_seconds: 10, label: 'Scene 2', level1: 'They taste it.', level2: 'longer', level3: 'longest' },
  { idx: 3, start_seconds: 10, end_seconds: 14, label: 'Scene 3', level1: 'Close on the bowl.', level2: 'longer', level3: 'longest' },
]

describe('cleanFixTemplate', () => {
  it('keeps a valid slider template', () => {
    expect(cleanFixTemplate({ action: 'brightness', value: 30, label: 'Brighten' }))
      .toEqual({ action: 'brightness', value: 30, label: 'Brighten' })
  })
  it('rejects an out-of-range slider value', () => {
    expect(cleanFixTemplate({ action: 'zoom', value: 999, label: 'Zoom' })).toBeNull()
    expect(cleanFixTemplate({ action: 'brightness', value: 500, label: 'x' })).toBeNull()
  })
  it('requires mute===true / unmute===false', () => {
    expect(cleanFixTemplate({ action: 'mute', value: true, label: 'Mute' })).toEqual({ action: 'mute', value: true, label: 'Mute' })
    expect(cleanFixTemplate({ action: 'mute', value: false, label: 'Mute' })).toBeNull()
    expect(cleanFixTemplate({ action: 'unmute', value: false, label: 'Unmute' })).toEqual({ action: 'unmute', value: false, label: 'Unmute' })
    expect(cleanFixTemplate({ action: 'unmute', value: true, label: 'Unmute' })).toBeNull()
  })
  it('rejects an unknown action or empty label', () => {
    expect(cleanFixTemplate({ action: 'stabilize', value: 1, label: 'x' })).toBeNull()
    expect(cleanFixTemplate({ action: 'brightness', value: 10, label: '   ' })).toBeNull()
  })
})

describe('cleanSuggestion', () => {
  it('keeps a valid suggestion and trims text', () => {
    const s = cleanSuggestion({ id: 'sug_001', category: 'issue', text: '  too dark in this shot  ', relatedScene: 0, prototype_action: 'brightness', fix_template: { action: 'brightness', value: 30, label: 'Brighten' } }, SCENES.length)
    expect(s).toMatchObject({ category: 'issue', text: 'too dark in this shot', relatedScene: 0, prototype_action: 'brightness' })
    expect(s.fix_template).toEqual({ action: 'brightness', value: 30, label: 'Brighten' })
  })
  it('drops an out-of-range relatedScene', () => {
    expect(cleanSuggestion({ category: 'issue', text: 'darken this scene a touch', relatedScene: 9, prototype_action: 'delete' }, SCENES.length)).toBeNull()
  })
  it('drops an unknown category', () => {
    expect(cleanSuggestion({ category: 'banana', text: 'darken this scene a touch', relatedScene: 0, prototype_action: 'delete' }, SCENES.length)).toBeNull()
  })
  it('drops an unknown prototype_action', () => {
    expect(cleanSuggestion({ category: 'issue', text: 'darken this scene a touch', relatedScene: 0, prototype_action: 'teleport' }, SCENES.length)).toBeNull()
  })
  it('drops an obvious hallucinated fragment below the length floor', () => {
    expect(cleanSuggestion({ category: 'issue', text: 'x', relatedScene: 0, prototype_action: 'delete' }, SCENES.length)).toBeNull()
  })
  it('keeps the suggestion but strips an invalid fix_template', () => {
    const s = cleanSuggestion({ category: 'issue', text: 'zoom in a little here', relatedScene: 0, prototype_action: 'zoom', fix_template: { action: 'zoom', value: 9999, label: 'Zoom' } }, SCENES.length)
    expect(s).not.toBeNull()
    expect(s.fix_template).toBeUndefined()
  })
  it('narrows an array relatedScene to its in-range members', () => {
    const s = cleanSuggestion({ category: 'structural', text: 'reorder these two scenes', relatedScene: [1, 99], prototype_action: 'reorder' }, SCENES.length)
    expect(s.relatedScene).toEqual([1])
  })
})

describe('curateSuggestions', () => {
  it('caps at 3, prefers issue>structural>creative, distinct scenes', () => {
    const all = [
      { category: 'creative', text: 'c', relatedScene: 0, prototype_action: 'add_caption' },
      { category: 'issue', text: 'i', relatedScene: 0, prototype_action: 'brightness' },
      { category: 'structural', text: 's', relatedScene: 1, prototype_action: 'reorder' },
      { category: 'creative', text: 'c2', relatedScene: 2, prototype_action: 'add_sound' },
    ]
    const out = curateSuggestions(all, 3)
    expect(out).toHaveLength(3)
    expect(out[0].category).toBe('issue')      // highest priority first
    expect(out[0].relatedScene).toBe(0)
    expect(new Set(out.map((s) => s.relatedScene)).size).toBe(3) // distinct scenes
  })
  it('skips a suggestion whose only scene is already used', () => {
    const all = [
      { category: 'issue', text: 'i', relatedScene: 0, prototype_action: 'brightness' },
      { category: 'structural', text: 's', relatedScene: 0, prototype_action: 'reorder' },
    ]
    expect(curateSuggestions(all, 3)).toHaveLength(1)
  })
})

describe('buildScenesBlock', () => {
  it('lists scenes with zero-based indices and strips newlines', () => {
    const block = buildScenesBlock([{ idx: 1, start_seconds: 0, end_seconds: 5, label: 'A\nB', level1: 'one\ntwo', level2: '', level3: '' }])
    expect(block).toContain('Scene 0')
    expect(block).not.toContain('\nB') // newline in label collapsed
    expect(block).toContain('one two')
  })
})

describe('proposeSuggestions', () => {
  const reply = (obj) => ({ response: { text: () => JSON.stringify(obj) } })

  it('parses, validates, and curates a good model reply', async () => {
    const model = { generateContent: vi.fn(async () => reply({ suggestions: [
      { id: 'sug_001', category: 'issue', text: 'Scene one is dark', relatedScene: 0, prototype_action: 'brightness', fix_template: { action: 'brightness', value: 30, label: 'Brighten' } },
      { id: 'sug_002', category: 'creative', text: 'Add a caption to scene two', relatedScene: 1, prototype_action: 'add_caption' },
    ] })) }
    const out = await proposeSuggestions(model, SCENES, ['kf0', 'kf1'], { readPrompt: async () => 'PROMPT' })
    expect(out.suggestions).toHaveLength(2)
    expect(out.suggestions[0].category).toBe('issue')
    // keyframes were sent as inlineData image parts
    const parts = model.generateContent.mock.calls[0][0]
    expect(parts.filter((p) => p.inlineData)).toHaveLength(2)
  })

  it('retries once on unparseable text then returns empty', async () => {
    const model = { generateContent: vi.fn(async () => ({ response: { text: () => 'not json' } })) }
    const out = await proposeSuggestions(model, SCENES, [], { readPrompt: async () => 'PROMPT' })
    expect(out.suggestions).toEqual([])
    expect(model.generateContent).toHaveBeenCalledTimes(2)
  })

  it('reports how many raw suggestions were dropped', async () => {
    const model = { generateContent: vi.fn(async () => reply({ suggestions: [
      { category: 'issue', text: 'this suggestion is fine', relatedScene: 0, prototype_action: 'brightness' },
      { category: 'banana', text: 'bad category should drop', relatedScene: 0, prototype_action: 'brightness' },
    ] })) }
    const out = await proposeSuggestions(model, SCENES, [], { readPrompt: async () => 'PROMPT' })
    expect(out.dropped).toBe(1)
  })
})
