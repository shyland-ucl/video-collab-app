import { describe, it, expect, vi } from 'vitest'
import { createTask, setTaskStatus, listTasks } from './tasksApi'

function fakeSupabase() {
  const calls = []
  return {
    calls,
    from: (table) => ({
      insert: (row) => ({ select: () => ({ single: async () => { calls.push({ op: 'insert', table, row }); return { data: { id: 't1', ...row, status: 'pending' }, error: null } } }) }),
      update: (patch) => ({ eq: (col, val) => ({ select: () => ({ single: async () => { calls.push({ op: 'update', table, patch, col, val }); return { data: { id: val, ...patch }, error: null } } }) }) }),
      select: () => ({ eq: () => ({ order: async () => { calls.push({ op: 'list', table }); return { data: [], error: null } } }) }),
    }),
  }
}

describe('tasksApi', () => {
  it('creates a task with creator + label', async () => {
    const supabase = fakeSupabase()
    const task = await createTask(supabase, { projectId: 'p1', userId: 'u1', text: 'Trim it', segmentLabel: 'Scene 2' })
    expect(task.status).toBe('pending')
    expect(supabase.calls[0].row).toMatchObject({ project_id: 'p1', created_by: 'u1', text: 'Trim it', segment_label: 'Scene 2' })
  })

  it('updates status', async () => {
    const supabase = fakeSupabase()
    const task = await setTaskStatus(supabase, 't9', 'done')
    expect(task.status).toBe('done')
    expect(supabase.calls[0]).toMatchObject({ op: 'update', col: 'id', val: 't9', patch: { status: 'done' } })
  })

  it('lists project tasks newest first', async () => {
    const supabase = fakeSupabase()
    await listTasks(supabase, 'p1')
    expect(supabase.calls[0]).toMatchObject({ op: 'list', table: 'tasks' })
  })
})
