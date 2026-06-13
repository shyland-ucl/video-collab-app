import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../serverApi', () => ({ serverPost: vi.fn() }))
import { serverPost } from '../serverApi'
import {
  requestSuggestions,
  listProjectSuggestions,
  setSuggestionResolution,
  updateSuggestionOutcome,
} from './suggestionsApi'

function fakeSupabase() {
  const calls = []
  return {
    calls,
    from: (table) => ({
      select: () => ({ eq: () => ({ order: async () => { calls.push({ op: 'list', table }); return { data: [{ id: 's1' }], error: null } } }) }),
      update: (patch) => ({ eq: (col, val) => ({ select: () => ({ single: async () => { calls.push({ op: 'update', table, patch, col, val }); return { data: { id: val, ...patch }, error: null } } }) }) }),
    }),
  }
}

beforeEach(() => vi.clearAllMocks())

describe('suggestionsApi', () => {
  it('requestSuggestions posts videoId and returns the suggestions array', async () => {
    serverPost.mockResolvedValueOnce({ suggestions: [{ id: 's1' }, { id: 's2' }] })
    const out = await requestSuggestions('p1', 'v1')
    expect(serverPost).toHaveBeenCalledWith('/api/projects/p1/suggest', { videoId: 'v1' })
    expect(out).toHaveLength(2)
  })

  it('requestSuggestions tolerates a bodyless/empty response', async () => {
    serverPost.mockResolvedValueOnce(null)
    expect(await requestSuggestions('p1', 'v1')).toEqual([])
  })

  it('listProjectSuggestions reads the project rows', async () => {
    const supabase = fakeSupabase()
    const rows = await listProjectSuggestions(supabase, 'p1')
    expect(supabase.calls[0]).toMatchObject({ op: 'list', table: 'suggestions' })
    expect(rows).toEqual([{ id: 's1' }])
  })

  it('setSuggestionResolution writes routed_to/outcome_status/task_id/resolved_by', async () => {
    const supabase = fakeSupabase()
    const row = await setSuggestionResolution(supabase, 'sug9', { routedTo: 'ai', outcomeStatus: 'applied', taskId: null, userId: 'u1' })
    const call = supabase.calls[0]
    expect(call).toMatchObject({ op: 'update', table: 'suggestions', col: 'id', val: 'sug9' })
    expect(call.patch).toMatchObject({ routed_to: 'ai', outcome_status: 'applied', task_id: null, resolved_by: 'u1' })
    expect(call.patch.resolved_at).toBeTypeOf('string')
    expect(row.routed_to).toBe('ai')
  })

  it('setSuggestionResolution links a helper route to its task id', async () => {
    const supabase = fakeSupabase()
    await setSuggestionResolution(supabase, 'sug1', { routedTo: 'helper', outcomeStatus: 'pending', taskId: 't7', userId: 'u1' })
    expect(supabase.calls[0].patch).toMatchObject({ routed_to: 'helper', task_id: 't7' })
  })

  it('updateSuggestionOutcome flips only the outcome_status', async () => {
    const supabase = fakeSupabase()
    await updateSuggestionOutcome(supabase, 'sug2', 'failed')
    expect(supabase.calls[0].patch).toEqual({ outcome_status: 'failed' })
  })
})
