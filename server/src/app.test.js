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
})
