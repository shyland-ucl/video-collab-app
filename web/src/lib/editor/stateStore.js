export const SCENE_COLORS = ['#E74C3C', '#3498DB', '#2ECC71', '#9B59B6', '#E67E22', '#16A085', '#D35400', '#2C3E50']

export function buildInitialState(videos, segments) {
  const videoOrder = [...videos].sort((a, b) => {
    const t = String(a.created_at) < String(b.created_at) ? -1 : String(a.created_at) > String(b.created_at) ? 1 : 0
    return t !== 0 ? t : String(a.id).localeCompare(String(b.id))
  })
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

// splitClip keeps the original id on the first piece and appends
// '-split-<timestamp>-<base36seq>' to the second (see sceneEditOps
// characterization tests); descriptions live on the root segment id.
export function rootSegmentId(clipId) {
  return clipId.replace(/(-split-\d+-[0-9a-z]+)+$/, '')
}

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
  // NOTE: if the remote state deleted the op's target, applyOp is a safe
  // no-op (applyOperation returns state unchanged) — the save still succeeds;
  // last-writer-wins at dyad scale.
  const rebased = applyOp(latest.state)
  const second = await saveState(supabase, projectId, userId, rebased, latest.version)
  if (second.ok) return { ...second, state: rebased }
  if (!second.conflict) return second // network/RLS failure ≠ conflict
  return { ok: false, conflict: true } // caller must refetch; don't hand out stale 'latest'
}
