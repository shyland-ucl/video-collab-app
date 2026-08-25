import { describe, it, expect, vi } from 'vitest'
import {
  fetchAdminProjects,
  fetchIsAdmin,
  fetchProjectEvents,
  fetchUserEmails,
  formatBytes,
  formatDuration,
  orderMembers,
  projectStage,
  timeAgo,
} from './admin'

describe('fetchIsAdmin', () => {
  it('is true only when the RPC returns true', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: true, error: null }) }
    await expect(fetchIsAdmin(supabase)).resolves.toBe(true)
    expect(supabase.rpc).toHaveBeenCalledWith('is_app_admin')
  })

  it('is false for a participant', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: false, error: null }) }
    await expect(fetchIsAdmin(supabase)).resolves.toBe(false)
  })

  // A missing RPC (migration not pushed) or a network blip must never light up
  // an admin affordance for a participant.
  it('is false when the RPC errors', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'nope' } }) }
    await expect(fetchIsAdmin(supabase)).resolves.toBe(false)
  })

  it('is false when the RPC throws', async () => {
    const supabase = { rpc: vi.fn().mockRejectedValue(new Error('offline')) }
    await expect(fetchIsAdmin(supabase)).resolves.toBe(false)
  })
})

describe('fetchAdminProjects', () => {
  it('returns the rows', async () => {
    const rows = [{ project_id: 'p1', title: 'A' }]
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: rows, error: null }) }
    await expect(fetchAdminProjects(supabase)).resolves.toEqual(rows)
    expect(supabase.rpc).toHaveBeenCalledWith('admin_list_projects')
  })

  it('throws on error so the page can show it', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'not_admin' } }) }
    await expect(fetchAdminProjects(supabase)).rejects.toThrow('not_admin')
  })
})

describe('fetchUserEmails', () => {
  it('deduplicates ids and drops nulls before calling the RPC', async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({
        data: [{ user_id: 'u1', email: 'a@x.test' }],
        error: null,
      }),
    }
    const map = await fetchUserEmails(supabase, ['u1', 'u1', null, undefined])
    expect(supabase.rpc).toHaveBeenCalledWith('admin_user_emails', { p_user_ids: ['u1'] })
    expect(map.get('u1')).toBe('a@x.test')
  })

  it('skips the round trip when there is nothing to resolve', async () => {
    const supabase = { rpc: vi.fn() }
    const map = await fetchUserEmails(supabase, [null])
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(map.size).toBe(0)
  })
})

describe('fetchProjectEvents', () => {
  it('passes the project id and defaults to an empty roll-up', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: null, error: null }) }
    await expect(fetchProjectEvents(supabase, 'p1')).resolves.toEqual([])
    expect(supabase.rpc).toHaveBeenCalledWith('admin_project_events', { p_project_id: 'p1' })
  })
})

describe('projectStage', () => {
  const base = {
    video_count: 1,
    videos_ready: 1,
    videos_processing: 0,
    videos_failed: 0,
    state_version: 0,
    render_count: 0,
  }

  it('flags a failed video above everything else', () => {
    expect(projectStage({ ...base, videos_failed: 1, render_count: 3, state_version: 9 }).key).toBe(
      'failed'
    )
  })

  it('reports an empty project', () => {
    expect(projectStage({ ...base, video_count: 0, videos_ready: 0 }).key).toBe('empty')
  })

  it('reports processing', () => {
    expect(projectStage({ ...base, videos_processing: 1 }).key).toBe('processing')
  })

  it('reports a ready but unedited project', () => {
    expect(projectStage({ ...base, state_version: 1 }).key).toBe('ready')
  })

  it('reports editing once the timeline has moved past its first version', () => {
    expect(projectStage({ ...base, state_version: 4 }).key).toBe('editing')
  })

  it('reports exported once a render exists', () => {
    expect(projectStage({ ...base, state_version: 4, render_count: 1 }).key).toBe('exported')
  })

  it('never throws on a missing row', () => {
    expect(projectStage(null).key).toBe('unknown')
  })
})

describe('timeAgo', () => {
  const now = Date.parse('2026-08-25T12:00:00Z')

  it.each([
    ['2026-08-25T11:59:40Z', 'just now'],
    ['2026-08-25T11:45:00Z', '15 min ago'],
    ['2026-08-25T11:00:00Z', '1 hour ago'],
    ['2026-08-25T07:00:00Z', '5 hours ago'],
    ['2026-08-24T11:00:00Z', '1 day ago'],
    ['2026-08-22T11:00:00Z', '3 days ago'],
  ])('renders %s as %s', (iso, expected) => {
    expect(timeAgo(iso, now)).toBe(expected)
  })

  it('says never for a missing or unparseable timestamp', () => {
    expect(timeAgo(null, now)).toBe('never')
    expect(timeAgo('not a date', now)).toBe('never')
  })

  // Clock skew between the browser and the database must not print "-3 days".
  it('clamps a future timestamp to just now', () => {
    expect(timeAgo('2026-08-25T12:05:00Z', now)).toBe('just now')
  })
})

describe('orderMembers', () => {
  it('puts the creator first, then helpers by email', () => {
    const ordered = orderMembers([
      { email: 'z@x.test', role: 'helper' },
      { email: 'a@x.test', role: 'helper' },
      { email: 'c@x.test', role: 'creator' },
    ])
    expect(ordered.map((m) => m.email)).toEqual(['c@x.test', 'a@x.test', 'z@x.test'])
  })

  it('tolerates a null members payload', () => {
    expect(orderMembers(null)).toEqual([])
  })
})

describe('formatting', () => {
  it('formats durations as m:ss', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(75.4)).toBe('1:15')
    expect(formatDuration(null)).toBe('—')
  })

  it('formats sizes in KB below a megabyte and MB above', () => {
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(0)).toBe('—')
  })
})
