import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { makeSuggestRoutes } from './suggest.js'

const user = { id: 'user-1', email: 'a@b.c' }

function makeFakeSupabase({ project, member } = {}) {
  return {
    auth: { getUser: vi.fn(async (t) => t === 'good' ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'bad' } }) },
    from: (table) => {
      if (table === 'projects') {
        return { select: () => ({ eq: () => ({ single: async () => project ? { data: project, error: null } : { data: null, error: { message: 'nf' } } }) }) }
      }
      // project_members
      return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: member ?? null, error: null }) }) }) }) }
    },
  }
}

const PROJECT = { id: 'p1', title: 'T' }
const MEMBER = { user_id: 'user-1' }
const SUGGESTIONS = [{ category: 'issue', text: 'too dark', relatedScene: 0, prototype_action: 'brightness' }]

let proposeSpy, loadSpy
function appWith(supabase, { loaded = { scenes: [{}], keyframes: [null] }, proposal = { suggestions: SUGGESTIONS, dropped: 0 } } = {}) {
  proposeSpy = vi.fn(async () => proposal)
  loadSpy = vi.fn(async () => loaded)
  const app = express()
  app.use(express.json())
  app.use(makeSuggestRoutes(supabase, { propose: proposeSpy, getModel: () => ({}), loadVideo: loadSpy }))
  return app
}

beforeEach(() => vi.clearAllMocks())

describe('POST /api/projects/:id/suggest', () => {
  it('requires auth', async () => {
    const res = await request(appWith(makeFakeSupabase({ project: PROJECT, member: MEMBER }))).post('/api/projects/p1/suggest').send({ videoId: 'v1' })
    expect(res.status).toBe(401)
  })

  it('404s for unknown project, 403s for non-members', async () => {
    const r404 = await request(appWith(makeFakeSupabase({ member: MEMBER }))).post('/api/projects/p1/suggest').set('Authorization', 'Bearer good').send({ videoId: 'v1' })
    expect(r404.status).toBe(404)
    const r403 = await request(appWith(makeFakeSupabase({ project: PROJECT }))).post('/api/projects/p1/suggest').set('Authorization', 'Bearer good').send({ videoId: 'v1' })
    expect(r403.status).toBe(403)
    expect(proposeSpy).not.toHaveBeenCalled()
  })

  it('400s on a missing videoId', async () => {
    const res = await request(appWith(makeFakeSupabase({ project: PROJECT, member: MEMBER }))).post('/api/projects/p1/suggest').set('Authorization', 'Bearer good').send({})
    expect(res.status).toBe(400)
  })

  it('maps loader errors to status codes', async () => {
    const r404 = await request(appWith(makeFakeSupabase({ project: PROJECT, member: MEMBER }), { loaded: { error: 'video_not_found' } })).post('/api/projects/p1/suggest').set('Authorization', 'Bearer good').send({ videoId: 'v1' })
    expect(r404.status).toBe(404)
    const r400 = await request(appWith(makeFakeSupabase({ project: PROJECT, member: MEMBER }), { loaded: { error: 'video_not_ready' } })).post('/api/projects/p1/suggest').set('Authorization', 'Bearer good').send({ videoId: 'v1' })
    expect(r400.status).toBe(400)
  })

  it('maps a DB-failure loader error to a 500 without leaking the internal code', async () => {
    const res = await request(appWith(makeFakeSupabase({ project: PROJECT, member: MEMBER }), { loaded: { error: 'segments_query_failed' } })).post('/api/projects/p1/suggest').set('Authorization', 'Bearer good').send({ videoId: 'v1' })
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('server_error')
  })

  it('returns curated suggestions for a member', async () => {
    const res = await request(appWith(makeFakeSupabase({ project: PROJECT, member: MEMBER }))).post('/api/projects/p1/suggest').set('Authorization', 'Bearer good').send({ videoId: 'v1' })
    expect(res.status).toBe(200)
    expect(res.body.suggestions).toEqual(SUGGESTIONS)
    expect(loadSpy).toHaveBeenCalledWith(expect.anything(), 'p1', 'v1')
    expect(proposeSpy).toHaveBeenCalled()
  })
})
