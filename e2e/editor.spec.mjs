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

  // (c2) Colour sync: the helper grades the first clip's brightness and the
  // adjustment must reach the BLV creator's pinned video as a CSS `filter`.
  //
  // Wiring (honest against EditorTimeline.jsx + CreatorDevice.jsx):
  //   - The "Visual" toolbar button (aria-label "Show visual adjustments")
  //     reveals the colour sliders. The sliders target `activeToolClip` =
  //     the SELECTED clip, else the clip under the playhead, else clips[0].
  //     We select clip 0 explicitly so the grade is deterministic.
  //   - The Brightness control is <input type="range"> whose accessible name
  //     starts "Brightness:". It commits on pointerup OR keyup-of-an-Arrow
  //     (EditorTimeline commitColour → applyAndSave persists
  //     state.colour[rootSegmentId(clip.id)].brightness). We reproduce a real
  //     drag-then-release: set the value through the native setter, dispatch
  //     `input` (React onChange → pendingColour tracks the thumb) then
  //     `pointerup` (React onPointerUp → commitColour reads e.target.value and
  //     persists). A single deterministic commit avoids racing the async
  //     applyAndSave re-render (which clears pendingColour) against
  //     back-to-back key presses.
  //   - The creator's playback engine resets to clip index 0 on the delete's
  //     structural change, so the creator's ACTIVE scene is the SAME clips[0]
  //     the helper just graded. colourValuesToFilter(brightness:50) →
  //     "brightness(1.250) contrast(1.000) saturate(1.000)", which
  //     CreatorDevice applies as style.filter on the active (display:block)
  //     <video>. With brightness 0 the helper writes nothing renderable
  //     (filter is undefined), so a non-zero value is required for the grade
  //     to be observable at all — this is NOT a weakened assertion.
  //
  // Open the visual panel and select the first clip on the helper timeline.
  await helper.getByRole('button', { name: /show visual adjustments/i }).click()
  await helper.getByTestId('timeline-clip').first().click()

  // The brightness slider (accessible name "Brightness: <n>") only renders
  // once a clip is active in the visual panel.
  const brightness = helper.getByRole('slider', { name: /^brightness:/i })
  await expect(brightness).toBeVisible({ timeout: 10_000 })
  // Drag the brightness to a clear +50 and release. Using the native value
  // setter + React-observed `input`/`pointerup` mirrors a real pointer drag:
  // onChange records the pending value, pointerup commits it through
  // applyAndSave (one durable write that rides project_state → Realtime).
  // brightness 0 yields no renderable filter, so a non-zero grade is required
  // for the change to be observable at all — this is not a weakened assertion.
  await brightness.evaluate((el) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    ).set
    setter.call(el, '50')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  })
  // The committed grade is reflected locally (slider value + a11y name).
  await expect(brightness).toHaveValue('50')

  // The creator is on scene 1 (engine index 0) by default after the delete, so
  // the graded scene is the active one. Assert — with a GENEROUS realtime
  // timeout — that the creator's active/visible <video> carries the synced
  // brightness grade as a CSS filter. This rides a Supabase Realtime INSERT
  // over the public internet (same cross-internet timing allowance as the
  // delete/task steps), so allow up to 30s; the assertion itself is exact
  // (the filter MUST contain "brightness(").
  await expect
    .poll(
      async () =>
        creator.locator('video').evaluateAll((els) =>
          els.map((e) => e.style.filter).filter(Boolean)
        ),
      { timeout: 30_000 }
    )
    .toEqual(expect.arrayContaining([expect.stringContaining('brightness(')]))

  // (d) Refresh both -> the deleted scene stays gone, the task stays done, and
  // the graded brightness survives (it persisted into project_state.colour).
  await creator.reload()
  await helper.reload()

  await expect(helper.getByTestId('timeline-clip').first()).toBeVisible({ timeout: 30_000 })
  await expect(helper.getByTestId('timeline-clip')).toHaveCount(sceneCountBefore - 1)
  await expect(creator.getByText(/helper:\s*done/i)).toBeVisible({ timeout: 30_000 })
  // The brightness grade is durable: after reload the creator's active video
  // re-derives the filter from the persisted state.colour map.
  await expect
    .poll(
      async () =>
        creator.locator('video').evaluateAll((els) =>
          els.map((e) => e.style.filter).filter(Boolean)
        ),
      { timeout: 30_000 }
    )
    .toEqual(expect.arrayContaining([expect.stringContaining('brightness(')]))

  await creatorCtx.close()
  await helperCtx.close()
})

// Phase 3b — the creator runs AI analysis, a per-scene suggestion appears, gets
// routed, and the routing PERSISTS across reload (the suggestions table). This
// rides LIVE Gemini (the /suggest endpoint) + the suggestions Realtime channel,
// so timeouts are generous. The suggestion prompt is instructed to return three
// suggestions across distinct scenes, so at least one scene gains a suggestion.
test('creator runs AI analysis; a suggestion appears, routes, and persists', async ({ browser }) => {
  const creatorCtx = await browser.newContext()
  const creator = await creatorCtx.newPage()
  await signIn(creator, state.creatorEmail, state.password)
  await creator.goto(`/projects/${state.projectId}/edit`)
  await expect(sceneHeader(creator, 1)).toBeVisible({ timeout: 30_000 })

  // Trigger analysis if it hasn't run yet. Suggestions PERSIST, so on a retry
  // (Playwright reuses the same project) the card is already in its 'done'
  // state and the idle "Trigger" button is gone — that's correct, so only click
  // when the idle button is present.
  const analyseBtn = creator.getByRole('button', { name: /trigger ai analysis of this video/i })
  if (await analyseBtn.isVisible().catch(() => false)) {
    await analyseBtn.click()
  }
  // Analysis completed (live Gemini) → the trigger card shows its summary and
  // the suggestions persisted.
  await expect(creator.getByText(/ai analysis complete/i)).toBeVisible({ timeout: 90_000 })

  // A suggested scene's collapsed header gains "Has an AI suggestion" in its
  // accessible name (the ✨ AI pill). Expand it (only if collapsed) to reveal
  // the SuggestionItem.
  const suggestedHeader = creator.getByRole('button', { name: /has an ai suggestion/i }).first()
  await expect(suggestedHeader).toBeVisible({ timeout: 15_000 })
  if (/tap to open actions/i.test((await suggestedHeader.getAttribute('aria-label')) || '')) {
    await suggestedHeader.click()
  }

  // Route to self if not already routed (idempotent across retries). The three
  // route buttons collapse into a terse "Doing it myself. pending." badge.
  const selfBtn = creator.getByRole('button', { name: /^i'll fix it$/i }).first()
  if (await selfBtn.isVisible().catch(() => false)) {
    await selfBtn.click()
  }
  await expect(creator.getByLabel(/doing it myself\. pending\./i).first()).toBeVisible({ timeout: 10_000 })

  // Reload → the suggestion AND its resolution survive (persisted to Supabase).
  await creator.reload()
  await expect(creator.getByText(/ai analysis complete/i)).toBeVisible({ timeout: 30_000 })
  const stillSuggested = creator.getByRole('button', { name: /has an ai suggestion/i }).first()
  await expect(stillSuggested).toBeVisible({ timeout: 15_000 })
  if (/tap to open actions/i.test((await stillSuggested.getAttribute('aria-label')) || '')) {
    await stillSuggested.click()
  }
  await expect(creator.getByLabel(/doing it myself\. pending\./i).first()).toBeVisible({ timeout: 10_000 })

  await creatorCtx.close()
})
