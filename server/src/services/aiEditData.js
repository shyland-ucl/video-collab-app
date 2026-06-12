// splitClip keeps the original id on the first piece and appends
// '-split-<timestamp>-<base36seq>' to the second; descriptions live on the
// root segment id. Keep this regex in sync with web stateStore.rootSegmentId.
export function rootSegmentIds(clips) {
  const map = {}
  for (const c of clips) map[c.id] = c.id.replace(/(-split-\d+-[0-9a-z]+)+$/, '')
  return map
}

export async function loadLevel1Descriptions(supabase, projectId, idMap) {
  const rootIds = [...new Set(Object.values(idMap))]
  const { data: owned, error: ownErr } = await supabase
    .from('segments')
    .select('id, videos!inner(project_id)')
    .in('id', rootIds)
    .eq('videos.project_id', projectId)
  if (ownErr) {
    console.error('aiEdit: segment ownership query failed:', ownErr.message)
    return {}
  }
  const ownedIds = new Set((owned ?? []).map((s) => s.id))
  if (!ownedIds.size) return {}
  const { data, error } = await supabase
    .from('descriptions')
    .select('segment_id, text, level')
    .in('segment_id', [...ownedIds])
  if (error) {
    console.error('aiEdit: descriptions query failed:', error.message)
    return {}
  }
  const byRoot = {}
  for (const row of data ?? []) if (row.level === 1) byRoot[row.segment_id] = row.text
  const byClip = {}
  for (const [clipId, rootId] of Object.entries(idMap)) {
    if (byRoot[rootId] !== undefined) byClip[clipId] = byRoot[rootId]
  }
  return byClip
}
