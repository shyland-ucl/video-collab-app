import { useEffect, useRef, useCallback } from 'react';
import ttsService from '../../../services/ttsService.js';
import { announce } from '../../../utils/announcer.js';

// Ported from video-collab-probe/src/components/shared/SceneBlock.jsx
// (Phase 2a Task 1) per the adaptation contract.
//
// STRIPPED (study-only, per the plan):
//   - onAwarenessViewed prop + emitAwareness + AWARENESS_DEBOUNCE_MS + the
//     whole awareness section (helperActivity / actionLog / taskStatus) — that
//     is researcher/awareness telemetry, deferred.
//   - hasSuggestion prop + the "✨ AI" badge + ring + aria hint — AI-suggestion
//     decoration, Phase 3.
//   - vqaHistory prop + the VQA conversation log render — the per-scene VQA UI
//     moves into the per-scene actions render-prop (Task 2), so the block no
//     longer owns it.
//   - the `awareness` prop + its header task-summary pill.
//
// KEPT VERBATIM: collapsed-header aria-label contract, focus-on-MANUAL-expand
// (silent on auto-follow), accentColor border, scene colour dot, isRemoved
// dimming + "Removed" badge + line-through, editSummary amber "Edited" badge +
// "What changed:" line, descriptionOverride, the render-prop children region
// (data-scene-actions-region), and the Back button.
//
// SCENE SHAPE (consumed by this block — see SceneBlockList header for the full
// contract): { id, name, color?, start_time, end_time,
//              descriptions?: { level_1, level_2, level_3 } }.

