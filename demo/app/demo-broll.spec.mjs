import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const OUT = fileURLToPath(new URL('./out/', import.meta.url))
fs.mkdirSync(OUT, { recursive: true })
const state = JSON.parse(fs.readFileSync(join(OUT, 'demo-state.json'), 'utf-8'))
const MARKERS = join(OUT, 'markers.json')

// markers.json is shared by the three serial tests; merge so each contributes
// its brollId entry (contentStart + any captured spoken text).
function mergeMarker(brollId, data) {
  const all = fs.existsSync(MARKERS) ? JSON.parse(fs.readFileSync(MARKERS, 'utf-8')) : {}
  all[brollId] = { ...(all[brollId] || {}), ...data }
  fs.writeFileSync(MARKERS, JSON.stringify(all, null, 2))
}

async function signIn(page) {
  await page.goto('/signin')
  await page.getByLabel(/email address/i).fill(state.creatorEmail)
  await page.getByLabel(/password/i).fill(state.password)
  await page.getByRole('button', { name: /^sign in$/i }).click()
  await expect(page.getByRole('heading', { name: /your projects/i })).toBeVisible()
  await page.goto(`/projects/${state.projectId}/edit`)
  await expect(page.getByRole('button', { name: /^scene 1 of/i })).toBeVisible({ timeout: 30_000 })
}

// Beat 1 — scene descriptions: the real Gemini Overview text + a tour of all
// three detail levels (Overview / Detailed / Technical). Voiceover = Overview.
test('descriptions', async ({ browser }) => {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
  })
  const page = await ctx.newPage()
  const t0 = Date.now()
  await signIn(page)
  await page.getByRole('button', { name: /^scene 1 of/i }).first().click()
  // The visible description paragraph inside scene 1's block (current level).
  const descP = page.locator('button[data-scene-index="0"] p').last()
  await expect(descP).toBeVisible()
  const overview = (await descP.textContent())?.trim() || ''

  const contentStart = Math.max(0, (Date.now() - t0) / 1000 - 0.3)
  await page.waitForTimeout(3500)                                   // Overview on screen
  await page.locator('[data-detail-level-value="2"]').click()       // Detailed
  await page.waitForTimeout(3500)
  await page.locator('[data-detail-level-value="3"]').click()       // Technical
  await page.waitForTimeout(3500)
  await page.locator('[data-detail-level-value="1"]').click()       // back to Overview
  await page.waitForTimeout(3000)

  mergeMarker('descriptions', { contentStart, overview })
  await ctx.close()
  await page.video().saveAs(join(OUT, 'descriptions.webm'))
})

// Beat 2 — routing: the three choices, then the result of picking one
// (Edit by Myself reveals the self-edit tools). Silent under its caption.
test('routing', async ({ browser }) => {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
  })
  const page = await ctx.newPage()
  const t0 = Date.now()
  await signIn(page)
  await page.getByRole('button', { name: /^scene 1 of/i }).first().click()
  const selfBtn = page.getByRole('button', { name: /edit by myself/i })
  await expect(selfBtn).toBeVisible()
  // Centre the MIDDLE routing button so all three choices (Edit by Myself /
  // Ask AI to Edit / Ask Helper to Edit) are framed together.
  const askAiBtn = page.getByRole('button', { name: /^ask ai to edit$/i })
  await askAiBtn.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(400)

  const contentStart = Math.max(0, (Date.now() - t0) / 1000 - 0.3)
  await page.waitForTimeout(2800)                  // the three routing choices on screen
  await selfBtn.click()                            // pick one -> show what happens next
  // The edit-panel group reveals the self-edit tools (Trim/Move/Delete/…). Its
  // buttons carry long aria-labels, so target the group itself, not a label.
  const editPanel = page.getByRole('group', { name: /edit by myself/i })
  await expect(editPanel).toBeVisible()
  await editPanel.scrollIntoViewIfNeeded()
  await page.waitForTimeout(3200)                  // the self-edit tools revealed

  mergeMarker('routing', { contentStart })
  await ctx.close()
  await page.video().saveAs(join(OUT, 'routing.webm'))
})

// Beat 3 (flagship) — Ask AI to Edit: a request -> the deterministic confirm
// dialog -> confirm -> the timeline updates. Voiceover = the real edit feedback.
test('aiedit', async ({ browser }) => {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
  })
  const page = await ctx.newPage()
  const t0 = Date.now()
  await signIn(page)
  // Use scene 2 so "delete scene 2" is unambiguous.
  await page.getByRole('button', { name: /^scene 2 of/i }).first().click()
  await page.getByRole('button', { name: /ask ai to edit/i }).click()
  const box = page.getByRole('textbox', { name: /task description/i })
  await expect(box).toBeVisible()
  await box.fill('Delete scene 2 from the timeline.')
  await box.press('Enter')

  // Wait for the deterministic confirm dialog (Gemini round-trip).
  const question = page.locator('#confirm-ai-edit-question')
  await expect(question).toBeVisible({ timeout: 25_000 })
  const proposal = (await question.textContent())?.trim() || ''

  // The app's real edit confirmation is the deterministic `done` sentence
  // (describeProposal): "Delete Scene 2?" -> "Deleted Scene 2." Derive it from
  // the captured proposal — the live-region announcer races with the post-delete
  // re-expand, so polling it is unreliable.
  const del = proposal.match(/^Delete (.+?)\??$/i)
  const feedback = del ? `Deleted ${del[1]}.` : proposal.replace(/\?+$/, '.')

  const contentStart = Math.max(0, (Date.now() - t0) / 1000 - 0.3)
  await page.waitForTimeout(3000)                  // the proposal on screen
  await page.getByRole('alertdialog').getByRole('button', { name: /confirm/i }).click()
  await page.waitForTimeout(3500)                  // the applied result on screen

  mergeMarker('aiedit', { contentStart, feedback, proposal })
  await ctx.close()
  await page.video().saveAs(join(OUT, 'aiedit.webm'))
})
