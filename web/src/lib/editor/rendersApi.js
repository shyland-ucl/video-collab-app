import { serverPost } from '../serverApi'

// Phase 4 — client access to the render job + its persisted row.

// Trigger a render: the server validates the EDL, creates a renders row, and
// runs the job async. Returns the renderId.
export async function requestRender(projectId) {
  const data = await serverPost(`/api/projects/${projectId}/render`)
  return data?.renderId ?? null
}

// The newest render for a project (any status) — loaded on editor open.
export async function latestRender(supabase, projectId) {
  const { data, error } = await supabase
    .from('renders')
    .select('id, project_id, status, output_path, error, edl_version, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false }) // deterministic tiebreak on equal timestamps
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data ?? null
}

// A short-lived signed download URL for a ready render's output object.
export async function renderDownloadUrl(supabase, outputPath) {
  if (!outputPath) return null
  const { data, error } = await supabase.storage.from('videos').createSignedUrl(outputPath, 3600)
  if (error) throw new Error(error.message)
  return data?.signedUrl ?? null
}
