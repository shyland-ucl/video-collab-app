import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

// Table reads go through a tiny query recorder so each assertion can pin the
// data a section renders without a full supabase double.
const { tables, mockFrom, mockLoadLatestState, mockRenderDownloadUrl, mockFetchProjectEvents } =
  vi.hoisted(() => {
    const tables = {}
    const result = (table) => Promise.resolve(tables[table] ?? { data: [], error: null })
    // Every chain the page builds ends in a thenable, so awaiting any of them
    // resolves to that table's canned rows.
    const chain = (table) => {
      const node = {
        select: () => node,
        eq: () => node,
        order: () => node,
        single: () => result(table),
        maybeSingle: () => result(table),
        then: (onOk, onErr) => result(table).then(onOk, onErr),
      }
      return node
    }
    const mockFrom = vi.fn((table) => chain(table))
    return {
      tables,
      mockFrom,
      mockLoadLatestState: vi.fn(),
      mockRenderDownloadUrl: vi.fn(),
      mockFetchProjectEvents: vi.fn(),
    }
  })

vi.mock('../lib/supabaseClient', () => ({ supabase: { from: mockFrom } }))
vi.mock('../lib/editor/stateStore', () => ({ loadLatestState: mockLoadLatestState }))
vi.mock('../lib/editor/rendersApi', () => ({ renderDownloadUrl: mockRenderDownloadUrl }))
vi.mock('../lib/admin', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    fetchProjectEvents: mockFetchProjectEvents,
    fetchUserEmails: vi.fn(async () =>
      new Map([
        ['u1', 'creator@x.test'],
        ['u2', 'helper@x.test'],
      ])
    ),
  }
})

import AdminProjectPage from './AdminProjectPage'

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/admin/projects/p1']}>
      <Routes>
        <Route path="/admin/projects/:id" element={<AdminProjectPage />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('AdminProjectPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(tables)) delete tables[key]
    tables.projects = {
      data: {
        id: 'p1',
        title: 'Family holiday',
        status: 'active',
        owner_id: 'u1',
        created_at: '2026-08-20T10:00:00Z',
      },
      error: null,
    }
    mockLoadLatestState.mockResolvedValue(null)
    mockFetchProjectEvents.mockResolvedValue([])
    mockRenderDownloadUrl.mockResolvedValue(null)
  })

  it('marks the whole page read-only', async () => {
    renderPage()
    expect(await screen.findByText(/Nothing on this page can be changed/)).toBeInTheDocument()
  })

  it('names the participants behind the user ids', async () => {
    tables.project_members = {
      data: [
        { user_id: 'u1', role: 'creator', created_at: '2026-08-20T10:00:00Z' },
        { user_id: 'u2', role: 'helper', created_at: '2026-08-20T10:01:00Z' },
      ],
      error: null,
    }
    renderPage()
    expect(await screen.findByText('Creator: creator@x.test')).toBeInTheDocument()
    expect(screen.getByText('Helper: helper@x.test')).toBeInTheDocument()
  })

  it('shows a failed upload with its error', async () => {
    tables.videos = {
      data: [
        {
          id: 'v1',
          original_name: 'holiday.mp4',
          status: 'failed',
          error: 'ffmpeg killed (signal SIGKILL)',
          duration_seconds: null,
          width: null,
          height: null,
          size_bytes: 1048576,
          uploaded_by: 'u1',
          created_at: '2026-08-21T10:00:00Z',
        },
      ],
      error: null,
    }
    renderPage()
    expect(await screen.findByText('holiday.mp4')).toBeInTheDocument()
    expect(screen.getByText('failed')).toBeInTheDocument()
    expect(screen.getByText('ffmpeg killed (signal SIGKILL)')).toBeInTheDocument()
  })

  it('renders the saved timeline as scenes with trims applied', async () => {
    tables.videos = {
      data: [
        {
          id: 'v1',
          original_name: 'holiday.mp4',
          status: 'ready',
          error: null,
          duration_seconds: 120,
          width: 1920,
          height: 1080,
          size_bytes: 1048576,
          uploaded_by: 'u1',
          created_at: '2026-08-21T10:00:00Z',
        },
      ],
      error: null,
    }
    mockLoadLatestState.mockResolvedValue({
      version: 5,
      state: {
        clips: [
          {
            id: 'c1',
            sourceId: 'v1',
            name: 'Scene 1',
            startTime: 0,
            endTime: 30,
            trimStart: 5,
            trimEnd: 5,
            muted: true,
          },
        ],
        captions: [],
        textOverlays: [],
        colour: {},
      },
    })
    renderPage()
    expect(await screen.findByText('Scene 1')).toBeInTheDocument()
    // 0 + 5 in, 30 - 5 out, so a 20 second scene
    expect(screen.getByText('0:05')).toBeInTheDocument()
    expect(screen.getByText('0:25')).toBeInTheDocument()
    expect(screen.getByText('0:20')).toBeInTheDocument()
    expect(screen.getByText('yes')).toBeInTheDocument()
  })

  it('says so when the pair has not opened the editor', async () => {
    renderPage()
    expect(await screen.findByText(/has not opened the editor yet/)).toBeInTheDocument()
  })

  it('shows the interaction log roll-up', async () => {
    mockFetchProjectEvents.mockResolvedValue([
      { event_type: 'upload_started', event_count: 2, last_at: '2026-08-24T10:00:00Z' },
    ])
    renderPage()
    expect(await screen.findByText('upload_started')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  // renders are ordered newest first; a failed re-export sits above the working
  // one, and must not hide its download link.
  it('links the newest ready export even when a later one failed', async () => {
    tables.renders = {
      data: [
        {
          id: 'r2',
          status: 'failed',
          output_path: null,
          error: 'encode died',
          edl_version: 6,
          created_by: 'u1',
          created_at: '2026-08-25T10:00:00Z',
        },
        {
          id: 'r1',
          status: 'ready',
          output_path: 'p1/render/out.mp4',
          error: null,
          edl_version: 5,
          created_by: 'u1',
          created_at: '2026-08-24T10:00:00Z',
        },
      ],
      error: null,
    }
    mockRenderDownloadUrl.mockResolvedValue('https://signed.example/out.mp4')
    renderPage()
    const link = await screen.findByRole('link', { name: 'Open the exported video' })
    expect(link).toHaveAttribute('href', 'https://signed.example/out.mp4')
    expect(mockRenderDownloadUrl).toHaveBeenCalledWith(expect.anything(), 'p1/render/out.mp4')
  })

  it('reports a project it cannot read', async () => {
    tables.projects = { data: null, error: { message: 'no row' } }
    renderPage()
    expect(await screen.findByText('Project not found.')).toBeInTheDocument()
  })
})
