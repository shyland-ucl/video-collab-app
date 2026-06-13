import { test, expect } from '@playwright/test'
import fs from 'node:fs'

// Credentials + ids provisioned by setup/globalSetup.mjs against the live stack.
const state = JSON.parse(fs.readFileSync(new URL('./.state.json', import.meta.url), 'utf-8'))

// Sign-in selectors are honest against web/src/pages/SignInPage.jsx:
//   route /signin, label "Email address", label "Password", button "Sign in",
//   post-auth lands on ProjectsPage whose h1 is "Your projects".
async function signIn(page, email, password) {
  await page.goto('/signin')
  await page.getByLabel(/email address/i).fill(email)
  await page.getByLabel(/password/i).fill(password)
  await page.getByRole('button', { name: /^sign in$/i }).click()
  await expect(page.getByRole('heading', { name: /your projects/i })).toBeVisible()
}

test('creator and helper collaborate live; state survives refresh', async ({ browser }) => {
  const creatorCtx = await browser.newContext()
  const helperCtx = await browser.newContext()
  const creator = await creatorCtx.newPage()
  const helper = await helperCtx.newPage()

  await signIn(creator, state.creatorEmail, state.password)
  await signIn(helper, state.helperEmail, state.password)

  await creator.goto(`/projects/${state.projectId}/edit`)
  await helper.goto(`/projects/${state.projectId}/edit`)

  // (a) Both devices load their role UIs.
  // Creator: ExplorationMode's "Edit Myself" action (aria-label
  // "Edit this clip yourself") only exists on the creator device.
  await expect(
    creator.getByRole('button', { name: /edit this clip yourself/i })
  ).toBeVisible({ timeout: 30_000 })
  // Helper: HelperDevice renders the "Activity Feed" heading.
  await expect(helper.getByRole('heading', { name: /activity feed/i })).toBeVisible({ timeout: 30_000 })

  // The helper timeline must have rendered its scene clips (3 from the 12s clip).
  await expect(helper.getByTestId('timeline-clip').first()).toBeVisible({ timeout: 30_000 })
  const sceneCountBefore = await helper.getByTestId('timeline-clip').count()
  expect(sceneCountBefore).toBeGreaterThan(1)

  // (b) Creator deletes the current scene via Edit Myself -> Delete; the
  // helper's timeline-clip count drops by 1 within ~15s (realtime propagation).
  await creator.getByRole('button', { name: /edit this clip yourself/i }).click()
  await creator.getByRole('button', { name: /delete this clip from the timeline/i }).click()
  await expect(helper.getByTestId('timeline-clip')).toHaveCount(sceneCountBefore - 1, { timeout: 15_000 })

  // (c) Creator sends a task -> helper sees it -> helper marks it done ->
  // creator sees the status.
  await creator.getByRole('button', { name: /ask helper to edit this clip/i }).click()
  await creator.getByLabel(/task description/i).fill('Please trim the shaky part')
  await creator.getByRole('button', { name: /send task/i }).click()

  // Helper receives the task via realtime INSERT and renders its text in the
  // ActivityFeed. Scope to the visible task article — exact text avoids matching
  // the sr-only live-region announcement ("Creator sent you a task: …").
  await expect(
    helper.getByText('Please trim the shaky part', { exact: true })
  ).toBeVisible({ timeout: 15_000 })
  await helper.getByRole('button', { name: /mark done/i }).click()

  // Creator's "Recent Tasks" reflects the helper's status as "Helper: Done".
  await expect(creator.getByText(/helper:\s*done/i)).toBeVisible({ timeout: 15_000 })

  // (d) Refresh both -> the deleted scene stays gone, the task stays done.
  await creator.reload()
  await helper.reload()

  await expect(helper.getByTestId('timeline-clip').first()).toBeVisible({ timeout: 30_000 })
  await expect(helper.getByTestId('timeline-clip')).toHaveCount(sceneCountBefore - 1)
  await expect(creator.getByText(/helper:\s*done/i)).toBeVisible({ timeout: 30_000 })

  await creatorCtx.close()
  await helperCtx.close()
})
