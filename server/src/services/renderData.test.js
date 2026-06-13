import { describe, it, expect } from 'vitest'
import { loadProjectSources } from './renderData.js'
import { loadLatestState } from './stateStore.js'

describe('loadProjectSources', () => {
  function fake(rows) {
    return { from: () => ({ select: () => ({ eq: () => ({ eq: async () => ({ data: rows, error: null }) }) }) }) }
  }
  it('returns id + storage_path for ready videos', async () => {
    const out = await loadProjectSources(
      fake([{ id: 'v1', storage_path: 'p1/v1/original.mp4', status: 'ready' }]),
      'p1'
    )
    expect(out).toEqual([{ id: 'v1', storage_path: 'p1/v1/original.mp4' }])
  })
  it('throws on a query error', async () => {
    const errFake = { from: () => ({ select: () => ({ eq: () => ({ eq: async () => ({ data: null, error: { message: 'boom' } }) }) }) }) }
    await expect(loadProjectSources(errFake, 'p1')).rejects.toThrow(/sources_query_failed/)
  })
})

describe('loadLatestState', () => {
  function fake(row) {
    return { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }) }) }) }
  }
  it('returns the latest { version, state }', async () => {
    const out = await loadLatestState(fake({ version: 4, state: { clips: [] } }), 'p1')
    expect(out).toEqual({ version: 4, state: { clips: [] } })
  })
  it('returns null when there is no state', async () => {
    expect(await loadLatestState(fake(null), 'p1')).toBeNull()
  })
})
