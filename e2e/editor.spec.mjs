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

// Creator-side selectors are honest against the Phase 2a scene-block creator UI
// (web/src/components/editor/{CreatorDevice,SceneActions}.jsx +
// sceneblocks/SceneBlock.jsx). The creator is now an inline list of collapsible
// scene blocks, NOT the old single-scene modal. Each scene's collapsed header
// button has aria-label "Scene N of M: <name>. ..." (SceneBlock.jsx). Expanding
// it reveals the per-scene SceneActions: "Edit by Myself" toggles a panel whose
// "Delete" button keeps the aria-label "Delete this clip from the timeline";
// "Ask Helper to Edit" toggles a panel with a "Task description" textbox + a
// "Send to helper" button.
const sceneHeader = (page, n) =>
  page.getByRole('button', { name: new RegExp(`^scene ${n} of`, 'i') })

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
  // Creator: the scene-block list renders one collapsed header per scene. The
  // first scene's header (aria-label "Scene 1 of N: …") only exists on the
  // creator device.
  await expect(sceneHeader(creator, 1)).toBeVisible({ timeout: 30_000 })
  // Helper: HelperDevice renders the "Activity Feed" heading.
  await expect(helper.getByRole('heading', { name: /activity feed/i })).toBeVisible({ timeout: 30_000 })

  // The helper timeline must have rendered its scene clips (3 from the 12s clip).
  await expect(helper.getByTestId('timeline-clip').first()).toBeVisible({ timeout: 30_000 })
  const sceneCountBefore = await helper.getByTestId('timeline-clip').count()
  expect(sceneCountBefore).toBeGreaterThan(1)

  // (b) Creator deletes scene 1 via the new inline UI: expand the scene block ->
  // open "Edit by Myself" -> click "Delete". The helper's timeline-clip count
  // then drops by 1 once the project_state INSERT propagates over Supabase
  // Realtime. In the healthy case this lands in ~1-2s, but realtime delivery
  // over the public internet can legitimately stall for several seconds, so the
  // web-first wait allows up to 30s. This is a timing allowance, NOT a weaker
  // assertion: the helper must still reach the EXACT post-delete count.
  await sceneHeader(creator, 1).click()
  await creator.getByRole('button', { name: /^edit by myself$/i }).click()
  await creator.getByRole('button', { name: /delete this clip from the timeline/i }).click()
  await expect(helper.getByTestId('timeline-clip')).toHaveCount(sceneCountBefore - 1, { timeout: 30_000 })

  // (c) Creator sends a task -> helper sees it -> helper marks it done ->
  // creator sees the status. Drive the task from scene 1's block. After the
  // delete, SceneBlockList keeps expandedIndex=0, so the NEW scene 1 (former
  // scene 2) AUTO-EXPANDS onto its actions — tapping the header again would
  // COLLAPSE it. So make the expand idempotent off the header's own a11y state:
  // an expanded header's aria-label ends with "Tap to close actions.", a
  // collapsed one with "Tap to open actions." Only tap the header when it's
  // collapsed, then drive the actions. Scope the "Task description" textbox +
  // send button to the "Ask Helper" group — the "Ask AI to Edit" panel reuses
  // the same "Task description" aria-label.
  const collapsedScene1 = creator.getByRole('button', {
    name: /^scene 1 of .*tap to open actions\.$/i,
  })
  // Wait for the list to settle into a deterministic post-delete state: scene 1
  // is either already expanded (auto-follow) or collapsed.
  await expect(sceneHeader(creator, 1)).toBeVisible()
  if (await collapsedScene1.isVisible()) {
    await collapsedScene1.click()
  }
  const askHelperToggle = creator.getByRole('button', { name: /^ask helper to edit$/i })
  await expect(askHelperToggle).toBeVisible()
  await askHelperToggle.click()
  const askHelper = creator.getByRole('group', { name: /^ask helper$/i })
  await askHelper.getByLabel(/task description/i).fill('Please trim the shaky part')
  await askHelper.getByRole('button', { name: /send to helper/i }).click()

  // Helper receives the task via realtime INSERT and renders its text in the
  // ActivityFeed. Scope to the "Tasks and activity" region (the ActivityFeed) —
  // the helper ALSO echoes the latest task text in its "Creator's current
  // request" intent banner, so an unscoped getByText matches two elements. Exact
  // text also avoids the sr-only live-region announcement ("Creator sent you a
  // task: …").
  // 30s for the same reason as the delete propagation above: this also rides a
  // Supabase Realtime INSERT over the public internet (exact task text still
  // required — only the wait is widened).
  const activityFeed = helper.getByRole('region', { name: /tasks and activity/i })
  await expect(
    activityFeed.getByText('Please trim the shaky part', { exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await helper.getByRole('button', { name: /mark done/i }).click()

  // Creator's "Recent Tasks" reflects the helper's status as "Helper: Done"
  // (realtime UPDATE propagation — same cross-internet timing allowance).
  await expect(creator.getByText(/helper:\s*done/i)).toBeVisible({ timeout: 30_000 })

  // (d) Refresh both -> the deleted scene stays gone, the task stays done.
  await creator.reload()
  await helper.reload()

  await expect(helper.getByTestId('timeline-clip').first()).toBeVisible({ timeout: 30_000 })
  await expect(helper.getByTestId('timeline-clip')).toHaveCount(sceneCountBefore - 1)
  await expect(creator.getByText(/helper:\s*done/i)).toBeVisible({ timeout: 30_000 })

  await creatorCtx.close()
  await helperCtx.close()
})
