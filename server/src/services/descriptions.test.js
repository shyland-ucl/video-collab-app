import { describe, it, expect, vi } from 'vitest'
import {
  parseLevels,
  describeKeyframe,
  describeScene,
  answerQuestion,
  loadDescriptionPrompt,
} from './descriptions.js'

const GOOD_JSON = JSON.stringify({
  level_1: 'A person walks down a hallway.',
  level_2: 'A person in a red coat walks down a narrow hallway with white walls.',
  level_3: 'Handheld shot, slight motion blur, warm indoor lighting, subject centered.',
})

function fakeModel(responses) {
  let call = 0
  return {
    calls: [],
    generateContent: vi.fn(async function (parts) {
      this.calls.push(parts)
      const text = responses[Math.min(call, responses.length - 1)]
      call += 1
      return { response: { text: () => text } }
    }),
  }
}

describe('parseLevels', () => {
  it('parses a plain JSON response', () => {
    const levels = parseLevels(GOOD_JSON)
    expect(levels.level_1).toMatch(/hallway/)
    expect(levels.level_3).toMatch(/Handheld/)
  })

  it('strips markdown fences', () => {
    const levels = parseLevels('```json\n' + GOOD_JSON + '\n```')
    expect(levels.level_2).toMatch(/red coat/)
  })

  it('rejects responses missing a level', () => {
    expect(() => parseLevels(JSON.stringify({ level_1: 'a', level_2: 'b' }))).toThrow()
  })

  it('rejects non-JSON', () => {
    expect(() => parseLevels('I cannot describe this image.')).toThrow()
  })

  it('strips a closing fence even when prose follows it', () => {
    const levels = parseLevels('```json\n' + GOOD_JSON + '\n```\nHere is your description.')
    expect(levels.level_1).toMatch(/hallway/)
  })
})

describe('describeKeyframe', () => {
  it('returns levels on a clean first response', async () => {
    const model = fakeModel([GOOD_JSON])
    const levels = await describeKeyframe(model, 'PROMPT', 'base64data')
    expect(levels.level_1).toMatch(/hallway/)
    expect(model.generateContent).toHaveBeenCalledTimes(1)
    const parts = model.calls[0]
    expect(parts[0].inlineData).toMatchObject({ mimeType: 'image/jpeg', data: 'base64data' })
    expect(parts[1].text).toBe('PROMPT')
  })

  it('retries once with a JSON reminder when the first response is junk', async () => {
    const model = fakeModel(['Sure! Here is your description...', GOOD_JSON])
    const levels = await describeKeyframe(model, 'PROMPT', 'base64data')
    expect(levels.level_2).toMatch(/red coat/)
    expect(model.generateContent).toHaveBeenCalledTimes(2)
    const retryParts = model.calls[1]
    expect(retryParts[retryParts.length - 1].text).toMatch(/only valid JSON/i)
  })

  it('throws when both attempts fail to parse', async () => {
    const model = fakeModel(['junk', 'more junk'])
    await expect(describeKeyframe(model, 'PROMPT', 'b64')).rejects.toThrow()
  })
})

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

describe('answerQuestion', () => {
  it('sends the keyframe and question, returns trimmed answer', async () => {
    const model = fakeModel(['  The mug is on the left side of the table. '])
    const answer = await answerQuestion(model, 'b64', 'Where is the mug?')
    expect(answer).toBe('The mug is on the left side of the table.')
    const parts = model.calls[0]
    expect(parts[0].inlineData.data).toBe('b64')
    expect(parts[1].text).toMatch(/Where is the mug\?/)
  })
})

describe('loadDescriptionPrompt', () => {
  it('concatenates shared style + description prompt from disk', async () => {
    const prompt = await loadDescriptionPrompt()
    expect(prompt).toMatch(/level_1/)
    expect(prompt.length).toBeGreaterThan(500)
  })
})
