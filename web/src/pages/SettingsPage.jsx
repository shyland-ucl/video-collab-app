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
      className={`mx-auto max-w-lg p-4 ${TEXT_SIZE_CLASS[textSize] ?? TEXT_SIZE_CLASS.medium}`}
    >
      <Link to="/" className="inline-block min-h-12 underline">
        Back to projects
      </Link>
      <h1 className="mb-6 mt-2 text-2xl font-bold">Settings</h1>

      <fieldset className="mb-8 border-0 p-0">
        <legend className="mb-2 block font-semibold">Text size</legend>
        <div className="space-y-2">
          {TEXT_SIZE_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex min-h-12 items-center gap-3 rounded border border-gray-300 px-3"
            >
              <input
                type="radio"
                name="textSize"
                value={opt.value}
                checked={textSize === opt.value}
                onChange={() => handleTextSize(opt.value)}
                className="h-5 w-5"
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mb-8">
        <label className="flex min-h-12 items-center gap-3 rounded border border-gray-300 px-3">
          <input
            type="checkbox"
            checked={audioEnabled}
            onChange={handleToggleAudio}
            className="h-5 w-5"
          />
          <span className="font-semibold">Spoken descriptions</span>
        </label>
        <p className="mt-1 text-sm text-gray-600">
          Read scene descriptions aloud while you work.
        </p>
      </div>

      <div className="mb-8">
        <label htmlFor="speech-rate" className="mb-2 block font-semibold">
          Speech rate: {speechRate}
        </label>
        <div className="min-h-12 flex items-center">
          <input
            id="speech-rate"
            type="range"
            min={0.5}
            max={2}
            step={0.1}
            value={speechRate}
            onChange={handleRateChange}
            className="w-full"
          />
        </div>
      </div>

    </main>
  )
}
