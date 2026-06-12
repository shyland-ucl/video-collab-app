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
})
