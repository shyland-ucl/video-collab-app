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
    <div role="region" aria-label="Text overlay settings" className="border-2 border-[#fbbf24] rounded-xl overflow-hidden bg-white mt-3">
      <div className="bg-[#fef3c7] px-3 py-2.5 border-b border-[#fde68a] flex items-center justify-between">
        <span className="text-xs font-bold tracking-wide text-[#92400e] uppercase">Text Overlay</span>
        <span className="bg-[#fbbf24] text-[#1a1a2e] px-2 py-0.5 rounded-full text-xs font-semibold">Active</span>
      </div>
      <div className="p-4 flex flex-col gap-3">
        <input
          type="text"
          value={overlay.content}
          onChange={(e) => onChange('content', e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-2 focus:outline-[#fbbf24]"
          style={{ minHeight: '44px' }}
          aria-label="Text content"
          placeholder="Type your text..."
        />

        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-500 uppercase w-10">Size</span>
          <div className="flex gap-2 flex-1">
            {SIZES.map((size) => (
              <button
                key={size}
                onClick={() => onChange('size', size)}
                className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-colors focus:outline-2 focus:outline-offset-1 focus:outline-[#2B579A] ${
                  overlay.size === size
                    ? 'bg-[#2B579A] text-white'
                    : 'bg-[#f1f5f9] text-[#475569] hover:bg-gray-200'
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
          <span className="text-xs font-semibold text-gray-500 uppercase w-10">Color</span>
          <div className="flex gap-2 flex-1">
            {COLORS.map(({ value, label }) => (
              <button
                key={value}
                onClick={() => onChange('color', value)}
                className={`flex-1 rounded-lg transition-colors focus:outline-2 focus:outline-offset-1 focus:outline-[#2B579A] ${
                  overlay.color === value ? 'ring-2 ring-[#2B579A] ring-offset-1' : ''
                }`}
                style={{
                  backgroundColor: value,
                  minHeight: '44px',
                  border: value === '#FFFFFF' ? '1px solid #e2e8f0' : 'none',
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
            className="flex-1 py-2.5 rounded-lg bg-[#fbbf24] text-sm font-bold text-[#1a1a2e] hover:bg-amber-400 focus:outline-2 focus:outline-offset-1 focus:outline-[#fbbf24]"
            style={{ minHeight: '44px' }}
            aria-label="Apply text overlay"
          >
            ✓ Apply Text
          </button>
          <button
            onClick={onRemove}
            className="flex-1 py-2.5 rounded-lg border border-gray-300 text-sm font-semibold text-gray-600 hover:bg-gray-50 focus:outline-2 focus:outline-offset-1 focus:outline-gray-400"
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
