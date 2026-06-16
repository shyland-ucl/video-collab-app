// Shared definition of the AI-fixable visual/audio actions and their numeric
// ranges. Used by BOTH the suggestions "fix_template" path and "Ask AI to Edit",
// so the two features validate values identically.
export const AI_FIXABLE_ACTIONS = ['brightness', 'contrast', 'saturation', 'zoom', 'rotate', 'mute', 'unmute']

// Numeric ranges for the colour/geometry ops (mute/unmute carry no value).
// Mirrors the editor's slider bounds.
export const FIX_VALUE_RANGES = {
  brightness: [-100, 100],
  contrast: [-100, 100],
  saturation: [-100, 100],
  zoom: [100, 250],
  rotate: [-180, 180],
}

// True iff `value` is a finite number within the range for a numeric op.
// Returns false for mute/unmute (no range) and unknown actions.
export function inRangeValue(action, value) {
  const r = FIX_VALUE_RANGES[action]
  return Boolean(r) && typeof value === 'number' && Number.isFinite(value) && value >= r[0] && value <= r[1]
}
