// Server-side read of the latest project_state (the EDL). Mirrors the web
// stateStore.loadLatestState — selects the highest-version row for a project.
export async function loadLatestState(supabase, projectId) {
  const { data, error } = await supabase
    .from('project_state')
    .select('version, state')
    .eq('project_id', projectId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`state_load_failed: ${error.message}`)
  return data ?? null
}
