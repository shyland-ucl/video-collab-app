import { LEVELS } from '../../../lib/editor/detailLevels.js';

/**
 * Detail-level picker for scene descriptions.
 *
 * Ported verbatim from video-collab-probe/src/components/shared/DetailLevelSelector.jsx
 * (Phase 2a Task 1). Only the LEVELS import path changed
 * (utils/detailLevels.js -> lib/editor/detailLevels.js). No study-only code
 * here, so nothing was stripped.
 *
 * Three direct-pick targets - tap a level to jump straight to it. The
 * active level is highlighted visually.
 *
 * The screen-reader contract is intentionally unusual: on focus, mobile AT
 * should hear only "Change to {level} description", without button/selected
 * chrome. These targets deliberately avoid button semantics. Activation is
 * handled directly on the focused node and propagation is stopped so a
 * TalkBack/VoiceOver double-tap cannot leak to the scene header and close the
 * action region.
 */
export default function DetailLevelSelector({ currentLevel, onLevelChange }) {
  const activateLevel = (event, level) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    onLevelChange(level);
  };

  return (
    <div className="flex items-center gap-2">
      {LEVELS.map((lvl) => {
        const isActive = lvl.value === currentLevel;
        const className =
          'flex-1 py-2 text-sm font-medium rounded-lg transition-colors text-center select-none ' +
          'focus:outline-2 focus:outline-offset-2 focus:outline-blue-500 ' +
          (isActive
            ? 'bg-blue-600 text-white font-semibold'
            : 'bg-gray-100 text-gray-700 hover:bg-gray-200');
        return (
          <div
            key={lvl.value}
            tabIndex={0}
            role="button"
            aria-pressed={isActive}
            data-detail-level-value={lvl.value}
            onClick={(event) => activateLevel(event, lvl.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                activateLevel(event, lvl.value);
              }
            }}
            aria-label={`Change to ${lvl.label} description`}
            className={className}
            style={{
              minHeight: '44px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
            }}
          >
            <span aria-hidden="true">{lvl.label}</span>
          </div>
        );
      })}
    </div>
  );
}
