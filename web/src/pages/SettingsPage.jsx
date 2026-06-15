import { Link } from 'react-router-dom'
import { useAccessibility } from '../contexts/AccessibilityContext'
import ttsService from '../services/ttsService'
import { announce } from '../utils/announcer'

// Apply the chosen size to this page's own content so the user sees + hears
// the effect immediately (the editor consumes textSize for its own scaling).
const TEXT_SIZE_CLASS = {
  small: 'text-base',
  medium: 'text-lg',
  large: 'text-2xl',
}

const TEXT_SIZE_OPTIONS = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
]

const RATE_SAMPLE = 'This is how fast descriptions will be read.'

export default function SettingsPage() {
  const { textSize, audioEnabled, speechRate, setTextSize, toggleAudio, setSpeechRate } =
    useAccessibility()

  function handleTextSize(value) {
    setTextSize(value)
    announce(`Text size ${value}`)
  }

  function handleToggleAudio() {
    // audioEnabled is the value BEFORE the toggle; the new state is the inverse.
    toggleAudio()
    announce(`Spoken descriptions ${audioEnabled ? 'off' : 'on'}`)
  }

  function handleRateChange(e) {
    const rate = Number(e.target.value)
    setSpeechRate(rate)
    ttsService.speak(RATE_SAMPLE, { rate })
    announce(`Speech rate ${rate}`)
  }

  return (
    <main
      id="main"
      tabIndex={-1}
      className={`page ${TEXT_SIZE_CLASS[textSize] ?? TEXT_SIZE_CLASS.medium}`}
    >
      <Link to="/" className="link-back mb-3">← Back to projects</Link>
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

      <div className="mb-7">
        <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-field border border-line bg-surface px-4 shadow-card transition-colors hover:bg-sunken has-[:checked]:border-brand has-[:checked]:bg-brand-soft">
          <input
            type="checkbox"
            checked={audioEnabled}
            onChange={handleToggleAudio}
            className="h-5 w-5 accent-brand"
          />
          <span className="font-semibold">Spoken descriptions</span>
        </label>
        <p className="muted mt-1.5 text-sm">
          Read scene descriptions aloud while you work.
        </p>
      </div>

      <div className="mb-7">
        <label htmlFor="speech-rate" className="label">
          Speech rate: {speechRate}
        </label>
        <div className="flex min-h-12 items-center">
          <input
            id="speech-rate"
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
