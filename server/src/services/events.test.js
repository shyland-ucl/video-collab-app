import { describe, it, expect, vi } from 'vitest'
import { logServerEvent } from './events.js'

function supabaseWith(insert) {
  return { from: vi.fn(() => ({ insert })) }
}

describe('logServerEvent', () => {
  it('inserts the event row with user/project context', async () => {
    const insert = vi.fn(async () => ({ error: null }))
    const supabase = supabaseWith(insert)
    await logServerEvent(supabase, {
      userId: 'u1', projectId: 'p1', type: 'render_start', payload: { renderId: 'r1' },
    })
    expect(supabase.from).toHaveBeenCalledWith('events')
    expect(insert).toHaveBeenCalledWith({
      user_id: 'u1', project_id: 'p1', event_type: 'render_start', payload: { renderId: 'r1' },
    })
  })

  it('defaults user/project to null and payload to {}', async () => {
    const insert = vi.fn(async () => ({ error: null }))
    await logServerEvent(supabaseWith(insert), { type: 'processing_done' })
    expect(insert).toHaveBeenCalledWith({
      user_id: null, project_id: null, event_type: 'processing_done', payload: {},
    })
  })

  it('swallows insert errors (warn only, never throws)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(
        logServerEvent(supabaseWith(async () => ({ error: { message: 'nope' } })), { type: 'x' })
      ).resolves.toBeUndefined()
      await expect(
        logServerEvent(supabaseWith(async () => { throw new Error('down') }), { type: 'x' })
      ).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })

  it('survives a completely broken client', async () => {
    await expect(logServerEvent(null, { type: 'x' })).resolves.toBeUndefined()
  })
})
