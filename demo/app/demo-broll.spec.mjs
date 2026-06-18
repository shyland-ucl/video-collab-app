import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const state = JSON.parse(fs.readFileSync(new URL('../../e2e/.state.json', import.meta.url), 'utf-8'))
const OUT = fileURLToPath(new URL('./out/', import.meta.url))
fs.mkdirSync(OUT, { recursive: true })

async function signIn(page) {
  await page.goto('/signin')
  await page.getByLabel(/email address/i).fill(state.creatorEmail)
  await page.getByLabel(/password/i).fill(state.password)
  await page.getByRole('button', { name: /^sign in$/i }).click()
  await expect(page.getByRole('heading', { name: /your projects/i })).toBeVisible()
  await page.goto(`/projects/${state.projectId}/edit`)
  await expect(page.getByRole('button', { name: /^scene 1 of/i })).toBeVisible({ timeout: 30_000 })
}

test('descriptions', async ({ browser }) => {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
  })
  const page = await ctx.newPage()
  await signIn(page)
  await page.getByRole('button', { name: /^scene 1 of/i }).first().click()
  // Let the description panel + detail-level controls sit on screen for a few seconds.
  await page.waitForTimeout(5000)
  await ctx.close()
  await page.video().saveAs(OUT + 'descriptions.webm')
})

test('routing', async ({ browser }) => {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
  })
  const page = await ctx.newPage()
  await signIn(page)
  const header = page.getByRole('button', { name: /^scene 1 of/i }).first()
  await header.click()
  // The three routing actions: "Edit by Myself", "Ask AI to Edit", "Ask Helper to Edit".
  await expect(page.getByRole('button', { name: /edit by myself/i })).toBeVisible()
  await page.waitForTimeout(4000)
  await ctx.close()
  await page.video().saveAs(OUT + 'routing.webm')
})
