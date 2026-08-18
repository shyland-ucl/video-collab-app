import { useState, useCallback, useRef, useEffect } from 'react';
import ttsService from '../../../services/ttsService.js';
import { announce } from '../../../utils/announcer.js';
import GlobalControlsBar from './GlobalControlsBar.jsx';
import PlainScreenReaderAction from './PlainScreenReaderAction.jsx';
import SceneBlock from './SceneBlock.jsx';
import { buildSceneDescriptionAddendum } from '../../../lib/editor/descriptionAddenda.js';

// Ported from video-collab-probe/src/components/shared/SceneBlockList.jsx
// (Phase 2a Task 1) per the adaptation contract.
//
// STRIPPED (study-only, per the plan):
//   - useEventLogger / logEvent / EventTypes / Actors (event telemetry) — all
//     logEvent() calls removed; the state machine behaviour is untouched.
//   - vqaHistories / awarenessData / onAwarenessViewed props + their per-scene
//     forwarding (VQA history, awareness telemetry) — deferred / moves into
//     the per-scene actions render-prop (Task 2).
//   - sceneIndicesWithSuggestions prop + hasSuggestion forwarding (AI
//     suggestion decoration) — Phase 3.
//   - the videoCount prop is kept on the signature for caller compatibility but,
//     like in the probe, GlobalControlsBar ignores it.
//
// KEPT VERBATIM: expandedIndex / expandSource / playbackFocusToken / focus
// tokens, the entire focus-guard + swipe-lock + guarded-scroll machinery, the
// auto-follow effects (disableAutoFollow), the pause read-out effect, the
// full-collapse focus-restore + onSceneClose effect, the kept-scenes filter +
// "Removed" handling, editedScenes amber stamp wiring, the browser history
// push/pop, and the renderSceneActions render-prop contract.
//
// SCENE SHAPE consumed by this list and SceneBlock (the caller — Task 3 —
// builds it from state.clips + descriptions):
//   {
//     id: string,                  // clip id (rootSegmentId resolves the desc key)
//     name: string,                // e.g. "Scene 1"
//     color?: string,              // dot colour; falls back to accentColor
//     start_time: number,          // seconds (snake_case — matches the probe)
//     end_time: number,            // seconds
//     descriptions?: {             // per-level text, resolved upstream via
//       level_1?: string,          //   descriptions[rootSegmentId(clip.id)]?.[level]
//       level_2?: string,
//       level_3?: string,
//     },
//   }
// NOTE the snake_case time fields and `level_N` description keys: these are the
// probe's internal contract, kept verbatim so the ported components are an exact
// match. The app's clips use camelCase startTime/endTime and numeric desc keys,
// so the Task 3 caller adapts: { start_time: clip.startTime, end_time: clip.endTime,
// descriptions: { level_1: descriptions[root]?.[1], ... } }.

const FOCUS_SCROLL_GUARD_MS = 350;
const FOCUS_SCROLL_RESTORE_DELAYS = [0, 16, 64, 160, 320];
const VISIBILITY_TOLERANCE_PX = 2;
const HORIZONTAL_SWIPE_THRESHOLD_PX = 10;
const HORIZONTAL_SWIPE_LOCK_MS = 550;
const MANUAL_SCROLL_ALLOW_MS = 600;
const DETAIL_LEVEL_ANNOUNCE_DELAY_MS = 120;

