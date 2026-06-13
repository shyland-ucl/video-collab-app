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
  issue: { label: 'Issue', cls: 'bg-red-100 text-red-700' },
  structural: { label: 'Structure', cls: 'bg-blue-100 text-blue-700' },
  creative: { label: 'Creative', cls: 'bg-purple-100 text-purple-700' },
}

const ROUTED_LABEL = { self: 'Doing it myself', helper: 'Routed to', ai: 'Routed to AI' }
const ROUTED_CLS = { self: 'bg-blue-100 text-blue-800', helper: 'bg-orange-100 text-orange-800', ai: 'bg-purple-100 text-purple-800' }
const OUTCOME_LABEL = { pending: 'pending', applied: 'applied', failed: 'failed' }
const OUTCOME_CLS = { pending: 'bg-amber-100 text-amber-800', applied: 'bg-green-100 text-green-800', failed: 'bg-red-100 text-red-800' }

export default function SuggestionItem({
  suggestion,
  helperName = 'helper',
  resolution = null,
  onRouteSelf,
  onRouteHelper,
  onRouteAI,
}) {
  if (!suggestion) return null
  const cat = CATEGORY[suggestion.category] ?? { label: suggestion.category, cls: 'bg-gray-100 text-gray-700' }
  const sceneNo = (suggestion.related_scene ?? 0) + 1

  // Routed → resolution badge (buttons gone). Terse aria-label only.
  if (resolution?.routedTo) {
    const routedText =
      resolution.routedTo === 'helper' ? `Routed to ${helperName}` : ROUTED_LABEL[resolution.routedTo]
    const outcome = OUTCOME_LABEL[resolution.outcomeStatus] ?? 'pending'
    return (
      <div
        tabIndex={-1}
        aria-label={`${routedText}. ${outcome}.`}
        className="rounded-lg border border-[#9B59B6]/30 bg-[#faf6fd] px-3 py-2 mb-2"
      >
        <p className="text-sm text-gray-800 mb-1" aria-hidden="true">{suggestion.text}</p>
        <div className="flex items-center gap-2" aria-hidden="true">
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${ROUTED_CLS[resolution.routedTo] ?? 'bg-gray-100'}`}>
            {routedText}
          </span>
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${OUTCOME_CLS[resolution.outcomeStatus] ?? 'bg-gray-100'}`}>
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
      aria-label={`AI suggestion for scene ${sceneNo}`}
      className="rounded-lg border-2 border-[#9B59B6]/40 bg-white px-3 py-3 mb-2 flex flex-col gap-2"
    >
      <div className="flex items-center gap-2" aria-hidden="true">
        <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${cat.cls}`}>
          {cat.label}
        </span>
        <span className="text-xs text-gray-500">Scene {sceneNo}</span>
      </div>
      <p className="text-sm font-medium text-gray-900">{suggestion.text}</p>
      <button
        type="button"
        onClick={onRouteSelf}
        className="w-full py-2.5 rounded-lg bg-blue-600 text-sm font-bold text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-1"
        style={{ minHeight: '44px' }}
      >
        I&apos;ll fix it
      </button>
      <button
        type="button"
        onClick={onRouteHelper}
        className="w-full py-2.5 rounded-lg bg-orange-500 text-sm font-bold text-white hover:bg-orange-600 focus:outline-none focus:ring-2 focus:ring-orange-400 focus:ring-offset-1"
        style={{ minHeight: '44px' }}
      >
        Ask {helperName} to fix it
      </button>
      <button
        type="button"
        onClick={onRouteAI}
        className="w-full py-2.5 rounded-lg text-sm font-bold text-white hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[#9B59B6] focus:ring-offset-1"
        style={{ backgroundColor: '#9B59B6', minHeight: '44px' }}
      >
        Ask AI to fix it
      </button>
    </div>
  )
}
