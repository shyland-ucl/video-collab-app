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
  done: { label: 'Done', cls: 'bg-green-100 text-green-700' },
  needs_discussion: { label: 'Needs Discussion', cls: 'bg-amber-100 text-amber-700' },
  cant_do: { label: "Can't Do", cls: 'bg-red-100 text-red-700' },
}

export default function ActivityFeed({ tasks = [], creatorActivities = [], onSetTaskStatus }) {
  const handleStatus = (taskId, status) => {
    onSetTaskStatus?.(taskId, status)
  }

  return (
    <div>
      {tasks.length > 0 ? (
        <div className="divide-y divide-gray-100">
          {tasks.map((task) => (
            <div key={task.id} className="px-4 py-3 rounded" role="article">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-xs font-bold text-orange-600 uppercase">From Creator</span>
              </div>
              <p className="text-sm text-gray-800 mb-2">{task.text}</p>
              {task.segment_label && (
                <p className="text-xs text-gray-500 mb-2">Clip: {task.segment_label}</p>
              )}
              {task.status === 'pending' ? (
                <div className="flex gap-2">
                  <button
                    onClick={() => handleStatus(task.id, 'done')}
                    className="flex-1 py-2 rounded-lg bg-green-500 text-white text-xs font-semibold hover:bg-green-600 focus:outline-none focus:ring-2 focus:ring-green-400 focus:ring-offset-1"
                    style={{ minHeight: '48px' }}
                    aria-label={`Mark done: ${task.text}`}
                  >
                    Mark Done
                  </button>
                  <button
                    onClick={() => handleStatus(task.id, 'needs_discussion')}
                    className="flex-1 py-2 rounded-lg bg-amber-500 text-white text-xs font-semibold hover:bg-amber-600 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:ring-offset-1"
                    style={{ minHeight: '48px' }}
                    aria-label={`Needs discussion: ${task.text}`}
                  >
                    Needs Discussion
                  </button>
                  <button
                    onClick={() => handleStatus(task.id, 'cant_do')}
                    className="flex-1 py-2 rounded-lg bg-red-500 text-white text-xs font-semibold hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-400 focus:ring-offset-1"
                    style={{ minHeight: '48px' }}
                    aria-label={`Can't do: ${task.text}`}
                  >
                    Can't Do
                  </button>
                </div>
              ) : (
                <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_PILL[task.status]?.cls ?? 'bg-gray-100 text-gray-600'}`}>
                  {STATUS_PILL[task.status]?.label ?? task.status}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="px-4 py-3">
          <p className="text-sm text-gray-400 italic">No tasks yet</p>
        </div>
      )}

      {/* Creator Activity — running list of the creator's broadcast actions. */}
      <div className="px-4 py-3 bg-[#f3e8ff] border-t border-[#e9d5ff]">
        <div className="font-semibold text-[#7c3aed] text-xs uppercase tracking-wide mb-2">Creator Activity</div>
        {creatorActivities.length > 0 ? (
          <ul className="space-y-1 max-h-32 overflow-y-auto">
            {creatorActivities.slice(-10).reverse().map((a) => (
              <li key={a.key} className="text-xs text-gray-600 rounded" role="article">
                {a.detail ? `${a.action} ${a.detail}` : a.action}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-gray-400 italic">No activity yet</p>
        )}
      </div>
    </div>
  )
}
