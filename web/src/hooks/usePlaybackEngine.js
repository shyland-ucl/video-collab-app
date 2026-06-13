import { useState, useRef, useCallback, useEffect, useMemo } from 'react';

/**
 * Non-destructive playback engine that plays video according to an Edit Decision List (EDL).
 *
 * Supports multiple video sources. When `videoRefs` (object: { [sourceId]: ref }) is provided,
 * the engine switches between video elements at clip boundaries based on clip.sourceId.
 * Falls back to single `videoRef` for backwards compatibility.
 *
 * @param {React.RefObject|null} videoRef - Single video ref (legacy, used when videoRefs is not provided)
 * @param {Array} clips - Array of clip objects, each with optional sourceId
 * @param {Array} captions - Array of caption objects
 * @param {boolean} isEngineActive - Whether the engine should be running
 * @param {Object|null} videoRefs - Map of sourceId -> React ref (for multi-source)
 */

/**
 * Pure helper: compute the EDL layout from a clips array.
 * Each entry: { clip, effectiveStart, effectiveEnd, duration, edlOffset }
 * Extracted from probe's internal computeLayout for testability.
 */
export function computeClipLayout(clips) {
  if (!clips || clips.length === 0) return [];
  const layout = [];
  let edlOffset = 0;
  for (const clip of clips) {
    const effectiveStart = clip.startTime + clip.trimStart;
    const effectiveEnd = clip.endTime - clip.trimEnd;
    const duration = Math.max(0, effectiveEnd - effectiveStart);
    layout.push({ clip, effectiveStart, effectiveEnd, duration, edlOffset });
    edlOffset += duration;
  }
  return layout;
}

