import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../serverApi', () => ({ serverPost: vi.fn() }))
import { serverPost } from '../serverApi'
import { requestRender, latestRender, renderDownloadUrl } from './rendersApi'

function fakeSupabase() {
  const calls = []
  return {
    calls,
    from: (table) => ({
      select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => { calls.push({ op: 'latest', table }); return { data: { id: 'r1', status: 'ready', output_path: 'p1/renders/r1.mp4' }, error: null } } }) }) }) }),
    }),
    storage: { from: () => ({ createSignedUrl: async (path, ttl) => { calls.push({ op: 'sign', path, ttl }); return { data: { signedUrl: `https://signed/${path}` }, error: null } } }) },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('rendersApi', () => {
  it('requestRender posts and returns the renderId', async () => {
    serverPost.mockResolvedValueOnce({ renderId: 'r9' })
    expect(await requestRender('p1')).toBe('r9')
    expect(serverPost).toHaveBeenCalledWith('/api/projects/p1/render')
  })

  it('latestRender reads the newest renders row', async () => {
    const supabase = fakeSupabase()
    const row = await latestRender(supabase, 'p1')
    expect(supabase.calls[0]).toMatchObject({ op: 'latest', table: 'renders' })
    expect(row.status).toBe('ready')
  })

  it('renderDownloadUrl signs the output path', async () => {
    const supabase = fakeSupabase()
    const url = await renderDownloadUrl(supabase, 'p1/renders/r1.mp4')
    expect(supabase.calls[0]).toMatchObject({ op: 'sign', path: 'p1/renders/r1.mp4', ttl: 3600 })
    expect(url).toBe('https://signed/p1/renders/r1.mp4')
  })

  it('renderDownloadUrl returns null for an absent path', async () => {
    expect(await renderDownloadUrl(fakeSupabase(), null)).toBeNull()
  })
})
