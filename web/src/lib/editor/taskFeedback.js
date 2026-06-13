/**
 * Helper task-status feedback wording (ported from the probe's
 * video-collab-probe/src/utils/taskFeedback.js).
 *
 * buildHelperTaskStatusUpdate(task, status, helperLabel) builds the
 * scene-named, task-named announcement the creator hears when a helper resolves
 * a task — e.g. "Your helper finished the task for Scene 3. Task: trim the
 * intro." Naming the task (text + segment label) lets a creator with several
 * outstanding tasks know which one resolved, replacing the old terse
 * "Your helper marked a task needs discussion".
 *
 * Stripped per the adaptation contract: the probe's study-only feed-item
 * scaffolding (it returned id/taskId/taskStatus for the activity feed). Only
 * the `announcement` string is consumed by THIS app's onTaskChange path, but
 * the other fields are kept for parity / future reuse.
 *
 * Status map (matches the app's tasks.status values done/needs_discussion/
 * cant_do):
 *   done            → "finished the task …"
 *   needs_discussion→ "needs discussion the task …"  (probe wording, verbatim)
 *   cant_do         → "cannot complete the task …"
 */

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

// The app's task carries the scene name on `segment_label` (snake_case, see
// tasksApi). The probe used `segment` / `segmentName`; accept all three so the
// port works against either shape.
function taskTarget(task = {}) {
  const segment = cleanText(task.segment_label || task.segment || task.segmentName);
  return segment ? ` for ${segment}` : '';
}

export function helperTaskStatusLabel(status) {
  switch (status) {
    case 'done':
      return 'finished';
    case 'needs_discussion':
      return 'needs discussion';
    case 'cant_do':
      return 'cannot complete';
    default:
      return 'updated';
  }
}

export function buildHelperTaskStatusUpdate(task, status, helperLabel = 'Helper') {
  const label = helperTaskStatusLabel(status);
  const target = taskTarget(task);
  const taskText = cleanText(task?.text || task?.instruction);
  const actionText = `${label} the task${target}`;
  const promptText = taskText ? `Task: ${taskText}` : 'Review the helper task status.';

  return {
    actionText,
    shortText: `${helperLabel} ${actionText}`,
    promptText,
    overviewText: '',
    announcement: `${helperLabel} ${actionText}. ${promptText}`,
    taskId: task?.id || null,
    taskStatus: status,
  };
}
