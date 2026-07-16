import { describe, it, expect, vi, beforeEach } from 'vitest'

const created = []
vi.mock('tus-js-client', () => {
  class FakeUpload {
    constructor(file, options) {
      this.file = file
      this.options = options
      created.push(this)
    }
    findPreviousUploads() { return Promise.resolve([]) }
    resumeFromPreviousUpload() {}
    start() {
      this.options.onProgress?.(3 * 1024 * 1024, 6 * 1024 * 1024)
      this.options.onSuccess?.()
    }
  }
  return { Upload: FakeUpload }
})

import { uploadVideo } from './uploadVideo'

beforeEach(() => { created.length = 0 })

describe('uploadVideo', () => {
  it('uploads via the supabase resumable endpoint with 6MB chunks and reports progress', async () => {
    const file = new File(['x'], 'clip.mp4', { type: 'video/mp4' })
    const onProgress = vi.fn()

    await uploadVideo({
      supabaseUrl: 'https://ref.supabase.co',
      accessToken: 'tok-123',
      objectName: 'proj-1/vid-1/original.mp4',
      file,
      onProgress,
    })

    const upload = created[0]
    expect(upload.options.endpoint).toBe('https://ref.supabase.co/storage/v1/upload/resumable')
    expect(upload.options.chunkSize).toBe(6 * 1024 * 1024)
    expect(upload.options.headers.authorization).toBe('Bearer tok-123')
    expect(upload.options.metadata).toMatchObject({
      bucketName: 'videos',
      objectName: 'proj-1/vid-1/original.mp4',
      contentType: 'video/mp4',
    })
    expect(onProgress).toHaveBeenCalledWith(50)
  })

  it('uses a destination-specific resume fingerprint', async () => {
    const file = new File(['same bytes'], 'clip.mp4', { type: 'video/mp4' })

    await uploadVideo({
      supabaseUrl: 'https://ref.supabase.co',
      accessToken: 't',
      objectName: 'project-a/video-a/original.mp4',
      file,
    })
    await uploadVideo({
      supabaseUrl: 'https://ref.supabase.co',
      accessToken: 't',
      objectName: 'project-b/video-b/original.mp4',
      file,
    })

    const first = await created[0].options.fingerprint(file, created[0].options)
    const second = await created[1].options.fingerprint(file, created[1].options)
    expect(first).toContain('project-a/video-a/original.mp4')
    expect(second).toContain('project-b/video-b/original.mp4')
    expect(first).not.toBe(second)
  })

  it('rejects when the upload errors', async () => {
    const file = new File(['x'], 'clip.mp4', { type: 'video/mp4' })
    // make the fake fail this time
    const { Upload } = await import('tus-js-client')
    Upload.prototype.start = function () { this.options.onError?.(new Error('network gone')) }

    await expect(
      uploadVideo({
        supabaseUrl: 'https://ref.supabase.co',
        accessToken: 't',
        objectName: 'p/v/original.mp4',
        file,
      })
    ).rejects.toThrow('network gone')
  })
})
