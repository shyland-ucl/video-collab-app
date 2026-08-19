import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

const { mockA11y } = vi.hoisted(() => ({
  mockA11y: {
    textSize: 'medium',
    theme: 'default',
    audioEnabled: false,
    speechRate: 1.2,
    setTextSize: vi.fn(),
    setTheme: vi.fn(),
    toggleAudio: vi.fn(),
    setSpeechRate: vi.fn(),
  },
}))

vi.mock('../contexts/AccessibilityContext', () => ({
  useAccessibility: () => mockA11y,
}))

vi.mock('../services/ttsService', () => ({
  default: { speak: vi.fn(), stop: vi.fn() },
}))

vi.mock('../utils/announcer', () => ({ announce: vi.fn() }))

import SettingsPage from './SettingsPage'
import ttsService from '../services/ttsService'
import { announce } from '../utils/announcer'

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <SettingsPage />
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockA11y.textSize = 'medium'
  mockA11y.theme = 'default'
  mockA11y.audioEnabled = false
  mockA11y.speechRate = 1.2
})

describe('SettingsPage', () => {
  it('renders a heading and a back link to projects', () => {
    renderPage()
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /back/i })).toHaveAttribute('href', '/')
  })

  it('renders the three controls reflecting context state', () => {
    renderPage()
    // Text size radios — medium checked.
    expect(screen.getByRole('radio', { name: 'Small' })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: 'Medium' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Large' })).not.toBeChecked()
    // Spoken edit prompts checkbox — off.
    expect(screen.getByRole('checkbox', { name: /spoken edit prompts/i })).not.toBeChecked()
    // Speech rate slider — 1.2.
    const slider = screen.getByRole('slider', { name: /speech rate/i })
    expect(slider).toHaveValue('1.2')
  })

  it('reflects context state when audio is on and text size is large', () => {
    mockA11y.audioEnabled = true
    mockA11y.textSize = 'large'
    renderPage()
    expect(screen.getByRole('radio', { name: 'Large' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /spoken edit prompts/i })).toBeChecked()
  })

  it('selecting Large calls setTextSize with "large"', async () => {
    renderPage()
    await userEvent.click(screen.getByRole('radio', { name: 'Large' }))
    expect(mockA11y.setTextSize).toHaveBeenCalledWith('large')
  })

  it('selecting Large announces the new text size', async () => {
    renderPage()
    await userEvent.click(screen.getByRole('radio', { name: 'Large' }))
    expect(announce).toHaveBeenCalledWith(expect.stringMatching(/text size large/i))
  })

  it('toggling spoken edit prompts calls toggleAudio and announces the new state', async () => {
    renderPage()
    await userEvent.click(screen.getByRole('checkbox', { name: /spoken edit prompts/i }))
    expect(mockA11y.toggleAudio).toHaveBeenCalledTimes(1)
    // off -> on
    expect(announce).toHaveBeenCalledWith('Spoken edit prompts on')
  })

  it('announces off when toggling spoken edit prompts while currently on', async () => {
    mockA11y.audioEnabled = true
    renderPage()
    await userEvent.click(screen.getByRole('checkbox', { name: /spoken edit prompts/i }))
    expect(mockA11y.toggleAudio).toHaveBeenCalledTimes(1)
    expect(announce).toHaveBeenCalledWith('Spoken edit prompts off')
  })

  it('moving the speech rate calls setSpeechRate with the number, speaks a sample, and announces', () => {
    renderPage()
    const slider = screen.getByRole('slider', { name: /speech rate/i })
    fireEvent.change(slider, { target: { value: '1.5' } })
    expect(mockA11y.setSpeechRate).toHaveBeenCalledWith(1.5)
    expect(ttsService.speak).toHaveBeenCalledWith(
      'This is how fast spoken edit prompts will be read.',
      { rate: 1.5 }
    )
    expect(announce).toHaveBeenCalledWith('Speech rate 1.5')
  })
})

describe('SettingsPage themes', () => {
  it('offers all four colour themes and extra-large text', () => {
    renderPage()
    for (const name of ['Default', 'Dark', 'High contrast dark', 'High contrast light']) {
      expect(screen.getByRole('radio', { name: new RegExp('^' + name, 'i') })).toBeInTheDocument()
    }
    expect(screen.getByRole('radio', { name: /extra large/i })).toBeInTheDocument()
  })

  it('selecting a theme dispatches and announces it', async () => {
    renderPage()
    await userEvent.click(screen.getByRole('radio', { name: /high contrast dark/i }))
    expect(mockA11y.setTheme).toHaveBeenCalledWith('hc-dark')
    expect(announce).toHaveBeenCalledWith('Colour theme High contrast dark')
  })

  it('selecting extra large dispatches the new size', async () => {
    renderPage()
    await userEvent.click(screen.getByRole('radio', { name: /extra large/i }))
    expect(mockA11y.setTextSize).toHaveBeenCalledWith('x-large')
  })
})
