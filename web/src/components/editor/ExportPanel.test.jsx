import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ExportPanel from './ExportPanel'

describe('ExportPanel', () => {
  it('idle: shows the Export button and fires onExport once', async () => {
    const onExport = vi.fn()
    render(<ExportPanel render={null} onExport={onExport} getDownloadUrl={vi.fn()} />)
    const btn = screen.getByRole('button', { name: /export this project as a video$/i })
    await userEvent.click(btn)
    expect(onExport).toHaveBeenCalledTimes(1)
  })

  it('rendering: shows a visual status that is NOT a live region (EditorPage announces it)', () => {
    render(<ExportPanel render={{ status: 'rendering' }} onExport={vi.fn()} getDownloadUrl={vi.fn()} />)
    const msg = screen.getByText(/rendering your video/i)
    expect(msg.closest('[aria-live]')).toBeNull() // no duplicate live region
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('ready: resolves the signed URL, shows a Download link, and focuses it', async () => {
    const getDownloadUrl = vi.fn(async () => 'https://signed/out.mp4')
    render(<ExportPanel render={{ status: 'ready', output_path: 'p1/renders/r1.mp4' }} onExport={vi.fn()} getDownloadUrl={getDownloadUrl} />)
    expect(getDownloadUrl).toHaveBeenCalledWith('p1/renders/r1.mp4')
    const link = await screen.findByRole('link', { name: /download video/i })
    expect(link).toHaveAttribute('href', 'https://signed/out.mp4')
    // focus lands on the link (it replaced the Export button — no <body> strand)
    await waitFor(() => expect(document.activeElement).toBe(link))
  })

  it('failed: shows the failure note + a retry Export button', () => {
    render(<ExportPanel render={{ status: 'failed' }} onExport={vi.fn()} getDownloadUrl={vi.fn()} />)
    expect(screen.getByText(/the export failed/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /export this project as a video$/i })).toBeInTheDocument()
  })
})
