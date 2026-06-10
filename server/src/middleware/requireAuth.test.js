import { describe, it, expect, vi } from 'vitest'
import { makeRequireAuth } from './requireAuth.js'

function mockRes() {
  const res = { statusCode: null, body: null }
  res.status = (c) => { res.statusCode = c; return res }
  res.json = (b) => { res.body = b; return res }
  return res
}

describe('makeRequireAuth', () => {
  it('rejects requests with no Authorization header', async () => {
    const requireAuth = makeRequireAuth({ auth: { getUser: vi.fn() } })
    const res = mockRes()
    const next = vi.fn()
    await requireAuth({ headers: {} }, res, next)
    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects requests whose token Supabase does not recognise', async () => {
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: { message: 'bad' } }) } }
    const requireAuth = makeRequireAuth(client)
    const res = mockRes()
    const next = vi.fn()
    await requireAuth({ headers: { authorization: 'Bearer nope' } }, res, next)
    expect(client.auth.getUser).toHaveBeenCalledWith('nope')
    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('attaches req.user and calls next on a valid token', async () => {
    const user = { id: 'user-1', email: 'a@b.c' }
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }) } }
    const requireAuth = makeRequireAuth(client)
    const req = { headers: { authorization: 'Bearer good' } }
    const res = mockRes()
    const next = vi.fn()
    await requireAuth(req, res, next)
    expect(req.user).toEqual(user)
    expect(next).toHaveBeenCalled()
  })
})
