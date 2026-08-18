/**
 * Phase 3b — one AI suggestion rendered inside its scene block. Faithful port of
 * the probe's SuggestionItem (video-collab-probe/src/components/probe3/
 * Probe3SceneActions.jsx): the suggestion text plus three mandatory routing
 * buttons (no dismiss — every suggestion is routed), which collapse into a
 * resolution badge once routed.
 *
 * Props:
 *   suggestion    { id, category, text, related_scene } (the persisted row)
 *   helperName    label for the helper route button (default 'helper')
 *   resolution    { routedTo: 'self'|'helper'|'ai', outcomeStatus: 'pending'|'applied'|'failed' } | null
 *   onRouteSelf / onRouteHelper / onRouteAI  () => void
 *
 * Accessibility (probe parity):
 *   - category badge + "Scene N" chip are aria-hidden so the suggestion TEXT is
 *     read exactly once;
 *   - three full-width >=44px buttons with focus rings;
 *   - once routed, the buttons are replaced by a badge whose container has a
 *     terse aria-label ("Routed to AI. Applied.") so a focus landing reads only
 *     routing + outcome, never the full suggestion text again.
 */

const CATEGORY = {
  issue: { label: 'Issue', cls: 'bg-danger-soft text-danger' },
  structural: { label: 'Structure', cls: 'bg-brand-soft text-brand' },
  creative: { label: 'Creative', cls: 'bg-creator-soft text-creator' },
}

const ROUTED_LABEL = { self: 'Doing it myself', helper: 'Routed to', ai: 'Routed to AI' }
const ROUTED_CLS = { self: 'bg-brand-soft text-brand', helper: 'bg-helper-soft text-helper', ai: 'bg-creator-soft text-creator' }
const OUTCOME_LABEL = { pending: 'pending', applied: 'applied', failed: 'failed' }
const OUTCOME_CLS = { pending: 'bg-helper-soft text-helper', applied: 'bg-success/15 text-success', failed: 'bg-danger-soft text-danger' }

export default function SuggestionItem({
  suggestion,
  helperName = 'helper',
  // The scene's REAL timeline name (e.g. "Scene 6"), so the spoken/visible scene
  // matches the SceneBlock header. Falls back to the per-video index + 1 only
  // when a caller can't resolve the clip.
  sceneLabel,
  resolution = null,
  onRouteSelf,
  onRouteHelper,
  onRouteAI,
}) {
  if (!suggestion) return null
  const cat = CATEGORY[suggestion.category] ?? { label: suggestion.category, cls: 'bg-sunken text-ink-soft' }
  const sceneName = sceneLabel || `Scene ${(suggestion.related_scene ?? 0) + 1}`

  // Routed → resolution badge (buttons gone). Terse aria-label only. The
  // data-suggestion-resolution hook lets the parent move focus here after
  // routing (the buttons unmount), so focus isn't dropped to <body>.
  if (resolution?.routedTo) {
    const routedText =
      resolution.routedTo === 'helper' ? `Routed to ${helperName}` : ROUTED_LABEL[resolution.routedTo]
    const outcome = OUTCOME_LABEL[resolution.outcomeStatus] ?? 'pending'
    return (
      <div
        tabIndex={-1}
        data-suggestion-resolution={suggestion.id}
        aria-label={`${routedText}. ${outcome}.`}
        className="rounded-lg border border-creator/30 bg-creator-soft px-3 py-2 mb-2"
      >
        <p className="text-sm text-ink mb-1" aria-hidden="true">{suggestion.text}</p>
        <div className="flex items-center gap-2" aria-hidden="true">
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${ROUTED_CLS[resolution.routedTo] ?? 'bg-sunken'}`}>
            {routedText}
          </span>
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${OUTCOME_CLS[resolution.outcomeStatus] ?? 'bg-sunken'}`}>
            {outcome}
          </span>
        </div>
      </div>
    )
  }

  // Unrouted → suggestion + 3 routing buttons.
  return (
    <div
      role="group"
      aria-label={`AI suggestion for ${sceneName}`}
      className="rounded-lg border-2 border-creator/40 bg-surface px-3 py-3 mb-2 flex flex-col gap-2"
    >
      <div className="flex items-center gap-2" aria-hidden="true">
        <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${cat.cls}`}>
          {cat.label}
        </span>
        <span className="text-xs text-ink-soft">{sceneName}</span>
      </div>
      <p className="text-sm font-medium text-ink">{suggestion.text}</p>
      <button
        type="button"
        onClick={onRouteSelf}
        className="w-full py-2.5 rounded-lg bg-brand text-sm font-bold text-on-brand hover:bg-brand-strong"
        style={{ minHeight: '44px' }}
      >
        I&apos;ll fix it
      </button>
      <button
        type="button"
        onClick={onRouteHelper}
        className="w-full rounded-lg bg-helper py-2.5 text-sm font-bold text-on-accent hover:opacity-90"
        style={{ minHeight: '44px' }}
      >
        Ask {helperName} to fix it
      </button>
      <button
        type="button"
        onClick={onRouteAI}
        className="w-full rounded-lg py-2.5 text-sm font-bold bg-creator text-on-accent hover:opacity-90"
        style={{ minHeight: '44px' }}
      >
        Ask AI to fix it
      </button>
    </div>
  )
}
