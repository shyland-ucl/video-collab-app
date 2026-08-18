// Ported from probe src/components/probe3/ActivityFeed.jsx (Task 10).
//
// Stripped per the adaptation contract:
// - AWARENESS_VIEWED engagement telemetry: onAwarenessViewed, emitAwareness,
//   the per-entry debounce ref, truncate(), the focus/click handlers — all the
//   research instrumentation is gone
// - suggestion_task and ai_edit item branches + onAIReview / onAIUndo /
//   onSuggestionResponse — Phase 3, deleted
// - itemEntryActor — telemetry only
//
// Adapted: the probe received an assembled `feedItems` array. Here the feed is
// derived from the `tasks` prop by HelperDevice — pending tasks become
// actionable items with the three status buttons; done / needs_discussion /
// cant_do render as history pills. Status changes call onSetTaskStatus(id,
// status) with the production strings ('done' / 'needs_discussion' /
// 'cant_do'); EditorPage announces them, so this component never does.
// `creatorActivities` is the running list of the creator's broadcast activity.

const STATUS_PILL = {
  done: { label: 'Done', cls: 'bg-success/15 text-success' },
  needs_discussion: { label: 'Needs Discussion', cls: 'bg-helper-soft text-helper' },
  cant_do: { label: "Can't Do", cls: 'bg-danger-soft text-danger' },
}

export default function ActivityFeed({ tasks = [], creatorActivities = [], onSetTaskStatus }) {
  const handleStatus = (taskId, status) => {
    onSetTaskStatus?.(taskId, status)
  }

  return (
    <div>
      {tasks.length > 0 ? (
        <div className="divide-y divide-line">
          {tasks.map((task) => (
            <div key={task.id} className="px-4 py-3 rounded" role="article">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-xs font-bold text-helper uppercase">From Creator</span>
              </div>
              <p className="text-sm text-ink mb-2">{task.text}</p>
              {task.segment_label && (
                <p className="text-xs text-ink-soft mb-2">Clip: {task.segment_label}</p>
              )}
              {task.status === 'pending' ? (
                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => handleStatus(task.id, 'done')}
                    className="flex-1 rounded-lg bg-success py-2 text-xs font-semibold text-on-accent hover:opacity-90"
                    style={{ minHeight: '48px' }}
                    aria-label={`Mark done: ${task.text}`}
                  >
                    Mark Done
                  </button>
                  <button
                    onClick={() => handleStatus(task.id, 'needs_discussion')}
                    className="flex-1 rounded-lg bg-helper py-2 text-xs font-semibold text-on-accent hover:opacity-90"
                    style={{ minHeight: '48px' }}
                    aria-label={`Needs discussion: ${task.text}`}
                  >
                    Needs Discussion
                  </button>
                  <button
                    onClick={() => handleStatus(task.id, 'cant_do')}
                    className="flex-1 rounded-lg bg-danger py-2 text-xs font-semibold text-on-accent hover:opacity-90"
                    style={{ minHeight: '48px' }}
                    aria-label={`Can't do: ${task.text}`}
                  >
                    Can't Do
                  </button>
                </div>
              ) : (
                <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_PILL[task.status]?.cls ?? 'bg-sunken text-ink-soft'}`}>
                  {STATUS_PILL[task.status]?.label ?? task.status}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="px-4 py-3">
          <p className="text-sm text-ink-faint italic">No tasks yet</p>
        </div>
      )}

      {/* Creator Activity — running list of the creator's broadcast actions. */}
      <div className="px-4 py-3 bg-creator-soft border-t border-creator/30">
        <div className="font-semibold text-creator text-xs uppercase tracking-wide mb-2">Creator Activity</div>
        {creatorActivities.length > 0 ? (
          <ul className="space-y-1 max-h-32 overflow-y-auto">
            {creatorActivities.slice(-10).reverse().map((a) => (
              <li key={a.key} className="text-xs text-ink-soft rounded" role="article">
                {a.detail ? `${a.action} ${a.detail}` : a.action}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-ink-faint italic">No activity yet</p>
        )}
      </div>
    </div>
  )
}
