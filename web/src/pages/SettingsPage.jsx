import { Link } from 'react-router-dom'
import { useAccessibility } from '../contexts/AccessibilityContext'
import ttsService from '../services/ttsService'
import { announce } from '../utils/announcer'

const TEXT_SIZE_OPTIONS = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
  { value: 'x-large', label: 'Extra large' },
]

// Swatches PREVIEW each target theme, so they are deliberately literal values
// (mirroring index.css) rather than live tokens — a preview must not restyle
// when the active theme changes.
const THEME_OPTIONS = [
  {
    value: 'default',
    label: 'Default',
    hint: 'Warm light background',
    swatch: { canvas: '#faf9f6', ink: '#1c1b1a', brand: '#0f766e' },
  },
  {
    value: 'dark',
    label: 'Dark',
    hint: 'Light text on a dark background',
    swatch: { canvas: '#161511', ink: '#f2efe9', brand: '#2dd4bf' },
  },
  {
    value: 'hc-dark',
    label: 'High contrast dark',
    hint: 'Bright text on black, strong borders',
    swatch: { canvas: '#000000', ink: '#ffffff', brand: '#5eead4' },
  },
  {
    value: 'hc-light',
    label: 'High contrast light',
    hint: 'Black text on white, strong borders',
    swatch: { canvas: '#ffffff', ink: '#000000', brand: '#005a54' },
  },
]

function ThemeSwatch({ swatch }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-8 w-12 shrink-0 items-center justify-center gap-1 rounded-md border border-line-strong"
      style={{ backgroundColor: swatch.canvas }}
    >
      <span className="h-3 w-3 rounded-full" style={{ backgroundColor: swatch.ink }} />
      <span className="h-3 w-3 rounded-full" style={{ backgroundColor: swatch.brand }} />
    </span>
  )
}

const RATE_SAMPLE = 'This is how fast spoken edit prompts will be read.'

export default function SettingsPage() {
  const { textSize, theme, audioEnabled, speechRate, setTextSize, setTheme, toggleAudio, setSpeechRate } =
    useAccessibility()

  function handleTextSize(value) {
    setTextSize(value)
    announce(`Text size ${value}`)
  }

  function handleTheme(option) {
    setTheme(option.value)
    announce(`Colour theme ${option.label}`)
  }

  function handleToggleAudio() {
    // audioEnabled is the value BEFORE the toggle; the new state is the inverse.
    toggleAudio()
    announce(`Spoken edit prompts ${audioEnabled ? 'off' : 'on'}`)
  }

  function handleRateChange(e) {
    const rate = Number(e.target.value)
    setSpeechRate(rate)
    ttsService.speak(RATE_SAMPLE, { rate })
    announce(`Speech rate ${rate}`)
  }

  return (
    <main id="main" tabIndex={-1} className="page">
      <Link to="/" className="link-back mb-3"><span aria-hidden="true">←</span> Back to projects</Link>
      <h1 className="page-title mb-7">Settings</h1>

      <fieldset className="mb-7 border-0 p-0">
        <legend className="label mb-2.5">Text size</legend>
        <div className="space-y-2.5">
          {TEXT_SIZE_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex min-h-12 cursor-pointer items-center gap-3 rounded-field border border-line bg-surface px-4 shadow-card transition-colors hover:bg-sunken has-[:checked]:border-brand has-[:checked]:bg-brand-soft"
            >
              <input
                type="radio"
                name="textSize"
                value={opt.value}
                checked={textSize === opt.value}
                onChange={() => handleTextSize(opt.value)}
                className="h-5 w-5 accent-brand"
              />
              <span className="font-semibold">{opt.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="mb-7 border-0 p-0">
        <legend className="label mb-2.5">Colour theme</legend>
        <div className="space-y-2.5">
          {THEME_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex min-h-12 cursor-pointer items-center gap-3 rounded-field border border-line bg-surface px-4 py-2.5 shadow-card transition-colors hover:bg-sunken has-[:checked]:border-brand has-[:checked]:bg-brand-soft"
            >
              <input
                type="radio"
                name="theme"
                value={opt.value}
                checked={theme === opt.value}
                onChange={() => handleTheme(opt)}
                className="h-5 w-5 shrink-0 accent-brand"
              />
              <ThemeSwatch swatch={opt.swatch} />
              <span className="min-w-0">
                <span className="block font-semibold">{opt.label}</span>
                <span className="muted block text-sm">{opt.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mb-7">
        <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-field border border-line bg-surface px-4 shadow-card transition-colors hover:bg-sunken has-[:checked]:border-brand has-[:checked]:bg-brand-soft">
          <input
            type="checkbox"
            name="spoken-edit-prompts"
            checked={audioEnabled}
            onChange={handleToggleAudio}
            className="h-5 w-5 accent-brand"
          />
          <span className="font-semibold">Spoken edit prompts</span>
        </label>
        <p className="muted mt-1.5 text-sm">
          Read edit confirmations and AI clarifications aloud while you work.
        </p>
      </div>

      <div className="mb-7">
        <label htmlFor="speech-rate" className="label">
          Speech rate: {speechRate}
        </label>
        <div className="flex min-h-12 items-center">
          <input
            id="speech-rate"
            name="speech-rate"
            type="range"
            min={0.5}
            max={2}
            step={0.1}
            value={speechRate}
            onChange={handleRateChange}
            className="w-full accent-brand"
          />
        </div>
      </div>
    </main>
  )
}
