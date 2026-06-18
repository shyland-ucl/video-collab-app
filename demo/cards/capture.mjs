import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FFMPEG, DEMO_DIR, OUT_DIR } from '../lib/paths.mjs'

const moments = JSON.parse(readFileSync(join(DEMO_DIR, 'moments.json')))
const CARDS = join(OUT_DIR, 'cards')
mkdirSync(CARDS, { recursive: true })
const dur = (name) => moments.timeline.find(m => m.card === name)?.dur ?? 5

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
for (const name of ['intro', 'outro']) {
  await page.goto(pathToFileURL(join(DEMO_DIR, 'cards', `${name}.html`)).href)
  const png = join(CARDS, `${name}.png`)
  await page.screenshot({ path: png })
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-loop', '1', '-i', png, '-t', String(dur(name)),
    '-vf', 'fps=30,format=yuv420p,scale=1920:1080', '-c:v', 'libx264', '-crf', '18',
    join(CARDS, `${name}.mp4`)], { stdio: 'inherit' })
  console.log('card', name, `${dur(name)}s`)
}
await browser.close()