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

  it('rendering: shows a polite live status without role="status"', () => {
    render(<ExportPanel render={{ status: 'rendering' }} onExport={vi.fn()} getDownloadUrl={vi.fn()} />)
    const msg = screen.getByText(/rendering your video/i)
    expect(msg.closest('[aria-live="polite"]')).not.toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('ready: resolves the signed URL and shows a Download link', async () => {
    const getDownloadUrl = vi.fn(async () => 'https://signed/out.mp4')
    render(<ExportPanel render={{ status: 'ready', output_path: 'p1/renders/r1.mp4' }} onExport={vi.fn()} getDownloadUrl={getDownloadUrl} />)
    expect(getDownloadUrl).toHaveBeenCalledWith('p1/renders/r1.mp4')
    const link = await screen.findByRole('link', { name: /download video/i })
    expect(link).toHaveAttribute('href', 'https://signed/out.mp4')
  })

  it('failed: shows the failure note + a retry Export button', () => {
    render(<ExportPanel render={{ status: 'failed' }} onExport={vi.fn()} getDownloadUrl={vi.fn()} />)
    expect(screen.getByText(/the export failed/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /export this project as a video$/i })).toBeInTheDocument()
  })
})
