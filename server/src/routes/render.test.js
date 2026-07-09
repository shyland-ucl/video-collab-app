import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { makeRenderRoutes } from './render.js'

const user = { id: 'user-1', email: 'a@b.c' }

// Fake supabase: projects, project_members, and renders (inflight select + insert).
function makeFakeSupabase({ project, member, inflight = [], insertId = 'r1', insertError = null } = {}) {
  return {
    auth: { getUser: vi.fn(async (t) => t === 'good' ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'bad' } }) },
    from: (table) => {
      if (table === 'projects') {
        return { select: () => ({ eq: () => ({ single: async () => project ? { data: project, error: null } : { data: null, error: { message: 'nf' } } }) }) }
      }
      if (table === 'project_members') {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: member ?? null, error: null }) }) }) }) }
      }
      // renders: select(inflight).eq.eq.limit  OR  insert.select.single
      return {
        select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: inflight, error: null }) }) }) }),
        insert: () => ({ select: () => ({ single: async () => insertError ? { data: null, error: insertError } : { data: { id: insertId }, error: null } }) }),
      }
    },
  }
}

const PROJECT = { id: 'p1' }
const MEMBER = { user_id: 'user-1' }
const GOOD_STATE = { version: 4, state: { clips: [{ id: 's1', sourceId: 'v1', startTime: 0, endTime: 2, trimStart: 0, trimEnd: 0 }], colour: {} } }
const SOURCES = [{ id: 'v1', storage_path: 'p1/v1/original.mp4' }]

let renderSpy
function appWith(supabase, { loaded = GOOD_STATE, sources = SOURCES } = {}) {
  renderSpy = vi.fn(async () => {})
  const app = express()
  app.use(express.json())
  app.use(makeRenderRoutes(supabase, {
    render: renderSpy,
    loadState: async () => loaded,
    loadSources: async () => sources,
  }))
  return app
}

beforeEach(() => vi.clearAllMocks())

describe('POST /api/projects/:id/render', () => {
  it('requires auth', async () => {
    const res = await request(appWith(makeFakeSupabase({ project: PROJECT, member: MEMBER }))).post('/api/projects/p1/render').send({})
    expect(res.status).toBe(401)
  })

  it('404s unknown project, 403s non-member', async () => {
    const r404 = await request(appWith(makeFakeSupabase({ member: MEMBER }))).post('/api/projects/p1/render').set('Authorization', 'Bearer good').send({})
    expect(r404.status).toBe(404)
    const r403 = await request(appWith(makeFakeSupabase({ project: PROJECT }))).post('/api/projects/p1/render').set('Authorization', 'Bearer good').send({})
    expect(r403.status).toBe(403)
  })

  it('409s when a render is already in flight', async () => {
    const res = await request(appWith(makeFakeSupabase({ project: PROJECT, member: MEMBER, inflight: [{ id: 'busy' }] }))).post('/api/projects/p1/render').set('Authorization', 'Bearer good').send({})
    expect(res.status).toBe(409)
    expect(renderSpy).not.toHaveBeenCalled()
  })

  it('400s when the EDL has nothing to render', async () => {
    const res = await request(appWith(makeFakeSupabase({ project: PROJECT, member: MEMBER }), { loaded: { version: 1, state: { clips: [], colour: {} } } }))
      .post('/api/projects/p1/render').set('Authorization', 'Bearer good').send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('nothing_to_render')
    expect(renderSpy).not.toHaveBeenCalled()
  })

  it('409s when the insert loses the single-flight race (unique-index violation)', async () => {
    // Two requests can both pass the "already rendering?" SELECT; the DB partial
    // unique index makes the second insert fail with 23505, which maps to 409.
    const supabase = makeFakeSupabase({ project: PROJECT, member: MEMBER, insertError: { code: '23505', message: 'duplicate key value' } })
    const res = await request(appWith(supabase)).post('/api/projects/p1/render').set('Authorization', 'Bearer good').send({})
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('already_rendering')
    expect(renderSpy).not.toHaveBeenCalled()
  })

  it('202s with a renderId and starts the worker for a member', async () => {
    const res = await request(appWith(makeFakeSupabase({ project: PROJECT, member: MEMBER })))
      .post('/api/projects/p1/render').set('Authorization', 'Bearer good').send({})
    expect(res.status).toBe(202)
    expect(res.body.renderId).toBe('r1')
    expect(renderSpy).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', renderId: 'r1' }))
  })
})
