/**
 * One-shot live Gemini check.
 * Run from repo root:  node --env-file=server/.env scripts/diag-gemini.mjs
 */
import { GoogleGenerativeAI } from '@google/generative-ai';

const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error('GEMINI_API_KEY is not set (server/.env).');
  process.exit(1);
}
const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const model = new GoogleGenerativeAI(key).getGenerativeModel({ model: modelName });

try {
  const result = await model.generateContent('Reply with the single word: ok');
  console.log(`OK    ${modelName} responded: ${result.response.text().trim()}`);
} catch (err) {
  console.error(`FAIL  ${modelName}: ${err.message}`);
  process.exit(1);
}