export default function usePlaybackEngine(videoRef, clips, captions, isEngineActive, videoRefs) {
  const [edlTime, setEdlTime] = useState(0);
  const [currentClipIndex, setCurrentClipIndex] = useState(0);
  const [activeCaption, setActiveCaption] = useState(null);
  const [activeSourceId, setActiveSourceId] = useState(null);

  const rafRef = useRef(null);
  const clipIndexRef = useRef(0);
  const seekingRef = useRef(false);
  const activeSourceIdRef = useRef(null);

  // Store clips/captions in refs so the RAF loop always sees current values
  const clipsRef = useRef(clips);
  const captionsRef = useRef(captions);
  const videoRefsRef = useRef(videoRefs);
  useEffect(() => { clipsRef.current = clips; }, [clips]);
  useEffect(() => { captionsRef.current = captions; }, [captions]);
  useEffect(() => { videoRefsRef.current = videoRefs; }, [videoRefs]);

  // Stable serialized key for detecting actual clip content changes
  const clipsKey = useMemo(() => {
    if (!clips || clips.length === 0) return '';
    return clips.map((c) => `${c.id}:${c.sourceId || ''}:${c.trimStart}:${c.trimEnd}:${c.startTime}:${c.endTime}`).join('|');
  }, [clips]);

  // Get the video element for a given sourceId
  function getVideoForSource(sourceId) {
    const refs = videoRefsRef.current;
    if (refs && sourceId && refs[sourceId]?.current) {
      return refs[sourceId].current;
    }
    // Fallback to single videoRef
    return videoRef?.current || null;
  }

  // Get the video element for the currently active source
  function getActiveVideo() {
    return getVideoForSource(activeSourceIdRef.current);
  }

  function computeTotalDuration(clipsArr) {
    const layout = computeClipLayout(clipsArr);
    if (layout.length === 0) return 0;
    const last = layout[layout.length - 1];
    return last.edlOffset + last.duration;
  }

  const totalDuration = useMemo(() => computeTotalDuration(clips), [clipsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Switch active source: pause old video, seek+show new video
  function switchSource(newSourceId, seekTime, shouldPlay) {
    const oldVideo = getActiveVideo();
    const newVideo = getVideoForSource(newSourceId);

    if (oldVideo && oldVideo !== newVideo) {
      oldVideo.pause();
    }

    activeSourceIdRef.current = newSourceId;
    setActiveSourceId(newSourceId);

    if (newVideo) {
      seekingRef.current = true;
      newVideo.currentTime = seekTime;
      const onSeeked = () => {
        seekingRef.current = false;
        newVideo.removeEventListener('seeked', onSeeked);
        if (shouldPlay) {
          // play() rejects if interrupted by a subsequent seek/source switch —
          // swallow it so it doesn't surface as an unhandled rejection.
          newVideo.play()?.catch(() => {});
        }
      };
      newVideo.addEventListener('seeked', onSeeked);
    }
  }

  // The main animation frame loop
  const tick = useCallback(() => {
    if (seekingRef.current) {
      rafRef.current = requestAnimationFrame(tick);
      return;
    }

    const currentClips = clipsRef.current;
    const layout = computeClipLayout(currentClips);
    if (layout.length === 0) {
      rafRef.current = requestAnimationFrame(tick);
      return;
    }

    const idx = clipIndexRef.current;
    if (idx >= layout.length) {
      const video = getActiveVideo();
      if (video) video.pause();
      rafRef.current = requestAnimationFrame(tick);
      return;
    }

    const entry = layout[idx];
    const clipSourceId = entry.clip.sourceId || null;
    const video = getVideoForSource(clipSourceId);

    if (!video) {
      rafRef.current = requestAnimationFrame(tick);
      return;
    }

    const sourceTime = video.currentTime;

    if (sourceTime >= entry.effectiveEnd - 0.05) {
      const nextIdx = idx + 1;
      if (nextIdx < layout.length) {
        const nextEntry = layout[nextIdx];
        const nextSourceId = nextEntry.clip.sourceId || null;

        clipIndexRef.current = nextIdx;
        setCurrentClipIndex(nextIdx);

        if (nextSourceId !== clipSourceId) {
          // Source switch needed
          const wasPlaying = !video.paused;
          switchSource(nextSourceId, nextEntry.effectiveStart, wasPlaying);
        } else {
          // Same source — just seek
          seekingRef.current = true;
          video.currentTime = nextEntry.effectiveStart;
          const onSeeked = () => {
            seekingRef.current = false;
            video.removeEventListener('seeked', onSeeked);
          };
          video.addEventListener('seeked', onSeeked);
        }
      } else {
        video.pause();
        const totalDur = computeTotalDuration(currentClips);
        setEdlTime(totalDur);
        const caps = captionsRef.current;
        setActiveCaption(caps?.find((c) => totalDur >= c.startTime && totalDur < c.endTime) || null);
      }
    } else {
      const offsetInClip = Math.max(0, Math.min(sourceTime - entry.effectiveStart, entry.duration));
      const currentEdlTime = entry.edlOffset + offsetInClip;
      setEdlTime(currentEdlTime);
      const caps = captionsRef.current;
      setActiveCaption(caps?.find((c) => currentEdlTime >= c.startTime && currentEdlTime < c.endTime) || null);
    }

    rafRef.current = requestAnimationFrame(tick);
  }, [videoRef]); // Only depends on videoRef which is stable

  // Start/stop the RAF loop
  useEffect(() => {
    if (isEngineActive) {
      rafRef.current = requestAnimationFrame(tick);
    }
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isEngineActive, tick]);

  // Track clip count to detect structural changes (add/remove) vs reorder
  const prevClipCountRef = useRef(0);
  const isFirstRun = useRef(true);

  // When clips structurally change, reset playback position
  useEffect(() => {
    if (!isEngineActive || !clipsKey) return;
    const currentClips = clipsRef.current;
    const layout = computeClipLayout(currentClips);
    if (layout.length === 0) return;

    const clipCount = currentClips.length;
    const countChanged = clipCount !== prevClipCountRef.current;
    prevClipCountRef.current = clipCount;

    // On reorder (same count, same clips), keep the current clip index valid
    // but ensure the active source matches the clip at current index
    if (!isFirstRun.current && !countChanged) {
      const idx = Math.min(clipIndexRef.current, layout.length - 1);
      clipIndexRef.current = idx;
      setCurrentClipIndex(idx);
      const entry = layout[idx];
      const sourceId = entry.clip.sourceId || null;
      if (sourceId !== activeSourceIdRef.current) {
        activeSourceIdRef.current = sourceId;
        setActiveSourceId(sourceId);
      }
      return;
    }

    isFirstRun.current = false;

    // Structural change (add/remove) or first init: reset to clip 0
    const firstEntry = layout[0];
    const sourceId = firstEntry.clip.sourceId || null;

    clipIndexRef.current = 0;
    setCurrentClipIndex(0);
    setEdlTime(0);
    activeSourceIdRef.current = sourceId;
    setActiveSourceId(sourceId);

    const video = getVideoForSource(sourceId);
    if (video) {
      seekingRef.current = true;
      video.currentTime = firstEntry.effectiveStart;
      const onSeeked = () => {
        seekingRef.current = false;
        video.removeEventListener('seeked', onSeeked);
      };
      video.addEventListener('seeked', onSeeked);
    }
  }, [isEngineActive, clipsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Per-clip mute + volume render (probe VideoPlayer effect, lines ~138-152).
  //
  // The active clip carries `muted` (boolean) and may carry `volume` (0-200,
  // percent; default 100 = unchanged). Map them onto the ACTIVE source's <video>
  // element so a muted/volume-adjusted clip is actually inaudible/quieter. This
  // is the single place both devices share — CreatorDevice (pinned video) and
  // HelperDevice (EditorVideoPlayer preview) both drive playback through this
  // engine over the same videoRefs, so honouring it here makes the edit audible
  // on BOTH without either device re-deriving it. Re-runs whenever the active
  // clip index, the clips content, or the active source changes.
  useEffect(() => {
    if (!isEngineActive) return;
    const currentClips = clipsRef.current;
    const activeClip = currentClips?.[currentClipIndex] || null;
    if (!activeClip) return;
    const el = getActiveVideo();
    if (!el) return;
    el.muted = !!activeClip.muted;
    const pct = typeof activeClip.volume === 'number' ? activeClip.volume : 100;
    el.volume = Math.max(0, Math.min(1, pct / 100));
  }, [isEngineActive, currentClipIndex, clipsKey, activeSourceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Play through the engine
  const play = useCallback(() => {
    const layout = computeClipLayout(clipsRef.current);
    if (layout.length === 0) return;

    const idx = clipIndexRef.current;
    if (idx >= layout.length) return;

    const entry = layout[idx];
    const sourceId = entry.clip.sourceId || null;
    const video = getVideoForSource(sourceId);
    if (!video) return;

    // Ensure active source is correct
    if (activeSourceIdRef.current !== sourceId) {
      switchSource(sourceId, entry.effectiveStart, true);
      return;
    }

    const sourceTime = video.currentTime;
    if (sourceTime < entry.effectiveStart || sourceTime >= entry.effectiveEnd) {
      seekingRef.current = true;
      video.currentTime = entry.effectiveStart;
      const onSeeked = () => {
        seekingRef.current = false;
        video.removeEventListener('seeked', onSeeked);
        video.play()?.catch(() => {});
      };
      video.addEventListener('seeked', onSeeked);
      return;
    }
    video.play()?.catch(() => {});
  }, [videoRef]); // eslint-disable-line react-hooks/exhaustive-deps

  const pause = useCallback(() => {
    const video = getActiveVideo();
    if (video) video.pause();
  }, [videoRef]); // eslint-disable-line react-hooks/exhaustive-deps

  // Seek in EDL time
  const seekEdl = useCallback((time) => {
    const layout = computeClipLayout(clipsRef.current);
    if (layout.length === 0) return;
    const total = computeTotalDuration(clipsRef.current);
    const clamped = Math.max(0, Math.min(time, total));

    let clipIndex = 0;
    let sourceTime = layout[0].effectiveStart;
    let targetSourceId = layout[0].clip.sourceId || null;

    for (let i = 0; i < layout.length; i++) {
      const entry = layout[i];
      if (clamped < entry.edlOffset + entry.duration || i === layout.length - 1) {
        const offsetInClip = clamped - entry.edlOffset;
        clipIndex = i;
        sourceTime = entry.effectiveStart + Math.max(0, offsetInClip);
        targetSourceId = entry.clip.sourceId || null;
        break;
      }
    }

    clipIndexRef.current = clipIndex;
    setCurrentClipIndex(clipIndex);
    setEdlTime(clamped);
    const caps = captionsRef.current;
    setActiveCaption(caps?.find((c) => clamped >= c.startTime && clamped < c.endTime) || null);

    if (targetSourceId !== activeSourceIdRef.current) {
      // Need to switch source
      const oldVideo = getActiveVideo();
      const wasPlaying = oldVideo && !oldVideo.paused;
      switchSource(targetSourceId, sourceTime, wasPlaying);
    } else {
      const video = getVideoForSource(targetSourceId);
      if (video) {
        seekingRef.current = true;
        video.currentTime = sourceTime;
        const onSeeked = () => {
          seekingRef.current = false;
          video.removeEventListener('seeked', onSeeked);
        };
        video.addEventListener('seeked', onSeeked);
      }
    }
  }, [videoRef]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    edlTime,
    totalDuration,
    activeCaption,
    currentClipIndex,
    activeSourceId,
    play,
    pause,
    seekEdl,
  };
}
