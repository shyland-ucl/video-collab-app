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

test.afterEach(async ({}, testInfo) => {
  // Move the recorded video to a stable brollId.webm (test title == brollId).
  const v = testInfo.attachments.find(a => a.name === 'video')
  if (v?.path) fs.copyFileSync(v.path, OUT + testInfo.title + '.webm')
})

test('descriptions', async ({ page }) => {
  await signIn(page)
  await page.getByRole('button', { name: /^scene 1 of/i }).first().click()
  // Let the description panel + detail-level controls sit on screen for a few seconds.
  await page.waitForTimeout(5000)
})

test('routing', async ({ page }) => {
  await signIn(page)
  const header = page.getByRole('button', { name: /^scene 1 of/i }).first()
  await header.click()
  // The three routing actions: "Edit by Myself", "Ask AI to Edit", "Ask Helper to Edit".
  await expect(page.getByRole('button', { name: /edit by myself/i })).toBeVisible()
  await page.waitForTimeout(4000)
})