function createSceneHistoryToken() {
  return `scene-block-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getContentTop(container, target) {
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  return targetRect.top - containerRect.top + container.scrollTop;
}

function isFullyVisibleAtScrollTop(container, target, scrollTop) {
  const top = getContentTop(container, target) - scrollTop;
  const bottom = top + target.getBoundingClientRect().height;
  return (
    top >= -VISIBILITY_TOLERANCE_PX
    && bottom <= container.clientHeight + VISIBILITY_TOLERANCE_PX
  );
}

export default function SceneBlockList({
  scenes = [],
  playerRef,
  currentTime = 0,
  isPlaying = false,
  onSeek,
  onPlay,
  onPause,
  accentColor = 'var(--color-creator)',
  videoCount = 1,
  summaryFocusToken = 0,
  // sceneId → boolean. When `keptScenes[id] === false`, the scene is marked
  // removed and dropped from the rendered list so it doesn't take
  // screen-reader focus or visual space. Playback filtering happens upstream.
  keptScenes = {},
  // Render prop for probe-specific actions (the per-scene action set, Task 2).
  renderSceneActions,
  // Fired when a scene is FULLY collapsed (close button, header tap, or
  // browser-back) — NOT on auto-follow boundary moves. Pages use this to
  // wipe per-scene chat history so re-opening starts fresh and TalkBack
  // doesn't have to swipe past N stale Q+A bubbles (Lan 2026-04-27).
  onSceneClose,
  // When the page is doing single-segment playback ("Play this scene"), it
  // sets this true so we skip the auto-expand-next-scene effect. Without
  // it, a video timeUpdate tick that lands a few ms past the segment end
  // (the player's tick can be ~100-200ms wide) lets us expand the next
  // block before the page-level pause takes effect.
  disableAutoFollow = false,
  // Day 1 fix #3: { [sceneId]: { text, actor, timestamp } } map of scenes
  // that were edited recently. Drives the amber "Edited" badge + the
  // "What changed" line prepended to the description.
  editedScenes = {},
  editState = null,
  // Optional one-time landing: when the editor is opened from a chosen video
  // (`/projects/:id/edit?video=<id>`), the caller resolves the index of that
  // video's first scene and passes it here. We expand + scroll to it ONCE on
  // mount, then behave exactly as today. null/undefined → nothing auto-expanded.
  initialExpandedIndex = null,
  // Phase 3b: Set of scene (clip) ids that carry an AI suggestion. Drives the
  // "✨ AI" indicator + aria hint on the collapsed scene block.
  sceneIdsWithSuggestions = new Set(),
}) {
  const [expandedIndex, setExpandedIndex] = useState(null);
  // Where the latest expansion came from. Drives focus behavior in SceneBlock:
  //   'user' — manual tap → focus the actions region (default landing).
  //   'auto' — playback auto-follow → focus the new scene's Play/Pause button
  //            so the user stays on the button they were just using.
  const [expandSource, setExpandSource] = useState('user');
  const [playbackFocusToken, setPlaybackFocusToken] = useState(0);
  const [currentLevel, setCurrentLevel] = useState(1);
  const listRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const stableScrollTopRef = useRef(0);
  const focusScrollGuardRef = useRef(null);
  const focusRestoreTimersRef = useRef([]);
  const touchScrollLockRef = useRef(null);
  const manualScrollAllowedUntilRef = useRef(0);
  const levelAnnounceTimerRef = useRef(null);
  // Refs to each SceneBlock's collapsed-header button. Used to restore
  // focus when a scene is fully collapsed — otherwise the browser drops
  // focus to <body> and TalkBack/VoiceOver swipe-navigates from page top
  // (Lan 2026-04-27 regression).
  const headerRefs = useRef([]);
  const prevExpandedRef = useRef(null);
  const wasPlayingForFocusRef = useRef(false);
  const playbackPauseButtonRef = useRef(null);
  const sceneHistoryTokenRef = useRef(null);
  const ignoreNextScenePopRef = useRef(false);
  const wasAnyExpandedRef = useRef(false);
  const didInitialExpandRef = useRef(false);

  const clearFocusRestoreTimers = useCallback(() => {
    focusRestoreTimersRef.current.forEach((timer) => clearTimeout(timer));
    focusRestoreTimersRef.current = [];
  }, []);

  const restoreGuardedScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    const activeTouchLock = touchScrollLockRef.current?.horizontal ? touchScrollLockRef.current : null;
    const guard = activeTouchLock || focusScrollGuardRef.current;
    if (!container || !guard) return;
    if (performance.now() > guard.expiresAt) {
      if (touchScrollLockRef.current === guard) touchScrollLockRef.current = null;
      if (focusScrollGuardRef.current === guard) focusScrollGuardRef.current = null;
      stableScrollTopRef.current = container.scrollTop;
      return;
    }
    if (Math.abs(container.scrollTop - guard.scrollTop) > VISIBILITY_TOLERANCE_PX) {
      container.scrollTop = guard.scrollTop;
    }
    stableScrollTopRef.current = guard.scrollTop;
  }, []);

  const scheduleGuardedScrollRestore = useCallback(() => {
    clearFocusRestoreTimers();
    focusRestoreTimersRef.current = FOCUS_SCROLL_RESTORE_DELAYS.map((delay) => (
      setTimeout(restoreGuardedScroll, delay)
    ));
  }, [clearFocusRestoreTimers, restoreGuardedScroll]);

  const allowManualScroll = useCallback(() => {
    manualScrollAllowedUntilRef.current = performance.now() + MANUAL_SCROLL_ALLOW_MS;
  }, []);

  const shouldPinFocusedSceneScroll = useCallback((container, scrollTop) => {
    const active = document.activeElement;
    if (!(active instanceof Element) || !container.contains(active)) return false;

    const header = active.closest('[data-scene-index]');
    if (!header || !container.contains(header)) return false;

    return isFullyVisibleAtScrollTop(container, header, scrollTop);
  }, []);

  const shouldKeepExpandedSceneForFocusedAction = useCallback(() => {
    if (expandedIndex === null) return false;
    const active = document.activeElement;
    if (!(active instanceof Element) || !listRef.current?.contains(active)) return false;

    const actionsRegion = active.closest('[data-scene-actions-region]');
    if (!actionsRegion || !listRef.current.contains(actionsRegion)) return false;

    return actionsRegion.getAttribute('data-scene-actions-region') === String(expandedIndex);
  }, [expandedIndex]);

  useEffect(() => clearFocusRestoreTimers, [clearFocusRestoreTimers]);

  useEffect(() => () => {
    if (levelAnnounceTimerRef.current !== null) {
      clearTimeout(levelAnnounceTimerRef.current);
    }
  }, []);

  useEffect(() => {
    stableScrollTopRef.current = scrollContainerRef.current?.scrollTop || 0;
  }, [scenes.length]);

  // One-time landing on the chosen video's first scene. Runs once, only after
  // the scenes have loaded and only when a valid index is supplied. It expands
  // that block as a manual ('user') expansion — so SceneBlock lands focus on
  // the actions region, exactly like a tap — and scrolls it into view. After
  // it fires, the normal auto-follow/manual machinery owns expandedIndex.
  useEffect(() => {
    if (didInitialExpandRef.current) return;
    if (initialExpandedIndex == null) return;
    if (initialExpandedIndex < 0 || initialExpandedIndex >= scenes.length) return;
    didInitialExpandRef.current = true;
    setExpandSource('user');
    setExpandedIndex(initialExpandedIndex);
    const raf = requestAnimationFrame(() => {
      headerRefs.current[initialExpandedIndex]?.scrollIntoView?.({ behavior: 'auto', block: 'nearest' });
    });
    return () => cancelAnimationFrame(raf);
  }, [initialExpandedIndex, scenes.length]);

  const handleListFocusCapture = useCallback((event) => {
    const container = scrollContainerRef.current;
    const target = event.target;
    if (!container || !(target instanceof Element)) return;

    const sceneHeader = target.closest('[data-scene-index]');
    if (!sceneHeader || !container.contains(sceneHeader)) return;

    const stableScrollTop = touchScrollLockRef.current?.scrollTop ?? stableScrollTopRef.current;
    if (!isFullyVisibleAtScrollTop(container, sceneHeader, stableScrollTop)) {
      focusScrollGuardRef.current = null;
      return;
    }

    focusScrollGuardRef.current = {
      scrollTop: stableScrollTop,
      expiresAt: performance.now() + FOCUS_SCROLL_GUARD_MS,
    };
    scheduleGuardedScrollRestore();
  }, [scheduleGuardedScrollRestore]);

  const handleListScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    const activeTouchLock = touchScrollLockRef.current?.horizontal ? touchScrollLockRef.current : null;
    const guard = activeTouchLock || focusScrollGuardRef.current;
    if (!container) return;
    const now = performance.now();

    if (guard && now <= guard.expiresAt) {
      restoreGuardedScroll();
      return;
    }

    const manualScrollAllowed = now <= manualScrollAllowedUntilRef.current;
    if (!manualScrollAllowed && shouldPinFocusedSceneScroll(container, stableScrollTopRef.current)) {
      if (Math.abs(container.scrollTop - stableScrollTopRef.current) > VISIBILITY_TOLERANCE_PX) {
        container.scrollTop = stableScrollTopRef.current;
      }
      return;
    }

    focusScrollGuardRef.current = null;
    touchScrollLockRef.current = null;
    stableScrollTopRef.current = container.scrollTop;
  }, [restoreGuardedScroll, shouldPinFocusedSceneScroll]);

  const handleTouchStart = useCallback((event) => {
    const container = scrollContainerRef.current;
    const touch = event.touches?.[0];
    if (!container || !touch) return;
    if (event.touches.length > 1) allowManualScroll();
    touchScrollLockRef.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      scrollTop: container.scrollTop,
      horizontal: false,
      expiresAt: performance.now() + HORIZONTAL_SWIPE_LOCK_MS,
    };
  }, [allowManualScroll]);

  const handleTouchMove = useCallback((event) => {
    const container = scrollContainerRef.current;
    const touch = event.touches?.[0];
    const lock = touchScrollLockRef.current;
    if (!container || !touch || !lock) return;

    const dx = touch.clientX - lock.startX;
    const dy = touch.clientY - lock.startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    if (!lock.horizontal && absDy > HORIZONTAL_SWIPE_THRESHOLD_PX && absDy > absDx) {
      allowManualScroll();
      touchScrollLockRef.current = null;
      return;
    }

    if (lock.horizontal || (absDx > HORIZONTAL_SWIPE_THRESHOLD_PX && absDx > absDy)) {
      lock.horizontal = true;
      lock.expiresAt = performance.now() + HORIZONTAL_SWIPE_LOCK_MS;
      if (event.cancelable) event.preventDefault();
      if (Math.abs(container.scrollTop - lock.scrollTop) > VISIBILITY_TOLERANCE_PX) {
        container.scrollTop = lock.scrollTop;
      }
      stableScrollTopRef.current = lock.scrollTop;
    }
  }, [allowManualScroll]);

  const handleTouchEnd = useCallback(() => {
    const lock = touchScrollLockRef.current;
    if (!lock) return;
    if (!lock.horizontal) {
      touchScrollLockRef.current = null;
      return;
    }
    lock.expiresAt = performance.now() + HORIZONTAL_SWIPE_LOCK_MS;
    scheduleGuardedScrollRestore();
  }, [scheduleGuardedScrollRestore]);

  const handleWheel = useCallback(() => {
    allowManualScroll();
  }, [allowManualScroll]);

  const totalDuration = scenes.reduce(
    (sum, s) => sum + ((s.end_time || 0) - (s.start_time || 0)),
    0
  );

  const getSceneDescription = useCallback((scene, level) => {
    const base = scene?.descriptions?.[`level_${level}`] || '';
    const addendum = buildSceneDescriptionAddendum({
      scene,
      currentLevel: level,
      editState,
      editSummary: editedScenes[scene?.id],
    });
    return [base, addendum].filter(Boolean).join(' ');
  }, [editState, editedScenes]);

  const handleExpand = useCallback(
    (index) => {
      setExpandSource('user');
      setExpandedIndex(index);
      const scene = scenes[index];
      if (onSeek && scene) {
        onSeek(scene.start_time);
      }
    },
    [scenes, onSeek]
  );

  const handleCollapse = useCallback(() => {
    setExpandedIndex(null);
    ttsService.stop();
    announce('Scene closed.');
  }, []);

  const handleLevelChange = useCallback(
    (level) => {
      // Re-tapping the active button is a "read again" gesture, not a level
      // change; only update state when the level actually changes.
      if (level !== currentLevel) {
        setCurrentLevel(level);
      }
      // Read out only the description for the now-current level. The
      // target's aria-label already told the user what they tapped
      // ("Change to {label} description"), so this announce never repeats
      // the label. announce() is queued, never speak() - see memory
      // `feedback_scene_block_a11y.md`.
      const expandedScene = expandedIndex !== null ? scenes[expandedIndex] : null;
      const desc = expandedScene ? getSceneDescription(expandedScene, level) : '';
      if (levelAnnounceTimerRef.current !== null) {
        clearTimeout(levelAnnounceTimerRef.current);
        levelAnnounceTimerRef.current = null;
      }
      if (!desc) return;

      // Let TalkBack/VoiceOver finish their activation feedback first. The
      // delayed assertive live-region write then interrupts with only the
      // scene prose, including when the same active level is tapped again.
      levelAnnounceTimerRef.current = setTimeout(() => {
        levelAnnounceTimerRef.current = null;
        announce(desc, { assertive: true });
      }, DETAIL_LEVEL_ANNOUNCE_DELAY_MS);
    },
    [currentLevel, expandedIndex, scenes, getSceneDescription]
  );

  // Auto-navigate to the scene matching current playback time. On unbounded
  // "Play from here", move focus to the stable pause control under the video
  // instead of keeping it on the scene-local button, which can unmount when
  // the list follows playback into the next scene.
  useEffect(() => {
    const wasPlaying = wasPlayingForFocusRef.current;
    wasPlayingForFocusRef.current = isPlaying;
    if (wasPlaying || !isPlaying || disableAutoFollow) return;

    const activeIndex = scenes.findIndex(
      (s) => currentTime >= s.start_time && currentTime < s.end_time
    );
    if (activeIndex !== -1) {
      setExpandSource('auto');
      setExpandedIndex(activeIndex);
      setPlaybackFocusToken((token) => token + 1);
    }
    requestAnimationFrame(() => {
      playbackPauseButtonRef.current?.focus({ preventScroll: true });
    });
  }, [isPlaying, disableAutoFollow, scenes, currentTime]);

  useEffect(() => {
    if (!isPlaying) return;
    if (disableAutoFollow) return;
    if (shouldKeepExpandedSceneForFocusedAction()) return;
    const activeIndex = scenes.findIndex(
      (s) => currentTime >= s.start_time && currentTime < s.end_time
    );
    if (activeIndex !== -1 && activeIndex !== expandedIndex) {
      setExpandSource('auto');
      setExpandedIndex(activeIndex);
    }
  }, [currentTime, isPlaying, scenes, expandedIndex, disableAutoFollow, shouldKeepExpandedSceneForFocusedAction]);

  // Pause read-out: when playback transitions playing → paused while a
  // scene is expanded, announce the current scene's description so the
  // user hears what they just paused on. Uses announce() (live region),
  // never ttsService.speak — per memory `feedback_scene_block_a11y.md`,
  // active TTS fights TalkBack.
  const wasPlayingRef = useRef(isPlaying);
  useEffect(() => {
    const wasPlaying = wasPlayingRef.current;
    wasPlayingRef.current = isPlaying;
    let firstFrame = null;
    let secondFrame = null;
    if (wasPlaying && !isPlaying && expandedIndex !== null) {
      if (shouldKeepExpandedSceneForFocusedAction()) return undefined;
      // Bounded "Play this scene" parks disableAutoFollow through the
      // boundary pause. Stay on the current expanded scene and keep focus on
      // the existing control instead of following currentTime into the next
      // scene.
      if (disableAutoFollow) return undefined;
      const activeIndex = scenes.findIndex(
        (s) => currentTime >= s.start_time && currentTime < s.end_time
      );
      const pausedIndex = activeIndex !== -1 ? activeIndex : expandedIndex;
      const scene = scenes[pausedIndex];
      const desc = scene ? getSceneDescription(scene, currentLevel) : '';
      if (pausedIndex !== expandedIndex) {
        setExpandSource('auto');
        setExpandedIndex(pausedIndex);
      }
      firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(() => {
          const target = headerRefs.current[pausedIndex];
          target?.scrollIntoView?.({ behavior: 'auto', block: 'nearest' });
          target?.focus({ preventScroll: true });
        });
      });
      if (desc) {
        // Assertive: pause flips the scene-play button's aria-label from
        // "Pause from here" back to "Play from here", and Android
        // TalkBack re-reads the activated button. A polite announce here
        // gets dropped, which is exactly the case the BLV creator needs
        // to hear ("which scene did I just pause on?"). Assertive
        // interrupts the re-read so the description lands.
        announce(`Paused on scene ${pausedIndex + 1}, ${scene.name}. ${desc}`, { assertive: true });
      }
    }
    return () => {
      if (firstFrame !== null) cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) cancelAnimationFrame(secondFrame);
    };
  }, [
    isPlaying,
    disableAutoFollow,
    expandedIndex,
    scenes,
    currentLevel,
    currentTime,
    getSceneDescription,
    shouldKeepExpandedSceneForFocusedAction,
  ]);

  // Full-collapse side effects: when expandedIndex transitions from N to
  // null (Close button, header re-tap, or browser-back), restore focus to
  // scene N's collapsed-header button AND fire onSceneClose so the page
  // can wipe per-scene chat history. Auto-follow (N → M) is excluded
  // because the new SceneBlock's expand effect already lands focus on
  // its play button.
  useEffect(() => {
    const prev = prevExpandedRef.current;
    prevExpandedRef.current = expandedIndex;
    if (prev !== null && expandedIndex === null) {
      const sceneId = scenes[prev]?.id;
      // Focus restoration runs in a rAF so React has finished unmounting
      // the actions region before we move focus back to the header —
      // otherwise the unmount races and focus snaps to <body>.
      const raf = requestAnimationFrame(() => {
        // Day 1 Android fix: preventScroll so the browser doesn't trigger
        // a scroll-into-view animation that competes with TalkBack's own
        // scroll behaviour, producing the "scroll past then snap back"
        // jitter on focus restoration.
        headerRefs.current[prev]?.focus({ preventScroll: true });
      });
      if (sceneId && onSceneClose) onSceneClose(sceneId);
      return () => cancelAnimationFrame(raf);
    }
  }, [expandedIndex, scenes, onSceneClose]);

  // If the currently-expanded scene gets removed (keptScenes[id] === false),
  // collapse it so the actions region doesn't linger as a stranded panel.
  // Without this, the user marks Remove → block disappears from the list →
  // expanded actions region is still mounted but now belongs to nothing.
  useEffect(() => {
    if (expandedIndex === null) return;
    const scene = scenes[expandedIndex];
    if (scene && keptScenes[scene.id] === false) {
      setExpandedIndex(null);
    }
  }, [keptScenes, expandedIndex, scenes]);

  // Single push/pop tied to "is any scene expanded" so the browser back
  // button closes the open scene without inflating history. This is split
  // into a stable popstate listener plus a transition effect; doing
  // history.back() from an effect cleanup can convert unrelated updates
  // (like changing detail level) into an accidental Scene closed event.
  const anyExpanded = expandedIndex !== null;
  useEffect(() => {
    const handlePopState = () => {
      if (ignoreNextScenePopRef.current) {
        ignoreNextScenePopRef.current = false;
        return;
      }
      if (!sceneHistoryTokenRef.current) return;
      sceneHistoryTokenRef.current = null;
      wasAnyExpandedRef.current = false;
      setExpandedIndex(null);
      ttsService.stop();
      announce('Scene closed.');
    };
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  useEffect(() => {
    const wasAnyExpanded = wasAnyExpandedRef.current;
    if (anyExpanded && !wasAnyExpanded) {
      const token = createSceneHistoryToken();
      const currentState =
        window.history.state && typeof window.history.state === 'object'
          ? window.history.state
          : {};
      sceneHistoryTokenRef.current = token;
      window.history.pushState({ ...currentState, sceneBlock: true, sceneBlockToken: token }, '');
    } else if (!anyExpanded && wasAnyExpanded) {
      const token = sceneHistoryTokenRef.current;
      if (token && window.history.state?.sceneBlockToken === token) {
        ignoreNextScenePopRef.current = true;
        window.history.back();
      }
      sceneHistoryTokenRef.current = null;
    }
    wasAnyExpandedRef.current = anyExpanded;
  }, [anyExpanded]);

  return (
    <div ref={listRef} className="flex flex-col flex-1 min-h-0">
      <GlobalControlsBar
        sceneCount={scenes.length}
        videoCount={videoCount}
        totalDuration={totalDuration}
        focusToken={summaryFocusToken}
      />

      {isPlaying && !disableAutoFollow && (
        <div className="px-4 py-2 bg-surface border-b border-line">
          <PlainScreenReaderAction
            actionRef={playbackPauseButtonRef}
            onActivate={onPause}
            className="w-full py-2 text-sm font-medium rounded bg-sunken hover:bg-line text-ink transition-colors"
            style={{ minHeight: '44px' }}
            ariaLabel="Double tap to pause"
          >
            <span aria-hidden="true">Pause</span>
          </PlainScreenReaderAction>
        </div>
      )}

      <div
        ref={scrollContainerRef}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2"
        role="group"
        aria-label={`${scenes.filter((s) => keptScenes[s.id] !== false).length} scenes`}
        onFocusCapture={handleListFocusCapture}
        onScroll={handleListScroll}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        // Day 1 Android fix: prevent the "swipe right scrolls past target
        // and snaps back" jitter Gemini's report described.
        //   - `scrollBehavior: auto` disables smooth-scroll animation, so
        //     TalkBack's scroll-into-view is instant.
        //   - `overscrollBehavior: contain` prevents scroll chaining to
        //     the outer layout (which would expose Chrome's address bar
        //     and cause the "whole interface scrolls" symptom).
        //   - `overflowAnchor: none` disables Chrome's automatic scroll
        //     anchoring, which can re-position the scroll target
        //     mid-animation when scene-block heights re-measure (the
        //     overshoot-then-snap-back pattern reported).
        //   - `scrollPaddingTop` gives focus-into-view a small buffer so
        //     the focused scene header lands just below the video, not
        //     glued to the very top of the scroll viewport.
        style={{
          scrollBehavior: 'auto',
          overscrollBehavior: 'contain',
          overflowAnchor: 'none',
          scrollPaddingTop: '12px',
          scrollPaddingBottom: '12px',
          touchAction: 'pan-y',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        {scenes.map((scene, i) => {
          // Removed scenes are dropped from the rendered list entirely so
          // they don't take screen-reader focus or visual space. Removal is
          // confirm-first because the scene's local controls disappear with
          // it. Auto-follow still uses the original `scenes`
          // array, but playbackEditState already filters removed clips so
          // the engine never lands on a removed scene's time range.
          if (keptScenes[scene.id] === false) return null;
          return (
            <div key={scene.id || i}>
              <SceneBlock
                scene={scene}
                index={i}
                total={scenes.length}
                currentLevel={currentLevel}
                isExpanded={expandedIndex === i}
                isPlaying={isPlaying}
                autoFollowed={expandedIndex === i && expandSource === 'auto'}
                playbackFocusToken={expandedIndex === i ? playbackFocusToken : 0}
                onExpand={handleExpand}
                onCollapse={handleCollapse}
                onPausePlayback={onPause}
                accentColor={accentColor}
                isRemoved={false}
                hasSuggestion={sceneIdsWithSuggestions.has(scene.id)}
                headerRef={(el) => { headerRefs.current[i] = el; }}
                editSummary={editedScenes[scene.id] || null}
                descriptionOverride={getSceneDescription(scene, currentLevel)}
              >
                {renderSceneActions && renderSceneActions({
                  scene,
                  index: i,
                  currentLevel,
                  onLevelChange: handleLevelChange,
                  isExpanded: expandedIndex === i,
                  playerRef,
                  currentTime,
                  isPlaying,
                  onSeek,
                  onPlay,
                  onPause,
                })}
              </SceneBlock>
            </div>
          );
        })}
        {scenes.length === 0 && (
          <p className="text-center text-ink-faint py-8 text-sm">No scenes loaded.</p>
        )}
      </div>
    </div>
  );
}