function formatDuration(seconds) {
  const s = Math.round(seconds || 0);
  if (s < 60) return `${s} seconds`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m} min ${rem} sec` : `${m} min`;
}

export default function SceneBlock({
  scene,
  index,
  total,
  currentLevel,
  isExpanded,
  isPlaying = false,
  autoFollowed = false,
  playbackFocusToken = 0,
  onExpand,
  onCollapse,
  onPausePlayback,
  children,
  accentColor = '#9B59B6',
  // True when the participant has tapped Remove on this scene. Renders the
  // block dimmed with a "Removed" badge so they get visible confirmation
  // alongside the playback filter. The block stays interactive (so they
  // can still expand to Restore).
  isRemoved = false,
  // Forwarded from SceneBlockList so it can restore focus to this scene's
  // header on full collapse — otherwise focus falls to <body> when the
  // expanded actions region unmounts (Lan 2026-04-26).
  headerRef,
  // Day 1 fix #3: when an edit lands on this scene, the page passes a
  // short templated diff string (e.g. "Brightness +15") plus the actor
  // who made it. Renders an amber "Edited" badge in the header and
  // prepends a "What changed" line to the description so a TalkBack
  // creator hears the change without having to expand or replay.
  editSummary = null,
  descriptionOverride = null,
}) {
  const actionsRef = useRef(null);
  const headerButtonRef = useRef(null);

  const setHeaderButtonRef = useCallback((el) => {
    headerButtonRef.current = el;
    if (typeof headerRef === 'function') {
      headerRef(el);
    } else if (headerRef && 'current' in headerRef) {
      headerRef.current = el;
    }
  }, [headerRef]);

  const duration = (scene.end_time || 0) - (scene.start_time || 0);
  const levelKey = `level_${currentLevel}`;
  const description = descriptionOverride ?? scene.descriptions?.[levelKey] ?? '';

  // Auto-focus on expand. Fires for both manual click and auto-follow
  // during playback.
  //
  // Day 1 fix (Lily, May 5): during auto-follow we now SKIP focus
  // movement entirely. Previously we focused the new scene's play
  // button so the user could keep tapping it, but TalkBack reads the
  // focused button's accessible name on every focus change — that
  // overlapped the playing video audio every time playback crossed a
  // scene boundary. Per request: "even the scene block is moving, the
  // talkback should be silent". Now playback stays silent; the user
  // can swipe to find controls if they want to pause. Manual expand
  // still focuses the actions region as before.
  useEffect(() => {
    if (isExpanded && actionsRef.current) {
      ttsService.stop();
      if (autoFollowed) {
        // Visual follow only. Moving TalkBack focus here makes it speak at
        // every scene boundary; playback should stay silent until pause.
        headerButtonRef.current?.scrollIntoView?.({ behavior: 'auto', block: 'nearest' });
        return;
      }
      // Day 1 Android fix: `preventScroll` on focus so the browser
      // doesn't run its own scroll-into-view animation alongside whatever
      // TalkBack is already doing — that combination produced the
      // "scroll past then snap back" jitter Lily reported.
      actionsRef.current.focus({ preventScroll: true });
      // Announce only on MANUAL expand. Assertive because Android TalkBack
      // drops polite writes during the activated button's re-read.
      announce(`Opened scene ${index + 1}. ${scene.name}. Showing actions.`, { assertive: true });
    }
    if (!isExpanded) {
      ttsService.stop();
    }
    // scene.name and index are stable for the lifecycle of this block
  }, [isExpanded, autoFollowed, playbackFocusToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // Browser back-button integration is owned by SceneBlockList — putting it
  // here caused auto-follow to break: when expandedIndex moves from N to N+1,
  // block N's cleanup calls history.back(), and the async popstate then fires
  // against block N+1's just-attached listener, collapsing it. SceneBlockList
  // does a single push/pop keyed on "is any scene expanded".

  return (
    <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
      {/* Collapsed header — always visible. The aria-label includes the
          description (current detail level) so a TalkBack creator can hear
          what's in each scene without having to expand it (Lan-confirmed
          override of M3 trade-off, 2026-04-26). */}
      <button
        ref={setHeaderButtonRef}
        data-scene-index={index}
        onClick={() => {
          if (isExpanded) {
            if (isPlaying && onPausePlayback) {
              onPausePlayback();
              return;
            }
            onCollapse();
            return;
          }
          // The expand effect handles description read-out so the same code
          // path runs for click and auto-follow — no separate speak here.
          onExpand(index);
        }}
        aria-label={
          isExpanded && isPlaying
            ? `Scene ${index + 1} of ${total}: ${scene.name}. Playing. Double tap to pause and hear this scene description.`
            : `Scene ${index + 1} of ${total}: ${scene.name}. ${formatDuration(duration)}. ` +
              (isRemoved ? 'Removed from edit. ' : '') +
              (editSummary ? `Edited: ${editSummary.text}. ` : '') +
              (description ? `${description} ` : '') +
              (isExpanded ? 'Tap to close actions.' : 'Tap to open actions.')
        }
        className={`w-full text-left px-4 py-3 hover:bg-gray-50 focus:outline-2 focus:outline-offset-2 focus:outline-blue-500 transition-colors ${
          isExpanded ? 'border-b-2' : ''
        } ${isRemoved ? 'bg-gray-50 opacity-60' : ''} ${
          editSummary && !isRemoved ? 'ring-2 ring-amber-300 ring-offset-1' : ''
        }`}
        style={isExpanded ? { borderBottomColor: accentColor, minHeight: '48px' } : { minHeight: '48px' }}
      >
        {/* Scene header row */}
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: scene.color || accentColor }}
              aria-hidden="true"
            />
            <span className={`font-medium text-sm truncate ${isRemoved ? 'line-through text-gray-500' : ''}`}>
              {scene.name}
            </span>
            {editSummary && !isRemoved && (
              <span
                className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-700 flex-shrink-0"
                aria-hidden="true"
                title={editSummary.text}
              >
                Edited
              </span>
            )}
            {isRemoved && (
              <span
                className="px-2 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-700 flex-shrink-0"
                aria-hidden="true"
              >
                Removed
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 text-xs text-gray-500">
            <span aria-hidden="true">{Math.round(duration)}s</span>
            <span aria-hidden="true" className="text-gray-400">{isExpanded ? '▲' : '▼'}</span>
          </div>
        </div>
        {/* Description always visible. Day 1 fix #3: prepend a one-line
            "What changed" diff when there's a recent edit on this scene so
            BLV creators verify outcomes without re-playing. */}
        {editSummary && !isRemoved && (
          <p
            className="text-sm font-medium text-amber-800 mb-1"
            aria-hidden="true"
          >
            <span className="text-xs uppercase tracking-wide mr-1">What changed:</span>
            {editSummary.text}
          </p>
        )}
        <p className={`text-sm leading-relaxed ${isRemoved ? 'text-gray-400 line-through' : 'text-gray-600'}`} aria-hidden="true">
          {description || 'No description available.'}
        </p>
      </button>

      {/* Expanded: inline actions below the collapsed header */}
      {isExpanded && (
        <div
          ref={actionsRef}
          tabIndex={-1}
          data-scene-actions-region={index}
          className="px-4 py-3"
          aria-label={`Actions for scene ${index + 1}`}
        >
          {/* Probe-specific actions (children) */}
          <div className="space-y-2">
            {children}
          </div>

          {/* Back button */}
          <button
            onClick={onCollapse}
            className="w-full mt-3 py-2 text-sm text-gray-600 hover:text-gray-900 font-medium rounded border border-gray-200 focus:outline-2 focus:outline-offset-2 focus:outline-blue-500"
            style={{ minHeight: '44px' }}
            aria-label="Back to scene description"
          >
            Back
          </button>
        </div>
      )}
    </div>
  );
}
