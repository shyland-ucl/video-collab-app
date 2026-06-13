import { serverPost } from '../serverApi'

// Phase 3b — client access to the persisted `suggestions` table + the generation
// endpoint. Mirrors tasksApi.js: thin functions, supabase passed in, RLS-scoped.

// Trigger generation: the server runs Gemini, persists the curated set (replacing
// any prior set for this video), and returns the persisted rows (with db ids).
export async function requestSuggestions(projectId, videoId) {
  const data = await serverPost(`/api/projects/${projectId}/suggest`, { videoId })
  return data?.suggestions ?? []
}

// All persisted suggestions for a project (across any analysed videos) — the
// editor loads these on open and keeps them in sync over Realtime.
export async function listProjectSuggestions(supabase, projectId) {
  const { data, error } = await supabase
    .from('suggestions')
    .select(
      'id, project_id, video_id, model_suggestion_id, category, text, related_scene, segment_id, prototype_action, fix_template, routed_to, outcome_status, task_id, created_at'
    )
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return data ?? []
}

// Record a routing decision (creator only). taskId links a helper-routed
// suggestion to its task so the badge can flip when the task resolves.
export async function setSuggestionResolution(supabase, id, { routedTo, outcomeStatus, taskId = null, userId }) {
  const { data, error } = await supabase
    .from('suggestions')
    .update({
      routed_to: routedTo,
      outcome_status: outcomeStatus,
      task_id: taskId,
      resolved_at: new Date().toISOString(),
      resolved_by: userId ?? null,
    })
    .eq('id', id)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

// Flip just the outcome — used when a linked helper task's status changes.
export async function updateSuggestionOutcome(supabase, id, outcomeStatus) {
  const { data, error } = await supabase
    .from('suggestions')
    .update({ outcome_status: outcomeStatus })
    .eq('id', id)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}
