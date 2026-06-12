export async function createTask(supabase, { projectId, userId, text, segmentLabel }) {
  const { data, error } = await supabase
    .from('tasks')
    .insert({ project_id: projectId, created_by: userId, text, segment_label: segmentLabel ?? null })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function setTaskStatus(supabase, taskId, status) {
  const { data, error } = await supabase
    .from('tasks')
    .update({ status })
    .eq('id', taskId)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function listTasks(supabase, projectId) {
  const { data, error } = await supabase
    .from('tasks')
    .select('id, text, segment_label, status, created_by, created_at, updated_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data ?? []
}
