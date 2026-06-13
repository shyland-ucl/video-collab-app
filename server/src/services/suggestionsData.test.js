import { describe, it, expect } from 'vitest'
import { loadVideoForSuggestions } from './suggestionsData.js'

// Fake supabase routing by table; storage.download returns a tiny "jpeg".
function makeFake({ video, segRows = [], descRows = [], kf = {} }) {
  return {
    from: (table) => {
      if (table === 'videos') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: video ?? null, error: null }) }) }) }
      }
      if (table === 'segments') {
        return { select: () => ({ eq: () => ({ order: async () => ({ data: segRows, error: null }) }) }) }
      }
      // descriptions
      return { select: () => ({ in: async (_c, ids) => ({ data: descRows.filter((r) => ids.includes(r.segment_id)), error: null }) }) }
    },
    storage: {
      from: () => ({
        download: async (p) => kf[p]
          ? { data: { arrayBuffer: async () => Buffer.from(kf[p]) }, error: null }
          : { data: null, error: { message: 'missing' } },
      }),
    },
  }
}

const VIDEO = { id: 'v1', project_id: 'p1', status: 'ready' }

describe('loadVideoForSuggestions', () => {
  it('returns scenes ordered with per-level descriptions and keyframes', async () => {
    const fake = makeFake({
      video: VIDEO,
      segRows: [
        { id: 's1', idx: 1, start_seconds: 0, end_seconds: 5, label: 'One', keyframe_path: 'p1/v1/keyframes/s1_kf.jpg' },
        { id: 's2', idx: 2, start_seconds: 5, end_seconds: 9, label: 'Two', keyframe_path: 'p1/v1/keyframes/s2_kf.jpg' },
      ],
      descRows: [
        { segment_id: 's1', level: 1, text: 'short one' },
        { segment_id: 's1', level: 2, text: 'detail one' },
        { segment_id: 's2', level: 1, text: 'short two' },
      ],
      kf: { 'p1/v1/keyframes/s1_kf.jpg': 'JPEGBYTES1', 'p1/v1/keyframes/s2_kf.jpg': 'JPEGBYTES2' },
    })
    const out = await loadVideoForSuggestions(fake, 'p1', 'v1')
    expect(out.error).toBeUndefined()
    expect(out.scenes).toHaveLength(2)
    expect(out.scenes[0]).toMatchObject({ idx: 1, segmentId: 's1', level1: 'short one', level2: 'detail one' })
    expect(out.scenes[1].segmentId).toBe('s2')
    expect(out.scenes[1].level1).toBe('short two')
    expect(out.keyframes).toHaveLength(2)
    expect(out.keyframes[0]).toBe(Buffer.from('JPEGBYTES1').toString('base64'))
  })

  it('rejects a video from another project', async () => {
    const fake = makeFake({ video: { id: 'v1', project_id: 'OTHER', status: 'ready' } })
    expect((await loadVideoForSuggestions(fake, 'p1', 'v1')).error).toBe('video_not_found')
  })

  it('rejects a missing video', async () => {
    const fake = makeFake({ video: null })
    expect((await loadVideoForSuggestions(fake, 'p1', 'v1')).error).toBe('video_not_found')
  })

  it('rejects a video that is not ready', async () => {
    const fake = makeFake({ video: { id: 'v1', project_id: 'p1', status: 'processing' } })
    expect((await loadVideoForSuggestions(fake, 'p1', 'v1')).error).toBe('video_not_ready')
  })

  it('errors when the video has no segments', async () => {
    const fake = makeFake({ video: VIDEO, segRows: [] })
    expect((await loadVideoForSuggestions(fake, 'p1', 'v1')).error).toBe('no_segments')
  })

  it('pushes null for a keyframe that fails to download (still returns the scene)', async () => {
    const fake = makeFake({
      video: VIDEO,
      segRows: [{ id: 's1', idx: 1, start_seconds: 0, end_seconds: 5, label: 'One', keyframe_path: 'missing/path.jpg' }],
      descRows: [{ segment_id: 's1', level: 1, text: 'short one' }],
    })
    const out = await loadVideoForSuggestions(fake, 'p1', 'v1')
    expect(out.scenes).toHaveLength(1)
    expect(out.keyframes).toEqual([null])
  })

  it('truncates to maxScenes and reports it', async () => {
    const segRows = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, idx: i + 1, start_seconds: i, end_seconds: i + 1, label: `S${i}`, keyframe_path: null }))
    const fake = makeFake({ video: VIDEO, segRows })
    const out = await loadVideoForSuggestions(fake, 'p1', 'v1', { maxScenes: 3 })
    expect(out.scenes).toHaveLength(3)
    expect(out.truncated).toBe(true)
    expect(out.totalScenes).toBe(5)
  })
})
