import { useEffect, useRef } from 'react'
import { announce } from '../../utils/announcer'

// Ported from probe src/components/shared/SegmentMarkerPanel.jsx (Task 10).
// Stripped: nothing probe-only. Import path for announcer adjusted to this repo.
// The probe `segment` shape (name, color, start_time, end_time) is fed from a
// state.clips entry by HelperDevice (startTime/endTime mapped to start_time/
// end_time so this stays byte-faithful to the probe).

function formatTimeRange(start, end) {
  const fmt = (s) => {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }
  return `${fmt(start)} - ${fmt(end)}`
}

export default function SegmentMarkerPanel({ segment }) {
  const prevSegIdRef = useRef(null)

  useEffect(() => {
    if (segment && segment.id !== prevSegIdRef.current) {
      prevSegIdRef.current = segment.id
      announce(`New segment: ${segment.name}`)
    } else if (!segment) {
      prevSegIdRef.current = null
    }
  }, [segment])

  return (
    <div
      className="px-4 py-2 bg-sunken border border-line rounded text-sm"
      aria-label="Current segment information"
    >
      {segment ? (
        <div className="flex items-center gap-2">
          <span
            className="inline-block w-3 h-3 rounded-full shrink-0"
            style={{ backgroundColor: segment.color }}
            aria-hidden="true"
          />
          <span className="font-semibold">{segment.name}</span>
          <span className="text-ink-soft">
            {formatTimeRange(segment.start_time, segment.end_time)}
          </span>
        </div>
      ) : (
        <span className="text-ink-faint">No segment selected</span>
      )}
    </div>
  )
}
