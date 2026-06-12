/**
 * Builds the initialSources array from loaded description data.
 * If data.videos exists (multi-video), returns all videos as sources with segments.
 * Otherwise falls back to the single data.video as one source.
 */
export function buildInitialSources(data) {
  if (!data) return [];

  if (data.videos && data.videos.length > 0) {
    return data.videos.map((v) => ({
      id: v.id,
      name: v.title || v.src.split('/').pop(),
      src: v.src,
      duration: v.duration,
      segments: v.segments || [],
    }));
  }

  // Fallback: single video
  if (data.video) {
    return [{
      id: 'default',
      name: data.video.title || 'Sample',
      src: data.video.src,
      duration: data.video.duration,
      segments: data.video.segments || [],
    }];
  }

  return [];
}

/**
 * Builds a combined, sequentially-timed segments array from all video sources.
 * Each segment's start_time/end_time is offset so they tile across the full timeline.
 * Also attaches sourceId and sourceName for display.
 */
export function buildAllSegments(data) {
  if (!data) return [];

  const videos = data.videos && data.videos.length > 0
    ? data.videos
    : data.video ? [data.video] : [];

  const allSegments = [];
  let timeOffset = 0;

  for (const video of videos) {
    const segs = video.segments || [];
    for (const seg of segs) {
      allSegments.push({
        ...seg,
        start_time: timeOffset + seg.start_time,
        end_time: timeOffset + seg.end_time,
        sourceId: video.id || 'default',
        sourceName: video.title || video.src?.split('/').pop() || 'Untitled',
      });
    }
    timeOffset += video.duration || 0;
  }

  return allSegments;
}

/**
 * Returns the total duration across all video sources.
 */
export function getTotalDuration(data) {
  if (!data) return 0;

  if (data.videos && data.videos.length > 0) {
    return data.videos.reduce((sum, v) => sum + (v.duration || 0), 0);
  }

  return data.video?.duration || 0;
}
