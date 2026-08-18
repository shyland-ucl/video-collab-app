// Ported from probe src/components/shared/TextOverlaySettings.jsx (Task 10).
// Nothing stripped — purely presentational; no probe-only imports.

const SIZES = ['S', 'M', 'L']
const COLORS = [
  { value: '#FFFFFF', label: 'White' },
  { value: '#fbbf24', label: 'Yellow' },
  { value: '#ef4444', label: 'Red' },
  { value: '#22c55e', label: 'Green' },
]

export default function TextOverlaySettings({ overlay, onChange, onApply, onRemove }) {
  if (!overlay) return null

  return (
    <div role="region" aria-label="Text overlay settings" className="border-2 border-helper rounded-xl overflow-hidden bg-surface mt-3">
      <div className="bg-helper-soft px-3 py-2.5 border-b border-helper/40 flex items-center justify-between">
        <span className="text-xs font-bold tracking-wide text-helper uppercase">Text Overlay</span>
        <span className="bg-helper text-on-accent px-2 py-0.5 rounded-full text-xs font-semibold">Active</span>
      </div>
      <div className="p-4 flex flex-col gap-3">
        <input
          type="text"
          value={overlay.content}
          onChange={(e) => onChange('content', e.target.value)}
          className="w-full px-3 py-2 border border-line-strong bg-surface text-ink rounded-lg text-sm"
          style={{ minHeight: '44px' }}
          aria-label="Text content"
          placeholder="Type your text..."
        />

        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-ink-soft uppercase w-10">Size</span>
          <div className="flex gap-2 flex-1">
            {SIZES.map((size) => (
              <button
                key={size}
                onClick={() => onChange('size', size)}
                className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-colors ${
                  overlay.size === size
                    ? 'bg-brand text-on-brand'
                    : 'bg-sunken text-ink-soft hover:bg-line'
                }`}
                style={{ minHeight: '44px' }}
                aria-label={`Size ${size}`}
                aria-pressed={overlay.size === size}
              >
                {size}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-ink-soft uppercase w-10">Color</span>
          <div className="flex gap-2 flex-1">
            {COLORS.map(({ value, label }) => (
              <button
                key={value}
                onClick={() => onChange('color', value)}
                className={`flex-1 rounded-lg transition-colors ${
                  overlay.color === value ? 'ring-2 ring-focus' : ''
                }`}
                style={{
                  backgroundColor: value,
                  minHeight: '44px',
                  border: value === '#FFFFFF' ? '1px solid var(--color-line-strong)' : 'none',
                }}
                aria-label={`Color: ${label}`}
                aria-pressed={overlay.color === value}
              />
            ))}
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={onApply}
            className="flex-1 py-2.5 rounded-lg bg-helper text-sm font-bold text-on-accent hover:opacity-90"
            style={{ minHeight: '44px' }}
            aria-label="Apply text overlay"
          >
            ✓ Apply Text
          </button>
          <button
            onClick={onRemove}
            className="flex-1 py-2.5 rounded-lg border border-line-strong text-sm font-semibold text-ink-soft hover:bg-sunken"
            style={{ minHeight: '44px' }}
            aria-label="Remove text overlay"
          >
            ✕ Remove
          </button>
        </div>
      </div>
    </div>
  )
}
