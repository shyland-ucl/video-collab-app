import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { makeApp } from '../app.js'

const user = { id: 'user-1', email: 'a@b.c' }

function makeFakeSupabase({ project, member, segments = [] } = {}) {
  return {
    auth: { getUser: vi.fn(async (token) => token === 'good' ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'bad' } }) },
    from: (table) => ({
      select: () => ({
        eq: () => ({
          single: async () => table === 'projects'
            ? (project ? { data: project, error: null } : { data: null, error: { message: 'nf' } })
            : { data: null, error: { message: 'nf' } },
          eq: () => ({ maybeSingle: async () => ({ data: member ?? null, error: null }) }),
        }),
        in: () => ({ data: segments, error: null }),
      }),
    }),
  }
}

const PROJECT = { id: 'p1', title: 'T' }
const MEMBER = { user_id: 'user-1' }
const CLIPS = [{ id: 'g1', name: 'Scene 1', duration_seconds: 5 }]

let proposeSpy
function appWith(supabase, proposeResult = { op: 'delete', target_clip_id: 'g1', params: {}, summary: 'I will delete Scene 1.' }) {
  proposeSpy = vi.fn(async () => proposeResult)
  return makeApp(supabase, { propose: proposeSpy, getModel: () => ({}), process: vi.fn(), vqa: vi.fn() })
}

beforeEach(() => vi.clearAllMocks())

describe('POST /api/projects/:id/ai-edit', () => {
  it('requires auth', async () => {
    const res = await request(appWith(makeFakeSupabase({ project: PROJECT, member: MEMBER })))
      .post('/api/projects/p1/ai-edit').send({ request: 'x', clips: CLIPS })
    expect(res.status).toBe(401)
  })

  it('404s for unknown project, 403s for non-members', async () => {
    const r404 = await request(appWith(makeFakeSupabase({ member: MEMBER })))
      .post('/api/projects/p1/ai-edit').set('Authorization', 'Bearer good').send({ request: 'x', clips: CLIPS })
    expect(r404.status).toBe(404)
    const r403 = await request(appWith(makeFakeSupabase({ project: PROJECT })))
      .post('/api/projects/p1/ai-edit').set('Authorization', 'Bearer good').send({ request: 'x', clips: CLIPS })
    expect(r403.status).toBe(403)
    expect(proposeSpy).not.toHaveBeenCalled()
  })

  it('400s on bad input', async () => {
    const app = appWith(makeFakeSupabase({ project: PROJECT, member: MEMBER }))
    for (const body of [{}, { request: '', clips: CLIPS }, { request: 'x'.repeat(501), clips: CLIPS }, { request: 'x', clips: [] }, { request: 'x' }]) {
      const res = await request(app).post('/api/projects/p1/ai-edit').set('Authorization', 'Bearer good').send(body)
      expect(res.status).toBe(400)
    }
  })

  it('returns the proposal for a member', async () => {
    const res = await request(appWith(makeFakeSupabase({ project: PROJECT, member: MEMBER })))
      .post('/api/projects/p1/ai-edit').set('Authorization', 'Bearer good')
      .send({ request: 'delete scene one', clips: CLIPS })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ op: 'delete', target_clip_id: 'g1' })
    expect(proposeSpy).toHaveBeenCalled()
  })
})
