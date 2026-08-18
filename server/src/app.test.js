import { describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import { makeApp } from './app.js'

const user = { id: 'user-1', email: 'a@b.c' }
const fakeSupabase = {
  auth: {
    getUser: vi.fn(async (token) =>
      token === 'good'
        ? { data: { user }, error: null }
        : { data: { user: null }, error: { message: 'bad' } }
    ),
  },
}

// A supabase double that passes membership so a request reaches a route body
// (empty segments/descriptions so loadLevel1Descriptions short-circuits).
function memberSupabase() {
  return {
    auth: fakeSupabase.auth,
    from: (table) => {
      if (table === 'projects') {
        return { select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'p1', title: 'T' }, error: null }) }) }) }
      }
      if (table === 'project_members') {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { user_id: 'user-1' }, error: null }) }) }) }) }
      }
      if (table === 'segments') {
        return { select: () => ({ in: () => ({ eq: async () => ({ data: [], error: null }) }) }) }
      }
      return { select: () => ({ in: async () => ({ data: [], error: null }) }) }
    },
  }
}

describe('app', () => {
  it('GET /health is public', async () => {
    const res = await request(makeApp(fakeSupabase)).get('/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('GET /api/me requires auth', async () => {
    const res = await request(makeApp(fakeSupabase)).get('/api/me')
    expect(res.status).toBe(401)
  })

  it('GET /api/me returns the user with a valid token', async () => {
    const res = await request(makeApp(fakeSupabase))
      .get('/api/me')
      .set('Authorization', 'Bearer good')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ id: 'user-1', email: 'a@b.c' })
  })

  it('CORS matches the configured origin despite stray whitespace, zero-width chars, or slashes in WEB_ORIGIN', async () => {
    const prev = process.env.WEB_ORIGIN
    process.env.WEB_ORIGIN = ' https://app.example.com/​\n'
    try {
      const res = await request(makeApp(fakeSupabase))
        .options('/health')
        .set('Origin', 'https://app.example.com')
        .set('Access-Control-Request-Method', 'GET')
      expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com')
    } finally {
      if (prev === undefined) delete process.env.WEB_ORIGIN
      else process.env.WEB_ORIGIN = prev
    }
  })

  it('returns JSON (not an HTML stack trace) when a route handler throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const app = makeApp(memberSupabase(), {
        propose: async () => { throw new Error('boom-secret-internal-detail') },
        getModel: () => ({}),
      })
      const res = await request(app)
        .post('/api/projects/p1/ai-edit')
        .set('Authorization', 'Bearer good')
        .send({ request: 'delete scene one', clips: [{ id: 'g1', name: 'Scene 1', duration_seconds: 5 }] })
      expect(res.status).toBe(500)
      expect(res.headers['content-type']).toMatch(/application\/json/)
      expect(res.body).toEqual({ error: 'server_error' })
      // The internal error message must never reach the client.
      expect(JSON.stringify(res.body)).not.toContain('boom-secret')
    } finally {
      errSpy.mockRestore()
    }
  })
})

describe('GET /health/db (trial keep-alive)', () => {
  const healthySupabase = {
    auth: fakeSupabase.auth,
    from: () => ({ select: () => ({ limit: async () => ({ data: [], error: null }) }) }),
  }
  const downSupabase = {
    auth: fakeSupabase.auth,
    from: () => ({ select: () => ({ limit: async () => ({ data: null, error: { message: 'paused' } }) }) }),
  }
  const brokenSupabase = {
    auth: fakeSupabase.auth,
    from: () => { throw new Error('no client') },
  }

  it('is public and returns ok when the DB answers', async () => {
    const res = await request(makeApp(healthySupabase)).get('/health/db')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('returns 503 when the DB errors (paused project)', async () => {
    const res = await request(makeApp(downSupabase)).get('/health/db')
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ ok: false })
  })

  it('returns 503 when the client itself throws', async () => {
    const res = await request(makeApp(brokenSupabase)).get('/health/db')
    expect(res.status).toBe(503)
  })
})
