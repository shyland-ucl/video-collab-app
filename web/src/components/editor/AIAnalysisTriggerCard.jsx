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
        className="rounded-xl border-2 border-creator/40 bg-creator-soft px-4 py-3 mb-3 flex items-center gap-3"
      >
        <span className="flex gap-1" aria-hidden="true">
          <span className="w-2 h-2 rounded-full bg-creator animate-bounce" style={{ animationDelay: '0ms' }} />
          <span className="w-2 h-2 rounded-full bg-creator animate-bounce" style={{ animationDelay: '120ms' }} />
          <span className="w-2 h-2 rounded-full bg-creator animate-bounce" style={{ animationDelay: '240ms' }} />
        </span>
        <span className="text-sm font-medium text-creator">AI is analysing your video…</span>
      </div>
    )
  }

  if (status === 'done') {
    if (role === 'helper') {
      return (
        <div
          className="rounded-xl border border-creator/30 bg-creator-soft px-4 py-3 mb-3"
          role="region"
          aria-label="AI suggestions visible to the creator"
        >
          <p className="text-xs font-bold uppercase tracking-wide text-creator mb-2">
            AI suggestions — the creator decides what to do with each
          </p>
          {suggestions.length === 0 ? (
            <p className="text-sm text-ink-soft">No suggestions.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {suggestions.map((s) => (
                <li key={s.id} className="text-sm text-ink flex flex-col gap-0.5">
                  <span className="flex items-center gap-2" aria-hidden="true">
                    <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-creator-soft text-creator">
                      {CATEGORY_LABEL[s.category] ?? s.category}
                    </span>
                    <span className="text-xs text-ink-soft">{s.sceneLabel || `Scene ${(s.related_scene ?? 0) + 1}`}</span>
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
      <div className="rounded-xl border border-creator/30 bg-creator-soft px-4 py-3 mb-3">
        <p className="text-sm font-medium text-creator">
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
      className="w-full mb-3 py-3 rounded-xl bg-creator text-on-accent text-sm font-bold transition-colors hover:opacity-90"
      style={{ minHeight: '48px' }}
    >
      ✨ Analyse with AI
    </button>
  )
}
