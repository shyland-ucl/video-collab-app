import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetSession, mockInsert } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockInsert: vi.fn(),
}))

vi.mock('./supabaseClient', () => ({
  supabase: {
    auth: { getSession: mockGetSession },
    from: () => ({ insert: mockInsert }),
  },
}))

import { logEvent } from './events'

beforeEach(() => {
  vi.clearAllMocks()
  mockGetSession.mockResolvedValue({ data: { session: { user: { id: 'u1' } } } })
  mockInsert.mockResolvedValue({ error: null })
})

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('logEvent', () => {
  it('inserts the participant event row', async () => {
    logEvent('settings_change', { setting: 'theme', value: 'dark' }, 'p1')
    await flush()
    expect(mockInsert).toHaveBeenCalledWith({
      user_id: 'u1',
      project_id: 'p1',
      event_type: 'settings_change',
      payload: { setting: 'theme', value: 'dark' },
    })
  })

  it('does nothing when signed out', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } })
    logEvent('page_view', { page: 'Projects' })
    await flush()
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('never throws — session failure', async () => {
    mockGetSession.mockRejectedValue(new Error('network down'))
    expect(() => logEvent('page_view')).not.toThrow()
    await flush()
  })

  it('never throws — insert failure', async () => {
    mockInsert.mockRejectedValue(new Error('rls says no'))
    expect(() => logEvent('page_view')).not.toThrow()
    await flush()
  })
})
