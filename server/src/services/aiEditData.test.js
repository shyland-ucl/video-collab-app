import { describe, it, expect } from 'vitest'
import { rootSegmentIds, loadLevel1Descriptions } from './aiEditData.js'

describe('rootSegmentIds', () => {
  it('strips real split suffixes back to the original clip id', () => {
    const clips = [
      { id: 'g1-split-1765584000000-a', name: 'Scene 1', duration_seconds: 2.5 },
      { id: 'g1-split-1765584000000-a-split-1765584000001-b', name: 'Scene 2', duration_seconds: 2.5 },
      { id: 'g2', name: 'Scene 3', duration_seconds: 5 },
      { id: '5aaf7f08-f887-40ae-b4aa-c8a5ba96e302', name: 'Scene 4', duration_seconds: 3 },
    ]
    const map = rootSegmentIds(clips)
    expect(map['g1-split-1765584000000-a']).toBe('g1')
    expect(map['g1-split-1765584000000-a-split-1765584000001-b']).toBe('g1')
    expect(map['g2']).toBe('g2')
    expect(map['5aaf7f08-f887-40ae-b4aa-c8a5ba96e302']).toBe('5aaf7f08-f887-40ae-b4aa-c8a5ba96e302')
  })
})

describe('loadLevel1Descriptions', () => {
  function fakeSupabase(rows) {
    return {
      from: () => ({
        select: () => ({
          in: async () => ({ data: rows, error: null }),
        }),
      }),
    }
  }

  it('returns level-1 text keyed by clip id', async () => {
    const idMap = { 'g1-split-1765584000000-a': 'g1', g2: 'g2' }
    const rows = [
      { segment_id: 'g1', text: 'A person stirs a pot.', level: 1 },
      { segment_id: 'g1', text: 'Long detailed description.', level: 2 },
      { segment_id: 'g2', text: 'They taste the food.', level: 1 },
    ]
    const result = await loadLevel1Descriptions(fakeSupabase(rows), idMap)
    expect(result['g1-split-1765584000000-a']).toBe('A person stirs a pot.')
    expect(result['g2']).toBe('They taste the food.')
  })

  it('handles missing descriptions gracefully', async () => {
    const idMap = { g3: 'g3' }
    const result = await loadLevel1Descriptions(fakeSupabase([]), idMap)
    expect(result['g3']).toBeUndefined()
  })
})
