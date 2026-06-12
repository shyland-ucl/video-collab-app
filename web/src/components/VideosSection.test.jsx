import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

const { mockOrder, mockInsert, mockUpload, mockServerPost, mockAnnounce } = vi.hoisted(() => ({
  mockOrder: vi.fn(),
  mockInsert: vi.fn(),
  mockUpload: vi.fn(),
  mockServerPost: vi.fn(),
  mockAnnounce: vi.fn(),
}))

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ order: mockOrder })),
      })),
      insert: mockInsert,
    })),
  },
}))
vi.mock('../lib/uploadVideo', () => ({ uploadVideo: mockUpload }))
vi.mock('../lib/serverApi', () => ({ serverPost: mockServerPost }))
vi.mock('../utils/announcer', () => ({ announce: mockAnnounce }))
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ session: { access_token: 'tok', user: { id: 'u1' } }, user: { id: 'u1' } }),
}))

import VideosSection from './VideosSection'

function renderSection() {
  return render(
    <MemoryRouter>
      <VideosSection projectId="proj-1" />
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockOrder.mockResolvedValue({ data: [], error: null })
  mockInsert.mockResolvedValue({ error: null })
  mockUpload.mockResolvedValue()
  mockServerPost.mockResolvedValue({ ok: true })
})

describe('VideosSection', () => {
  it('shows an empty state when there are no videos', async () => {
    renderSection()
    expect(await screen.findByText(/no videos yet/i)).toBeInTheDocument()
  })

  it('lists videos with their status', async () => {
    mockOrder.mockResolvedValue({
      data: [
        { id: 'v1', original_name: 'kitchen.mp4', status: 'ready', error: null, created_at: '2026-06-12' },
        { id: 'v2', original_name: 'garden.mp4', status: 'processing', error: null, created_at: '2026-06-12' },
      ],
      error: null,
    })
    renderSection()
    expect(await screen.findByText('kitchen.mp4')).toBeInTheDocument()
    expect(screen.getByText(/ready/i)).toBeInTheDocument()
    expect(screen.getByText(/processing/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /view scenes and descriptions for kitchen\.mp4/i })).toHaveAttribute(
      'href', '/projects/proj-1/videos/v1'
    )
  })

  it('uploads a chosen file: inserts row, runs TUS upload, triggers processing', async () => {
    renderSection()
    const input = await screen.findByLabelText(/upload a video/i)
    const file = new File(['vid'], 'myclip.mp4', { type: 'video/mp4' })
    await userEvent.upload(input, file)

    await waitFor(() => expect(mockServerPost).toHaveBeenCalled())

    const inserted = mockInsert.mock.calls[0][0]
    expect(inserted.project_id).toBe('proj-1')
    expect(inserted.uploaded_by).toBe('u1')
    expect(inserted.original_name).toBe('myclip.mp4')
    expect(inserted.storage_path).toBe(`proj-1/${inserted.id}/original.mp4`)

    expect(mockUpload).toHaveBeenCalledWith(
      expect.objectContaining({ objectName: inserted.storage_path, accessToken: 'tok' })
    )
    expect(mockServerPost).toHaveBeenCalledWith(`/api/videos/${inserted.id}/process`)
    expect(mockAnnounce).toHaveBeenCalledWith('Upload complete. Processing started.')
  })

  it('announces assertively and shows the error when the upload fails', async () => {
    mockUpload.mockRejectedValue(new Error('network gone'))
    renderSection()
    const input = await screen.findByLabelText(/upload a video/i)
    await userEvent.upload(input, new File(['v'], 'bad.mp4', { type: 'video/mp4' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/network gone/)
    expect(mockAnnounce).toHaveBeenCalledWith('Upload failed', { assertive: true })
    expect(mockServerPost).not.toHaveBeenCalled()
  })

  it('retries a failed video', async () => {
    mockOrder.mockResolvedValue({
      data: [{ id: 'v9', original_name: 'broken.mp4', status: 'failed', error: 'gemini_down', created_at: '2026-06-12' }],
      error: null,
    })
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: /retry processing broken\.mp4/i }))
    expect(mockServerPost).toHaveBeenCalledWith('/api/videos/v9/process')
  })

  // Fix 2: stuck-uploading row gets a Retry button
  it('offers retry for a stuck uploading row when no upload is in flight', async () => {
    mockOrder.mockResolvedValue({
      data: [{ id: 'v7', original_name: 'stuck.mp4', status: 'uploading', error: null, created_at: '2026-06-12' }],
      error: null,
    })
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: /retry processing stuck\.mp4/i }))
    expect(mockServerPost).toHaveBeenCalledWith('/api/videos/v7/process')
  })

  // Fix 5: processing-start failure announced separately from upload failure
  it('announces processing-start failure separately when upload succeeded', async () => {
    mockServerPost.mockRejectedValue(new Error('already_processing'))
    renderSection()
    const input = await screen.findByLabelText(/upload a video/i)
    await userEvent.upload(input, new File(['v'], 'late.mp4', { type: 'video/mp4' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/already being processed/i)
    expect(mockAnnounce).toHaveBeenCalledWith('Processing could not start', { assertive: true })
    expect(mockUpload).toHaveBeenCalled()
  })

  // Fix 6: client-side 50 MB guard
  it('rejects files over 50 MB before inserting anything', async () => {
    renderSection()
    const input = await screen.findByLabelText(/upload a video/i)
    const big = new File(['x'], 'big.mp4', { type: 'video/mp4' })
    Object.defineProperty(big, 'size', { value: 51 * 1024 * 1024 })
    await userEvent.upload(input, big)
    expect(await screen.findByRole('alert')).toHaveTextContent(/larger than 50 MB/i)
    expect(mockInsert).not.toHaveBeenCalled()
    expect(mockUpload).not.toHaveBeenCalled()
  })

  // Fix 9: announce exactly once on ready transition
  it('announces exactly once when a video transitions to ready', async () => {
    vi.useFakeTimers()
    try {
      const processing = { id: 'v1', original_name: 'kitchen.mp4', status: 'processing', error: null, created_at: '2026-06-12' }
      mockOrder
        .mockResolvedValueOnce({ data: [processing], error: null })
        .mockResolvedValue({ data: [{ ...processing, status: 'ready' }], error: null })
      renderSection()
      await act(async () => {}) // initial load resolves
      expect(screen.getByText(/processing/i)).toBeInTheDocument()
      expect(mockAnnounce).not.toHaveBeenCalled() // first sight is silent
      await act(async () => { await vi.advanceTimersByTimeAsync(4000) }) // poll sees ready
      expect(mockAnnounce).toHaveBeenCalledTimes(1)
      expect(mockAnnounce).toHaveBeenCalledWith('kitchen.mp4 is ready')
      await act(async () => { await vi.advanceTimersByTimeAsync(4000) }) // no re-announce
      expect(mockAnnounce).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  // Fix 10: insert-failure path
  it('announces when the videos row cannot be created', async () => {
    mockInsert.mockResolvedValue({ error: { message: 'row violates row-level security' } })
    renderSection()
    const input = await screen.findByLabelText(/upload a video/i)
    await userEvent.upload(input, new File(['v'], 'no.mp4', { type: 'video/mp4' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/row-level security/i)
    expect(mockAnnounce).toHaveBeenCalledWith('Upload could not start', { assertive: true })
    expect(mockUpload).not.toHaveBeenCalled()
  })
})
