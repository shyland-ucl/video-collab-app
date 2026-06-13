// Shared definition of the description detail levels used by both
// DetailLevelSelector (UI) and SceneBlockList (announce + read-out).
// Lives in its own non-component module so React Fast Refresh can hot-reload
// either consumer without invalidating the bundle. (Re-exporting LEVELS from
// DetailLevelSelector.jsx broke Fast Refresh: a file that mixes a React
// component default export with named non-component exports forces a full
// reload, which silently leaves the browser on the previous bundle until
// the user manually refreshes.)
//
// Ported verbatim from video-collab-probe/src/utils/detailLevels.js
// (Phase 2a Task 1). No study-only code here, so nothing was stripped.
export const LEVELS = [
  { value: 1, label: 'Overview' },
  { value: 2, label: 'Detailed' },
  { value: 3, label: 'Technical' },
];

export const MIN_LEVEL = 1;
export const MAX_LEVEL = 3;
