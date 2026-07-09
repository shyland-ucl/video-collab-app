import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { makeApp } from '../app.js'

const user = { id: 'user-1', email: 'a@b.c' }

function makeFakeSupabase({ project, member, ownedSegments = [], descRows = [] } = {}) {
  return {
    auth: { getUser: vi.fn(async (token) => token === 'good' ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'bad' } }) },
    from: (table) => {
      if (table === 'projects') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => project ? { data: project, error: null } : { data: null, error: { message: 'nf' } },
            }),
          }),
        }
      }
      if (table === 'project_members') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: member ?? null, error: null }) }),
            }),
          }),
        }
      }
      if (table === 'segments') {
        // ownership check: .select().in().eq()
        return {
          select: () => ({
            in: () => ({
              eq: async () => ({ data: ownedSegments, error: null }),
            }),
          }),
        }
      }
      // table === 'descriptions'
      return {
        select: () => ({
          in: async () => ({ data: descRows, error: null }),
        }),
      }
    },
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

  it('forwards a valid focused_clip_id (and a logger) to propose', async () => {
    await request(appWith(makeFakeSupabase({ project: PROJECT, member: MEMBER })))
      .post('/api/projects/p1/ai-edit').set('Authorization', 'Bearer good')
      .send({ request: 'brighten it', clips: CLIPS, focused_clip_id: 'g1' })
    const opts = proposeSpy.mock.calls[0][4] ?? {}
    expect(opts.focusedClipId).toBe('g1')
    expect(typeof opts.log).toBe('function')
  })

  it('drops a focused_clip_id that is not one of the submitted clips (never trust the body)', async () => {
    await request(appWith(makeFakeSupabase({ project: PROJECT, member: MEMBER })))
      .post('/api/projects/p1/ai-edit').set('Authorization', 'Bearer good')
      .send({ request: 'brighten it', clips: CLIPS, focused_clip_id: 'not-a-clip' })
    const opts = proposeSpy.mock.calls[0][4] ?? {}
    expect(opts.focusedClipId).toBe(null)
  })

  it('forwards clarification history, sanitized and clamped to the last two well-formed rounds', async () => {
    const history = [
      { request: 'r1', clarification: 'c1' },
      { request: 'r2', clarification: 'c2' },
      { request: 'r3', clarification: 'c3' },
      { bad: 'x' }, // malformed → dropped
    ]
    await request(appWith(makeFakeSupabase({ project: PROJECT, member: MEMBER })))
      .post('/api/projects/p1/ai-edit').set('Authorization', 'Bearer good')
      .send({ request: 'the second one', clips: CLIPS, history })
    const opts = proposeSpy.mock.calls[0][4] ?? {}
    expect(opts.history).toEqual([
      { request: 'r2', clarification: 'c2' },
      { request: 'r3', clarification: 'c3' },
    ])
  })

  it('defaults to no focus and empty history when the body omits them', async () => {
    await request(appWith(makeFakeSupabase({ project: PROJECT, member: MEMBER })))
      .post('/api/projects/p1/ai-edit').set('Authorization', 'Bearer good')
      .send({ request: 'delete scene one', clips: CLIPS })
    const opts = proposeSpy.mock.calls[0][4] ?? {}
    expect(opts.focusedClipId).toBe(null)
    expect(opts.history).toEqual([])
  })
})
