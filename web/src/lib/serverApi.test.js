import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetSession } = vi.hoisted(() => ({ mockGetSession: vi.fn() }))
vi.mock('./supabaseClient', () => ({
  supabase: { auth: { getSession: mockGetSession } },
}))

import { serverPost } from './serverApi'

beforeEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.stubEnv('VITE_SERVER_URL', 'http://localhost:3001')
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'tok-1' } } })
})

describe('serverPost', () => {
  it('POSTs with the bearer token and parses JSON', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await serverPost('/api/videos/v1/process')
    expect(result).toEqual({ ok: true })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/videos\/v1\/process$/)
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer tok-1')
  })

  it('throws the server error code on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'not_a_member' }), { status: 403 })))
    await expect(serverPost('/api/videos/v1/process')).rejects.toThrow('not_a_member')
  })

  it('throws when signed out', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } })
    await expect(serverPost('/x')).rejects.toThrow('not_signed_in')
  })

  it('throws server_not_configured when VITE_SERVER_URL is unset', async () => {
    vi.stubEnv('VITE_SERVER_URL', '')
    await expect(serverPost('/x')).rejects.toThrow('server_not_configured')
  })
})
