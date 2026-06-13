import { describe, it, expect, vi } from 'vitest'
import { renderVideo } from './renderVideo.js'

function makeSupabase() {
  const updates = []
  const uploads = []
  return {
    updates,
    uploads,
    from: () => ({ update: (patch) => ({ eq: async (_c, id) => { updates.push({ id, patch }); return { error: null } } }) }),
    storage: {
      from: () => ({
        download: async () => ({ data: { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }, error: null }),
        upload: async (path) => { uploads.push(path); return { error: null } },
      }),
    },
  }
}

const STATE = {
  clips: [
    { id: 's1', sourceId: 'v1', startTime: 0, endTime: 2, trimStart: 0, trimEnd: 0 },
    { id: 's2', sourceId: 'v1', startTime: 2, endTime: 4, trimStart: 0, trimEnd: 0 },
  ],
  colour: {},
}
const SOURCES = [{ id: 'v1', storage_path: 'p1/v1/original.mp4' }]

function baseOpts(overrides = {}) {
  return {
    supabase: makeSupabase(),
    runFfmpeg: vi.fn(async () => {}),
    projectId: 'p1',
    renderId: 'r1',
    loadState: async () => ({ version: 4, state: STATE }),
    loadSources: async () => SOURCES,
    workdir: '/tmp/x',
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => Buffer.from([1, 2, 3])),
    rm: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('renderVideo', () => {
  it('downloads each distinct source once, renders each clip, concats, uploads, marks ready', async () => {
    const opts = baseOpts()
    await renderVideo(opts)
    // 2 clips + 1 concat
    expect(opts.runFfmpeg).toHaveBeenCalledTimes(3)
    // one source downloaded once even though 2 clips reference it
    expect(opts.supabase.uploads).toEqual(['p1/renders/r1.mp4'])
    const ready = opts.supabase.updates.find((u) => u.patch.status === 'ready')
    expect(ready).toBeTruthy()
    expect(ready.patch.output_path).toBe('p1/renders/r1.mp4')
    expect(opts.rm).toHaveBeenCalled() // tmp cleaned
  })

  it('marks the render failed and rethrows on an ffmpeg error', async () => {
    const opts = baseOpts({ runFfmpeg: vi.fn(async () => { throw new Error('boom') }) })
    await expect(renderVideo(opts)).rejects.toThrow('boom')
    expect(opts.supabase.updates.some((u) => u.patch.status === 'failed')).toBe(true)
    expect(opts.rm).toHaveBeenCalled()
  })

  it('marks failed when the EDL is empty (nothing_to_render)', async () => {
    const opts = baseOpts({ loadState: async () => ({ version: 1, state: { clips: [], colour: {} } }) })
    await expect(renderVideo(opts)).rejects.toThrow(/nothing_to_render/)
    expect(opts.supabase.updates.some((u) => u.patch.status === 'failed')).toBe(true)
  })
})
