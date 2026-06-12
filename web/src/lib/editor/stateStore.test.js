import { describe, it, expect, vi } from 'vitest'
import { buildInitialState, rootSegmentId, loadLatestState, saveState, saveWithRebase, SCENE_COLORS } from './stateStore'

const VIDEOS = [
  { id: 'v1', created_at: '2026-06-01', original_name: 'a.mp4' },
  { id: 'v2', created_at: '2026-06-02', original_name: 'b.mp4' },
]
const SEGMENTS = [
  { id: 'g2', video_id: 'v2', idx: 1, label: 'Scene 1', start_seconds: 0, end_seconds: 5 },
  { id: 'g1a', video_id: 'v1', idx: 1, label: 'Scene 1', start_seconds: 0, end_seconds: 5 },
  { id: 'g1b', video_id: 'v1', idx: 2, label: 'Scene 2', start_seconds: 5, end_seconds: 8 },
]

describe('buildInitialState', () => {
  it('orders clips by video created_at then idx, names them sequentially', () => {
    const state = buildInitialState(VIDEOS, SEGMENTS)
    expect(state.clips.map((c) => c.id)).toEqual(['g1a', 'g1b', 'g2'])
    expect(state.clips.map((c) => c.name)).toEqual(['Scene 1', 'Scene 2', 'Scene 3'])
    expect(state.clips[0]).toMatchObject({
      sourceId: 'v1', startTime: 0, endTime: 5, trimStart: 0, trimEnd: 0, muted: false,
    })
    expect(SCENE_COLORS).toContain(state.clips[0].color)
    expect(state.captions).toEqual([])
    expect(state.textOverlays).toEqual([])
    expect(state.colour).toEqual({})
  })
})

describe('rootSegmentId', () => {
  it('strips real split suffixes back to the original segment id', () => {
    expect(rootSegmentId('g1-split-1765584000000-a')).toBe('g1')
    expect(rootSegmentId('g1-split-1765584000000-a-split-1765584000001-b')).toBe('g1')
    expect(rootSegmentId('g1')).toBe('g1')
    // canonical uuids never match the suffix pattern
    expect(rootSegmentId('5aaf7f08-f887-40ae-b4aa-c8a5ba96e302')).toBe('5aaf7f08-f887-40ae-b4aa-c8a5ba96e302')
  })
})

function fakeSupabase({ latestRows = [], insertError = null, loadError = null } = {}) {
  const inserts = []
  return {
    inserts,
    from: (table) => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => ({
              maybeSingle: async () => loadError
                ? { data: null, error: loadError }
                : { data: latestRows[0] ?? null, error: null },
            }),
          }),
        }),
      }),
      insert: (row) => {
        inserts.push({ table, row })
        return { select: () => ({ single: async () => insertError ? { data: null, error: insertError } : { data: row, error: null } }) }
      },
    }),
  }
}

describe('loadLatestState / saveState', () => {
  it('returns null when no state exists', async () => {
    expect(await loadLatestState(fakeSupabase(), 'p1')).toBeNull()
  })

  it('throws state_load_failed when supabase returns an error', async () => {
    const supabase = fakeSupabase({ loadError: { message: 'boom' } })
    await expect(loadLatestState(supabase, 'p1')).rejects.toThrow('state_load_failed')
  })

  it('saves version expected+1 with updated_by', async () => {
    const supabase = fakeSupabase()
    const result = await saveState(supabase, 'p1', 'u1', { clips: [] }, 3)
    expect(result).toEqual({ ok: true, version: 4 })
    expect(supabase.inserts[0].row).toMatchObject({ project_id: 'p1', version: 4, updated_by: 'u1' })
  })

  it('reports a conflict on unique violation', async () => {
    const supabase = fakeSupabase({ insertError: { code: '23505', message: 'dup' } })
    const result = await saveState(supabase, 'p1', 'u1', { clips: [] }, 3)
    expect(result).toEqual({ ok: false, conflict: true })
  })
})

describe('saveWithRebase', () => {
  it('on conflict reloads latest, reapplies the op, retries once', async () => {
    let call = 0
    const applied = []
    const supabase = {
      from: (table) => ({
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: { version: 7, state: { clips: ['remote'] } }, error: null }),
              }),
            }),
          }),
        }),
        insert: (row) => ({
          select: () => ({
            single: async () => {
              call += 1
              if (call === 1) return { data: null, error: { code: '23505', message: 'dup' } }
              return { data: row, error: null }
            },
          }),
        }),
      }),
    }
    const applyOp = vi.fn((state) => { applied.push(state); return { ...state, reapplied: true } })
    const result = await saveWithRebase(supabase, 'p1', 'u1', applyOp, { clips: ['local'] }, 5)
    expect(result.ok).toBe(true)
    expect(result.version).toBe(8)
    expect(applyOp).toHaveBeenCalledWith({ clips: ['remote'] })
    expect(result.state).toMatchObject({ reapplied: true })
  })

  it('retry fails with non-23505 error → no conflict flag, no latest', async () => {
    let call = 0
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: { version: 7, state: { clips: [] } }, error: null }),
              }),
            }),
          }),
        }),
        insert: (row) => ({
          select: () => ({
            single: async () => {
              call += 1
              if (call === 1) return { data: null, error: { code: '23505', message: 'dup' } }
              return { data: null, error: { code: 'PGRST301', message: 'boom' } }
            },
          }),
        }),
      }),
    }
    const result = await saveWithRebase(supabase, 'p1', 'u1', (s) => s, { clips: [] }, 5)
    expect(result).toEqual({ ok: false, error: 'boom' })
    expect(result.conflict).toBeUndefined()
  })

  it('retry also collides with 23505 → conflict:true with no latest property', async () => {
    let call = 0
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: { version: 7, state: { clips: [] } }, error: null }),
              }),
            }),
          }),
        }),
        insert: (row) => ({
          select: () => ({
            single: async () => {
              call += 1
              return { data: null, error: { code: '23505', message: 'dup' } }
            },
          }),
        }),
      }),
    }
    const result = await saveWithRebase(supabase, 'p1', 'u1', (s) => s, { clips: [] }, 5)
    expect(result).toEqual({ ok: false, conflict: true })
    expect(result.latest).toBeUndefined()
  })
})

describe('buildInitialState — determinism', () => {
  it('orders clips by video id when created_at is identical', () => {
    const videos = [
      { id: 'v-b', created_at: '2026-06-01' },
      { id: 'v-a', created_at: '2026-06-01' },
    ]
    const segments = [
      { id: 'sb1', video_id: 'v-b', idx: 1, start_seconds: 0, end_seconds: 5 },
      { id: 'sa1', video_id: 'v-a', idx: 1, start_seconds: 0, end_seconds: 5 },
    ]
    const state = buildInitialState(videos, segments)
    expect(state.clips.map((c) => c.sourceId)).toEqual(['v-a', 'v-b'])
  })
})
