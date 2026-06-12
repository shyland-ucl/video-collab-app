// splitClip keeps the original id on the first piece and appends
// '-split-<timestamp>-<base36seq>' to the second; descriptions live on the
// root segment id. Keep this regex in sync with web stateStore.rootSegmentId.
export function rootSegmentIds(clips) {
  const map = {}
  for (const c of clips) map[c.id] = c.id.replace(/(-split-\d+-[0-9a-z]+)+$/, '')
  return map
}

export async function loadLevel1Descriptions(supabase, idMap) {
  const rootIds = [...new Set(Object.values(idMap))]
  const { data } = await supabase
    .from('descriptions')
    .select('segment_id, text, level')
    .in('segment_id', rootIds)
  const byRoot = {}
  for (const row of data ?? []) if (row.level === 1) byRoot[row.segment_id] = row.text
  const byClip = {}
  for (const [clipId, rootId] of Object.entries(idMap)) byClip[clipId] = byRoot[rootId]
  return byClip
}
