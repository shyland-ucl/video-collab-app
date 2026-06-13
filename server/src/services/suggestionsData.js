// Load a video's ordered scenes + per-level descriptions + keyframe images for
// the suggestion engine. Project-scoped and ready-gated so a member can never
// pull another project's video or an unprocessed one. Read-only.
const MAX_SCENES = 40

export async function loadVideoForSuggestions(supabase, projectId, videoId, deps = {}) {
  const { maxScenes = MAX_SCENES } = deps

  const { data: video, error: vErr } = await supabase
    .from('videos').select('id, project_id, status').eq('id', videoId).maybeSingle()
  if (vErr || !video || video.project_id !== projectId) return { error: 'video_not_found' }
  if (video.status !== 'ready') return { error: 'video_not_ready' }

  const { data: segRows, error: sErr } = await supabase
    .from('segments')
    .select('id, idx, start_seconds, end_seconds, label, keyframe_path')
    .eq('video_id', videoId)
    .order('idx', { ascending: true })
  if (sErr) return { error: 'segments_query_failed' }
  const segments = segRows ?? []
  if (!segments.length) return { error: 'no_segments' }

  const truncated = segments.length > maxScenes
  const used = truncated ? segments.slice(0, maxScenes) : segments

  const ids = used.map((s) => s.id)
  const { data: descRows, error: dErr } = await supabase
    .from('descriptions').select('segment_id, level, text').in('segment_id', ids)
  if (dErr) return { error: 'descriptions_query_failed' }
  const byId = {}
  for (const r of descRows ?? []) {
    byId[r.segment_id] ??= {}
    byId[r.segment_id][r.level] = r.text
  }

  const scenes = used.map((s) => ({
    idx: s.idx,
    start_seconds: s.start_seconds,
    end_seconds: s.end_seconds,
    label: s.label,
    level1: byId[s.id]?.[1] ?? '',
    level2: byId[s.id]?.[2] ?? '',
    level3: byId[s.id]?.[3] ?? '',
  }))

  const keyframes = []
  for (const s of used) {
    if (!s.keyframe_path) { keyframes.push(null); continue }
    const { data: blob, error } = await supabase.storage.from('videos').download(s.keyframe_path)
    if (error || !blob) { keyframes.push(null); continue }
    keyframes.push(Buffer.from(await blob.arrayBuffer()).toString('base64'))
  }

  return { scenes, keyframes, truncated, totalScenes: segments.length }
}
