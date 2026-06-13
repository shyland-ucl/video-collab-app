// Inputs a render needs from the DB. Project-scoped, read-only.

// The project's source originals (ready videos) the EDL clips reference.
// Returns [{ id, storage_path }].
export async function loadProjectSources(supabase, projectId) {
  const { data, error } = await supabase
    .from('videos')
    .select('id, storage_path, status')
    .eq('project_id', projectId)
    .eq('status', 'ready')
  if (error) throw new Error(`sources_query_failed: ${error.message}`)
  return (data ?? []).map((v) => ({ id: v.id, storage_path: v.storage_path }))
}
