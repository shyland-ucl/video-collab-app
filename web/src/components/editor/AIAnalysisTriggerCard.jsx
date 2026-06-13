/**
 * Phase 3b — "Analyse with AI" trigger card. Faithful port of the probe's
 * AIAnalysisTriggerCard (video-collab-probe/src/components/probe3) adapted to
 * this app's purple creator accent and wired to the real /suggest endpoint via
 * the parent's onTrigger.
 *
 * Three states (keyed on `status`):
 *   idle      → the purple "✨ Analyse with AI" button (creator only).
 *   analysing → an aria-live=polite card with an aria-hidden animation.
 *   done      → creator: a short "N suggestions now showing in your scenes"
 *               summary; helper: a READ-ONLY list of the curated suggestions
 *               ("available — the creator decides what to do with each").
 *
 * Props:
 *   status         'idle' | 'analysing' | 'done'
 *   suggestionCount number — shown in the creator's done summary
 *   onTrigger      () => void — fires the analysis (creator idle button)
 *   role           'creator' | 'helper'
 *   suggestions    the curated rows (helper read-only list; carries
 *                  { id, category, text, related_scene })
 */

const ACCENT = '#9B59B6'

const CATEGORY_LABEL = { issue: 'Issue', structural: 'Structure', creative: 'Creative' }

export default function AIAnalysisTriggerCard({
  status = 'idle',
  suggestionCount = 0,
  onTrigger,
  role = 'creator',
  suggestions = [],
}) {
  if (status === 'analysing') {
    // aria-live (NOT role="status") so the "analysing" message is announced
    // without VoiceOver speaking the literal role name — this card is the only
    // announcement of the analysing state.
    return (
      <div
        aria-live="polite"
        className="rounded-xl border-2 border-[#9B59B6]/40 bg-[#f5eefa] px-4 py-3 mb-3 flex items-center gap-3"
      >
        <span className="flex gap-1" aria-hidden="true">
          <span className="w-2 h-2 rounded-full bg-[#9B59B6] animate-bounce" style={{ animationDelay: '0ms' }} />
          <span className="w-2 h-2 rounded-full bg-[#9B59B6] animate-bounce" style={{ animationDelay: '120ms' }} />
          <span className="w-2 h-2 rounded-full bg-[#9B59B6] animate-bounce" style={{ animationDelay: '240ms' }} />
        </span>
        <span className="text-sm font-medium text-[#6b3f86]">AI is analysing your video…</span>
      </div>
    )
  }

  if (status === 'done') {
    if (role === 'helper') {
      return (
        <div
          className="rounded-xl border border-[#9B59B6]/30 bg-[#faf6fd] px-4 py-3 mb-3"
          role="region"
          aria-label="AI suggestions visible to the creator"
        >
          <p className="text-xs font-bold uppercase tracking-wide text-[#6b3f86] mb-2">
            AI suggestions — the creator decides what to do with each
          </p>
          {suggestions.length === 0 ? (
            <p className="text-sm text-gray-500">No suggestions.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {suggestions.map((s) => (
                <li key={s.id} className="text-sm text-gray-800 flex flex-col gap-0.5">
                  <span className="flex items-center gap-2" aria-hidden="true">
                    <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-[#ece1f5] text-[#6b3f86]">
                      {CATEGORY_LABEL[s.category] ?? s.category}
                    </span>
                    <span className="text-xs text-gray-500">{s.sceneLabel || `Scene ${(s.related_scene ?? 0) + 1}`}</span>
                  </span>
                  <span>{s.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )
    }
    // Visual-only summary (NOT a live region): the completion is announced once
    // by EditorPage.onAnalyse via the shared announcer, so a role="status" here
    // would double-announce — and re-announce on every reload of a project that
    // already has suggestions.
    return (
      <div className="rounded-xl border border-[#9B59B6]/30 bg-[#faf6fd] px-4 py-3 mb-3">
        <p className="text-sm font-medium text-[#6b3f86]">
          AI analysis complete. {suggestionCount} suggestion{suggestionCount === 1 ? '' : 's'} now showing in your scenes.
        </p>
      </div>
    )
  }

  // idle — only the creator can trigger analysis.
  if (role === 'helper') return null
  return (
    <button
      type="button"
      onClick={onTrigger}
      aria-label="Trigger AI analysis of this video"
      className="w-full mb-3 py-3 rounded-xl text-white text-sm font-bold transition-colors focus:outline-2 focus:outline-offset-2 focus:outline-blue-500 hover:opacity-90"
      style={{ backgroundColor: ACCENT, minHeight: '48px' }}
    >
      ✨ Analyse with AI
    </button>
  )
}
