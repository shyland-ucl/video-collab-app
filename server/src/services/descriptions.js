import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GoogleGenerativeAI } from '@google/generative-ai'

const promptsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts')

export const DESCRIPTION_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash'

export function makeGeminiModel() {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY is not set')
  return new GoogleGenerativeAI(key).getGenerativeModel({ model: DESCRIPTION_MODEL })
}

export async function loadDescriptionPrompt() {
  const [style, desc] = await Promise.all([
    fs.readFile(path.join(promptsDir, '_shared_style.txt'), 'utf-8'),
    fs.readFile(path.join(promptsDir, 'description_generation.txt'), 'utf-8'),
  ])
  return `${style.trim()}\n\n${desc.trim()}\n`
}

export function parseLevels(responseText) {
  const cleaned = responseText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
  const parsed = JSON.parse(cleaned)
  for (const key of ['level_1', 'level_2', 'level_3']) {
    if (typeof parsed[key] !== 'string' || !parsed[key].trim()) {
      throw new Error(`missing_${key}`)
    }
  }
  return { level_1: parsed.level_1, level_2: parsed.level_2, level_3: parsed.level_3 }
}

export async function describeKeyframe(model, promptTemplate, jpegBase64) {
  const parts = [
    { inlineData: { mimeType: 'image/jpeg', data: jpegBase64 } },
    { text: promptTemplate },
  ]
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

export async function answerQuestion(model, jpegBase64, question) {
  const vqaPrompt = await fs.readFile(path.join(promptsDir, 'vqa.txt'), 'utf-8')
  const result = await model.generateContent([
    { inlineData: { mimeType: 'image/jpeg', data: jpegBase64 } },
    { text: `${vqaPrompt.trim()}\n\nQuestion: ${question}\n` },
  ])
  return result.response.text().trim()
}
