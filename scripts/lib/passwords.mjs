// Word-based credentials (standing preference: typeable "mango-river-42"
// style, never mixed-case gibberish — an untypeable password locked a
// participant out once). Entropy: 150*150*100 ≈ 2.2M combos, ample for an
// allowlisted, researcher-provisioned trial account.
import { randomInt } from 'node:crypto'

const WORDS = [
  'apple', 'amber', 'aspen', 'badge', 'bagel', 'basil', 'beach', 'berry', 'birch', 'bloom',
  'brave', 'bread', 'brook', 'candle', 'canyon', 'cedar', 'cherry', 'clover', 'cloud', 'coral',
  'cotton', 'creek', 'crisp', 'daisy', 'dawn', 'delta', 'drift', 'eagle', 'ember', 'fable',
  'fern', 'field', 'flame', 'flute', 'forest', 'fox', 'frost', 'garden', 'ginger', 'glade',
  'globe', 'gold', 'grape', 'grove', 'harbor', 'hazel', 'heron', 'hill', 'honey', 'island',
  'ivory', 'jade', 'jungle', 'juniper', 'kite', 'lagoon', 'lake', 'lantern', 'leaf', 'lemon',
  'light', 'lily', 'linen', 'lotus', 'lunar', 'maple', 'marble', 'meadow', 'melon', 'mint',
  'mango', 'moss', 'north', 'oak', 'ocean', 'olive', 'onyx', 'opal', 'orchid', 'otter',
  'palm', 'peach', 'pearl', 'pebble', 'penguin', 'pine', 'plum', 'pond', 'poppy', 'prairie',
  'quartz', 'quill', 'rain', 'raven', 'reef', 'ridge', 'river', 'robin', 'rose', 'sage',
  'sand', 'shell', 'silver', 'sky', 'slate', 'snow', 'solar', 'sparrow', 'spring', 'spruce',
  'star', 'stone', 'storm', 'summer', 'sunny', 'swan', 'thyme', 'tiger', 'trail', 'tulip',
  'valley', 'velvet', 'violet', 'wave', 'willow', 'winter', 'wolf', 'wren', 'zebra', 'zinnia',
]

export function wordPassword() {
  const a = WORDS[randomInt(WORDS.length)]
  let b = WORDS[randomInt(WORDS.length)]
  while (b === a) b = WORDS[randomInt(WORDS.length)]
  const n = String(randomInt(100)).padStart(2, '0')
  const pw = `${a}-${b}-${n}`
  // Self-check the contract this trial depends on: typeable, >= 6 chars
  // (GoTrue minimum), exact word-word-NN shape.
  if (!/^[a-z]+-[a-z]+-\d{2}$/.test(pw) || pw.length < 6) {
    throw new Error(`generated password failed its own contract: ${pw}`)
  }
  return pw
}
