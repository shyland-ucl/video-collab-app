import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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
    expect(screen.getByRole('link', { name: /open kitchen\.mp4/i })).toHaveAttribute(
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
    await userEvent.click(await screen.findByRole('button', { name: /retry broken\.mp4/i }))
    expect(mockServerPost).toHaveBeenCalledWith('/api/videos/v9/process')
  })
})
