import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { makeApp } from '../app.js'

const user = { id: 'user-1', email: 'a@b.c' }

function makeFakeSupabase({ video, member, segment, keyframe } = {}) {
  return {
    auth: {
      getUser: vi.fn(async (token) =>
        token === 'good'
          ? { data: { user }, error: null }
          : { data: { user: null }, error: { message: 'bad' } }
      ),
    },
    from: (table) => ({
      select: () => ({
        eq: () => ({
          single: async () => {
            if (table === 'videos') return video ? { data: video, error: null } : { data: null, error: { message: 'not found' } }
            if (table === 'segments') return segment ? { data: segment, error: null } : { data: null, error: { message: 'not found' } }
            return { data: null, error: { message: 'unexpected table' } }
          },
          eq: () => ({
            maybeSingle: async () => ({ data: member ?? null, error: null }),
          }),
        }),
      }),
    }),
    storage: {
      from: () => ({
        download: async () =>
          keyframe ? { data: new Blob(['jpeg-bytes']), error: null } : { data: null, error: { message: 'missing' } },
      }),
    },
  }
}

const VIDEO = { id: 'vid-1', project_id: 'proj-1', status: 'uploading', storage_path: 'proj-1/vid-1/original.mp4' }
const MEMBER = { user_id: 'user-1' }

let processSpy
let vqaSpy

function appWith(supabase) {
  processSpy = vi.fn(async () => {})
  vqaSpy = vi.fn(async () => 'On the left.')
  return makeApp(supabase, {
    process: processSpy,
    getModel: () => ({}),
    vqa: vqaSpy,
  })
}

beforeEach(() => vi.clearAllMocks())

describe('POST /api/videos/:id/process', () => {
  it('requires auth', async () => {
    const res = await request(appWith(makeFakeSupabase({ video: VIDEO, member: MEMBER }))).post('/api/videos/vid-1/process')
    expect(res.status).toBe(401)
  })

  it('404s when the video does not exist', async () => {
    const res = await request(appWith(makeFakeSupabase({ member: MEMBER })))
      .post('/api/videos/vid-1/process').set('Authorization', 'Bearer good')
    expect(res.status).toBe(404)
  })

  it('403s when the caller is not a project member', async () => {
    const res = await request(appWith(makeFakeSupabase({ video: VIDEO })))
      .post('/api/videos/vid-1/process').set('Authorization', 'Bearer good')
    expect(res.status).toBe(403)
    expect(processSpy).not.toHaveBeenCalled()
  })

  it('409s when already processing', async () => {
    const res = await request(appWith(makeFakeSupabase({ video: { ...VIDEO, status: 'processing' }, member: MEMBER })))
      .post('/api/videos/vid-1/process').set('Authorization', 'Bearer good')
    expect(res.status).toBe(409)
  })

  it('202s and kicks off processing for a member', async () => {
    const res = await request(appWith(makeFakeSupabase({ video: VIDEO, member: MEMBER })))
      .post('/api/videos/vid-1/process').set('Authorization', 'Bearer good')
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ ok: true })
    expect(processSpy).toHaveBeenCalledWith(expect.objectContaining({ videoId: 'vid-1' }))
  })
})

describe('POST /api/segments/:id/vqa', () => {
  const SEGMENT = { id: 'seg-row-1', video_id: 'vid-1', keyframe_path: 'proj-1/vid-1/keyframes/seg_001_kf.jpg' }

  it('400s on a missing question', async () => {
    const res = await request(appWith(makeFakeSupabase({ video: VIDEO, member: MEMBER, segment: SEGMENT, keyframe: true })))
      .post('/api/segments/seg-row-1/vqa').set('Authorization', 'Bearer good').send({})
    expect(res.status).toBe(400)
  })

  it('403s for non-members', async () => {
    const res = await request(appWith(makeFakeSupabase({ video: VIDEO, segment: SEGMENT, keyframe: true })))
      .post('/api/segments/seg-row-1/vqa').set('Authorization', 'Bearer good')
      .send({ question: 'Where is the mug?' })
    expect(res.status).toBe(403)
    expect(vqaSpy).not.toHaveBeenCalled()
  })

  it('answers for a member', async () => {
    const res = await request(appWith(makeFakeSupabase({ video: VIDEO, member: MEMBER, segment: SEGMENT, keyframe: true })))
      .post('/api/segments/seg-row-1/vqa').set('Authorization', 'Bearer good')
      .send({ question: 'Where is the mug?' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ answer: 'On the left.' })
    expect(vqaSpy).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'Where is the mug?')
  })
})
