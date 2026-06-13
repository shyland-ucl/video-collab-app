# Phase 2 — Autonomous Slice Design (built overnight, pending user review)

**Date:** 2026-06-13
**Status:** Built autonomously while the user slept (standing instruction: "build other things for phase 2 and phase3 as much as possible"). NOT yet user-reviewed. The taste-heavy parts of Phase 2 (visual/UX redesign of the two devices) are deliberately NOT in here — those need design dialogue.

## What Phase 2 is (from the parent spec)
Product UX: one coherent creator + helper experience; accessibility settings; project_state pruning; friendly-error sweep; visual/UX redesign.

## What is safe to build without design approval (this slice)
Only additive, low-risk work that exposes existing capability or hardens existing behavior — nothing that decides product look/feel:

1. **Accessibility settings page** (this doc's focus). The `AccessibilityContext` already holds `textSize` (small/medium/large), `audioEnabled` (bool), `speechRate` (0.5–3, default 1.2) with validated localStorage persistence and setters `setTextSize/toggleAudio/setSpeechRate`. The editor already consumes these (TTS rate, audio gating, text scale). What's missing is a UI to change them. This is pure exposure of built capability — no taste decisions.

2. (Deferred, noted only) friendly-error sweep, project_state pruning job — see roadmap; project_state pruning touches LIVE data so it must be reviewed before running.

## Accessibility settings page — design

- **Route:** `/settings` (RequireAuth), reachable from a "Settings" link in the header area of ProjectsPage (the app's home), and a back link to projects.
- **Provider hoist (prerequisite):** `AccessibilityProvider` currently wraps only `EditorPage`'s output (added in the 1c Playwright bug-fix). Move it up to wrap the whole authenticated app in `App.jsx` so the settings page and the editor share ONE provider and changes take effect everywhere; remove the EditorPage-local wrap. EditorPage tests that render the page directly must wrap in `AccessibilityProvider` (or the page keeps rendering through a test helper) — keep all tests green.
- **Controls (standard accessible form, mobile-first, matches house Tailwind style):**
  - Text size: radio group (Small / Medium / Large) → `setTextSize`. Apply the chosen size as a class on the settings page's own content so the user hears+sees the effect immediately.
  - Spoken descriptions (audio): a labelled toggle (checkbox/switch) → `toggleAudio`; announce the new state.
  - Speech rate: a slider 0.5–2.0 step 0.1 (default 1.2) → `setSpeechRate`; on change, speak a short sample line ("This is how fast descriptions will be read.") via `ttsService` so the user can calibrate by ear; announce the numeric rate.
- **Accessibility:** `<main id="main" tabIndex={-1}>`, a `<form>`/`<fieldset>`+`<legend>` per group, `role=status`/`announce()` for changes, min-h-12 touch targets, labels associated, keyboard-operable. No new colors/branding (defer to the redesign).
- **Persistence:** already handled by the context (debounced localStorage). No new storage.
- **Out of scope:** high-contrast/theme (stripped from context; a redesign concern), any visual restyle of existing pages.

## Testing
- Vitest: settings page renders the three controls from context defaults; changing each calls the right setter; speech-rate change calls ttsService.speak the sample; announcements fire. Mock useAccessibility + ttsService + announcer (house pattern).
- App route test: `/settings` renders behind RequireAuth; ProjectsPage shows the Settings link.
- Keep the provider-hoist green across EditorPage + existing suites.

## Acceptance
A signed-in user opens Settings from the home page, changes text size / audio / speech rate by keyboard or touch with audible confirmation, and those settings take effect in the editor (TTS rate, audio gating, text scale) and persist across reloads.
