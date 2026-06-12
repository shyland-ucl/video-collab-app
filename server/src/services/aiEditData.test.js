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
  // Fake that routes by table name and simulates .in() filtering for descriptions.
  function makeFake({ ownedSegments, descRows }) {
    return {
      from: (table) => {
        if (table === 'segments') {
          return {
            select: () => ({
              in: () => ({
                eq: async () => ({ data: ownedSegments, error: null }),
              }),
            }),
          }
        }
        // table === 'descriptions': simulate the .in('segment_id', [...ownedIds]) filter
        return {
          select: () => ({
            in: (col, ids) => {
              const idSet = new Set(ids)
              const filtered = descRows.filter((r) => idSet.has(r.segment_id))
              return { then: undefined, async [Symbol.for('nodejs.util.inspect.custom')]() {}, ...Object.assign(async () => ({ data: filtered, error: null }), { data: undefined }) }
            },
          }),
        }
      },
    }
  }

  // Simpler approach: make the in() return a promise-like (thenable) for descriptions
  function makeFake2({ ownedSegments, descRows }) {
    return {
      from: (table) => {
        if (table === 'segments') {
          return {
            select: () => ({
              in: () => ({
                eq: async () => ({ data: ownedSegments, error: null }),
              }),
            }),
          }
        }
        // descriptions: simulate DB-side filtering by segment_id
        return {
          select: () => ({
            in: (col, ids) => {
              const idSet = new Set(ids)
              const filtered = (descRows ?? []).filter((r) => idSet.has(r[col]))
              return Promise.resolve({ data: filtered, error: null })
            },
          }),
        }
      },
    }
  }

  it('returns level-1 text keyed by clip id', async () => {
    const idMap = { 'g1-split-1765584000000-a': 'g1', g2: 'g2' }
    const ownedSegments = [
      { id: 'g1', videos: { project_id: 'p1' } },
      { id: 'g2', videos: { project_id: 'p1' } },
    ]
    const descRows = [
      { segment_id: 'g1', text: 'A person stirs a pot.', level: 1 },
      { segment_id: 'g1', text: 'Long detailed description.', level: 2 },
      { segment_id: 'g2', text: 'They taste the food.', level: 1 },
    ]
    const result = await loadLevel1Descriptions(makeFake2({ ownedSegments, descRows }), 'p1', idMap)
    expect(result['g1-split-1765584000000-a']).toBe('A person stirs a pot.')
    expect(result['g2']).toBe('They taste the food.')
  })

  it('handles missing descriptions gracefully', async () => {
    const idMap = { g3: 'g3' }
    const ownedSegments = [{ id: 'g3', videos: { project_id: 'p1' } }]
    const result = await loadLevel1Descriptions(makeFake2({ ownedSegments, descRows: [] }), 'p1', idMap)
    expect(result['g3']).toBeUndefined()
  })

  it('excludes clips whose root segment belongs to a different project', async () => {
    // idMap has two clips: 'g1' → 'g1' (owned by p1), 'g2' → 'g2' (foreign — NOT in ownedSegments)
    const idMap = { g1: 'g1', g2: 'g2' }
    // ownership check only confirms g1 belongs to 'p1'; g2 is absent from the result
    const ownedSegments = [{ id: 'g1', videos: { project_id: 'p1' } }]
    const descRows = [
      { segment_id: 'g1', text: 'Owned description.', level: 1 },
      { segment_id: 'g2', text: 'Foreign description.', level: 1 },
    ]
    // The DB .in('segment_id', ['g1']) would never return g2 — our fake simulates that
    const result = await loadLevel1Descriptions(makeFake2({ ownedSegments, descRows }), 'p1', idMap)
    expect(result['g1']).toBe('Owned description.')
    // g2 must be absent — ownership check filtered it out so DB was never asked for it
    expect(Object.prototype.hasOwnProperty.call(result, 'g2')).toBe(false)
  })
})
