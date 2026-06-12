import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { mockVideoSingle, mockSegmentsOrder, mockSignedUrls } = vi.hoisted(() => ({
  mockVideoSingle: vi.fn(),
  mockSegmentsOrder: vi.fn(),
  mockSignedUrls: vi.fn(),
}))

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    from: vi.fn((table) => {
      if (table === 'videos') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: mockVideoSingle })) })) }
      }
      if (table === 'segments') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ order: mockSegmentsOrder })) })) }
      }
      return {}
    }),
    storage: { from: vi.fn(() => ({ createSignedUrls: mockSignedUrls })) },
  },
}))

import VideoPage from './VideoPage'

const VIDEO = {
  id: 'v1',
  original_name: 'kitchen.mp4',
  status: 'ready',
  duration_seconds: 7,
  storage_path: 'p1/v1/original.mp4',
}

const SEGMENTS = [
  {
    id: 's1', idx: 1, label: 'Scene 1', start_seconds: 0, end_seconds: 5,
    keyframe_path: 'p1/v1/keyframes/seg_001_kf.jpg',
    descriptions: [
      { level: 1, text: 'Someone stirs a pot.' },
      { level: 2, text: 'A person in a blue apron stirs a steel pot on a gas hob.' },
      { level: 3, text: 'Static shot, slightly overexposed near the window.' },
    ],
  },
  {
    id: 's2', idx: 2, label: 'Scene 2', start_seconds: 5, end_seconds: 7,
    keyframe_path: 'p1/v1/keyframes/seg_002_kf.jpg',
    descriptions: [
      { level: 1, text: 'They taste the food.' },
      { level: 2, text: 'The person lifts a wooden spoon to taste.' },
      { level: 3, text: 'Close-up, shallow focus on the spoon.' },
    ],
  },
]

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/projects/p1/videos/v1']}>
      <Routes>
        <Route path="/projects/:projectId/videos/:videoId" element={<VideoPage />} />
      </Routes>
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockVideoSingle.mockResolvedValue({ data: VIDEO, error: null })
  mockSegmentsOrder.mockResolvedValue({ data: SEGMENTS, error: null })
  mockSignedUrls.mockResolvedValue({
    data: [
      { path: 'p1/v1/original.mp4', signedUrl: 'https://signed/original', error: null },
      { path: 'p1/v1/keyframes/seg_001_kf.jpg', signedUrl: 'https://signed/kf1', error: null },
      { path: 'p1/v1/keyframes/seg_002_kf.jpg', signedUrl: 'https://signed/kf2', error: null },
    ],
    error: null,
  })
})

describe('VideoPage', () => {
  it('shows the video title, player, and level-1 descriptions by default', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: 'kitchen.mp4' })).toBeInTheDocument()
    expect(await screen.findByText('Someone stirs a pot.')).toBeInTheDocument()
    expect(screen.getByText('They taste the food.')).toBeInTheDocument()
    expect(screen.queryByText(/blue apron/)).not.toBeInTheDocument()
  })

  it('switches description level with the radio group', async () => {
    renderPage()
    await screen.findByText('Someone stirs a pot.')
    await userEvent.click(screen.getByRole('radio', { name: /what's visible/i }))
    expect(screen.getByText(/blue apron/)).toBeInTheDocument()
    expect(screen.queryByText('Someone stirs a pot.')).not.toBeInTheDocument()
  })

  it('renders keyframes with the scene label as alt text', async () => {
    renderPage()
    const img = await screen.findByAltText(/keyframe for scene 1/i)
    expect(img).toHaveAttribute('src', 'https://signed/kf1')
  })

  it('shows an error when the video is not accessible', async () => {
    mockVideoSingle.mockResolvedValue({ data: null, error: { message: 'nope' } })
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent(/not found, or you are not a member/i)
  })
})
