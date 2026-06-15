import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { processVideo, recoverInterrupted } from './processVideo.js'

const VIDEO = {
  id: 'vid-1',
  project_id: 'proj-1',
  storage_path: 'proj-1/vid-1/original.mp4',
  segment_length_seconds: 5,
  status: 'uploading',
}

function makeFakeSupabase({ video = VIDEO } = {}) {
  const updates = []
  const inserted = { segments: [], descriptions: [] }
  const uploads = []
  const deletes = []
  return {
    updates, inserted, uploads, deletes,
    from(table) {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: video, error: null }),
          }),
        }),
        update: (patch) => ({
          eq: async () => { updates.push({ table, patch }); return { error: null } },
        }),
        delete: () => ({
          eq: async (col, val) => { deletes.push({ table, col, val }); return { error: null } },
        }),
        insert: (rows) => {
          if (table === 'segments') {
            const row = { id: `segrow-${inserted.segments.length + 1}`, ...rows }
            inserted.segments.push(row)
            return { select: () => ({ single: async () => ({ data: row, error: null }) }) }
          }
          inserted.descriptions.push(...rows)
          return Promise.resolve({ error: null })
        },
      }
    },
    storage: {
      from: () => ({
        download: async () => ({ data: new Blob(['fake-mp4-bytes']), error: null }),
        upload: async (objectPath) => { uploads.push(objectPath); return { data: {}, error: null } },
      }),
    },
  }
}

function makeDeps({ describeFails = false } = {}) {
  return {
    getMeta: vi.fn(async () => ({
      duration_seconds: 7, width: 320, height: 240, fps: 24, size_bytes: 1000,
    })),
    cut: vi.fn(async (_src, outDir, plan) => {
      const segFile = path.join(outDir, `${plan.id}.mp4`)
      const kfFile = path.join(outDir, `${plan.id}_kf.jpg`)
      await fs.writeFile(segFile, 'seg-bytes')
      await fs.writeFile(kfFile, 'kf-bytes')
      return { segFile, kfFile }
    }),
    describe: vi.fn(async () => {
      if (describeFails) throw new Error('gemini_down')
      return { level_1: 'one', level_2: 'two', level_3: 'three' }
    }),
    loadPrompt: vi.fn(async () => 'PROMPT'),
  }
}

describe('processVideo', () => {
  it('downloads, segments, describes, and marks the video ready', async () => {
    const supabase = makeFakeSupabase()
    const deps = makeDeps()
    await processVideo({ supabase, model: {}, videoId: 'vid-1' }, deps)

    // 7s at 5s/segment -> 2 segments, 6 description rows
    expect(deps.cut).toHaveBeenCalledTimes(2)
    expect(supabase.inserted.segments).toHaveLength(2)
    expect(supabase.inserted.descriptions).toHaveLength(6)

    // segment + keyframe per segment uploaded under the video prefix
    expect(supabase.uploads).toContain('proj-1/vid-1/segments/seg_001.mp4')
    expect(supabase.uploads).toContain('proj-1/vid-1/keyframes/seg_002_kf.jpg')

    // previous segments cleared for idempotent reruns
    expect(supabase.deletes).toContainEqual({ table: 'segments', col: 'video_id', val: 'vid-1' })

    const statuses = supabase.updates
      .filter((u) => u.table === 'videos' && u.patch.status)
      .map((u) => u.patch.status)
    expect(statuses[0]).toBe('processing')
    expect(statuses[statuses.length - 1]).toBe('ready')

    // metadata written
    expect(supabase.updates.some((u) => u.patch.duration_seconds === 7)).toBe(true)
  })

  it('marks the video failed (with the error) and rethrows when a step blows up', async () => {
    const supabase = makeFakeSupabase()
    const deps = makeDeps({ describeFails: true })

    await expect(
      processVideo({ supabase, model: {}, videoId: 'vid-1' }, deps)
    ).rejects.toThrow('gemini_down')

    const last = supabase.updates[supabase.updates.length - 1]
    expect(last.patch.status).toBe('failed')
    expect(last.patch.error).toMatch(/gemini_down/)
  })

  it('records the exit signal when ffmpeg is killed (the OOM diagnostic that was missing)', async () => {
    const supabase = makeFakeSupabase()
    const deps = makeDeps()
    deps.cut = vi.fn(async () => {
      const e = new Error('Command failed: ffmpeg ... seg_001.mp4')
      e.signal = 'SIGKILL'
      e.killed = false // OS/OOM kill, not our timeout
      throw e
    })

    await expect(
      processVideo({ supabase, model: {}, videoId: 'vid-1' }, deps)
    ).rejects.toThrow()

    const last = supabase.updates[supabase.updates.length - 1]
    expect(last.patch.status).toBe('failed')
    expect(last.patch.error).toMatch(/signal=SIGKILL/)
    expect(last.patch.error).toMatch(/OOM/i)
  })
})

describe('recoverInterrupted', () => {
  it('marks stale processing AND rendering rows failed at boot', async () => {
    const calls = []
    const supabase = {
      from: (table) => ({
        update: (patch) => ({
          eq: (col, val) => ({
            select: async () => {
              calls.push({ table, patch, col, val })
              return { data: [{ id: 'x1' }], error: null }
            },
          }),
        }),
      }),
    }
    await recoverInterrupted(supabase, () => {})
    expect(calls).toEqual([
      { table: 'videos', patch: { status: 'failed', error: 'interrupted_by_restart' }, col: 'status', val: 'processing' },
      { table: 'renders', patch: { status: 'failed', error: 'interrupted_by_restart' }, col: 'status', val: 'rendering' },
    ])
  })
})
