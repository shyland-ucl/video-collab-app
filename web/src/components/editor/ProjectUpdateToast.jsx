// Ported from probe src/components/shared/ProjectUpdateToast.jsx (Task 10).
// Nothing stripped — purely presentational. EditorPage owns the announce() for
// remote changes; this toast is the visible mirror the helper sees when the
// creator edits. `update` is a summarizeEditStateChange() result.

export default function ProjectUpdateToast({ update, onDismiss, accentColor = '#1F3864' }) {
  if (!update) return null

  return (
    <div
      className="fixed left-3 right-3 top-3 z-40 mx-auto max-w-md rounded-xl border border-slate-200 bg-white p-3 shadow-xl"
      aria-label="Project update"
    >
      <div className="flex items-start gap-3">
        <span
          className="mt-1 h-2.5 w-2.5 flex-shrink-0 rounded-full"
          style={{ backgroundColor: accentColor }}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-slate-900">
            {update.shortText || update.actionText || 'Project updated'}
          </p>
          {(update.promptText || update.overviewText) && (
            <p className="mt-0.5 text-xs leading-relaxed text-slate-600">
              {[update.promptText, update.overviewText].filter(Boolean).join(' ')}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-md px-2 py-1 text-xs font-bold text-slate-600 hover:bg-slate-100 focus:outline-2 focus:outline-offset-2 focus:outline-blue-500"
          style={{ minHeight: '32px', minWidth: '44px' }}
          aria-label="Dismiss project update"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
