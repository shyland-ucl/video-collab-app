export const SCENE_COLORS = ['#E74C3C', '#3498DB', '#2ECC71', '#9B59B6', '#E67E22', '#16A085', '#D35400', '#2C3E50']

export function buildInitialState(videos, segments) {
  const videoOrder = [...videos].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
  const orderIndex = new Map(videoOrder.map((v, i) => [v.id, i]))
  const ordered = [...segments].sort(
    (a, b) => (orderIndex.get(a.video_id) - orderIndex.get(b.video_id)) || (a.idx - b.idx)
  )
  return {
    clips: ordered.map((seg, i) => ({
      id: seg.id,
      sourceId: seg.video_id,
      name: `Scene ${i + 1}`,
      startTime: Number(seg.start_seconds),
      endTime: Number(seg.end_seconds),
      trimStart: 0,
      trimEnd: 0,
      color: SCENE_COLORS[i % SCENE_COLORS.length],
      muted: false,
    })),
    captions: [],
    textOverlays: [],
    colour: {},
  }
}

// Split clips get '-a'/'-b' suffixes; descriptions live on the root segment.
export function rootSegmentId(clipId) {
  return clipId.replace(/(-[ab])+$/, '')
}

export async function loadLatestState(supabase, projectId) {
  const { data } = await supabase
    .from('project_state')
    .select('version, state')
    .eq('project_id', projectId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data ?? null
}

export async function saveState(supabase, projectId, userId, state, expectedVersion) {
  const version = (expectedVersion ?? 0) + 1
  const { error } = await supabase
    .from('project_state')
    .insert({ project_id: projectId, version, state, updated_by: userId })
    .select()
    .single()
  if (error?.code === '23505') return { ok: false, conflict: true }
  if (error) return { ok: false, error: error.message }
  return { ok: true, version }
}

// applyOp(state) must be a pure function that re-derives the local change on
// top of any state — that is what makes the rebase correct.
export async function saveWithRebase(supabase, projectId, userId, applyOp, localState, expectedVersion) {
  const first = await saveState(supabase, projectId, userId, localState, expectedVersion)
  if (first.ok) return { ...first, state: localState }
  if (!first.conflict) return first

  const latest = await loadLatestState(supabase, projectId)
  if (!latest) return { ok: false, error: 'state_vanished' }
  const rebased = applyOp(latest.state)
  const second = await saveState(supabase, projectId, userId, rebased, latest.version)
  if (second.ok) return { ...second, state: rebased }
  return { ok: false, conflict: true, latest }
}
