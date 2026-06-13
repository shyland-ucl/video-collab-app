import TextOverlay from './TextOverlay'
import { rootSegmentId } from '../../lib/editor/stateStore'

// Ported from probe src/components/shared/VideoPlayer.jsx (Task 10), reduced to
// the helper-preview surface.
//
// Stripped per the adaptation contract:
// - useEventLogger / EventTypes / Actors / logEvent / setVideoTime — deleted
// - the imperative handle (play/pause/seek/getCurrentTime/video/edlDuration)
//   and useImperativeHandle — the engine now lives in HelperDevice, which owns
//   transport + EDL and passes the live frame values down as props
// - the single-source <video> path, per-clip volume effect, 20Hz polling
//   effect, useSpeechRecognition, captionFontSize via a11y — HelperDevice owns
//   the engine and time, so this is now a controlled presentational preview
//
// Kept faithful: one <video> per source (only the active one visible), all
// elements aria-hidden + tabIndex=-1 (the AT surface is the activity feed +
// timeline), the CSS filter/transform colour mapping, the visible-overlay
// filter by active scene, and the bottom caption band.
//
// Scene identity (overlay visibility + colour) is keyed on rootSegmentId so a
// split's halves resolve to the original scene — the same convention used by
// EditorTimeline (colour persist/read) and HelperDevice (active-colour read).

export default function EditorVideoPlayer({
  sources = [],
  videoRefs,
  activeSourceId,
  activeClip,
  activeCaption,
  textOverlays = [],
  videoFilter,
  videoTransform,
  maxHeight,
  // editing overlays live above the preview and are dragged in place
  editingOverlayId = null,
  onOverlayMove,
}) {
  const activeSceneId = activeClip?.id ? rootSegmentId(activeClip.id) : null
  const visibleTextOverlays = textOverlays.filter((overlay) => (
    !overlay.sceneId || (activeSceneId && rootSegmentId(overlay.sceneId) === activeSceneId)
  ))

  return (
    <div
      className="relative bg-black mx-auto overflow-hidden"
      style={{ aspectRatio: '16 / 9', width: '100%', maxHeight: maxHeight || undefined, contain: 'paint' }}
    >
      {sources.map((source, idx) => {
        const isActive = activeSourceId ? activeSourceId === source.id : idx === 0
        return (
          <video
            key={source.id}
            ref={(el) => {
              if (videoRefs?.[source.id]) videoRefs[source.id].current = el
            }}
            src={source.src ?? undefined}
            className="w-full h-full object-contain absolute inset-0"
            style={{
              display: isActive ? 'block' : 'none',
              filter: videoFilter || undefined,
              transform: videoTransform || undefined,
              transformOrigin: 'center center',
              transition: 'transform 0.2s ease-out',
            }}
            preload="metadata"
            playsInline
            aria-hidden="true"
            tabIndex={-1}
          />
        )
      })}

      {/* Editing/applied text overlays render on top of the active scene. */}
      {visibleTextOverlays.map((overlay) => (
        <TextOverlay
          key={overlay.id}
          overlay={overlay}
          isEditing={overlay.id === editingOverlayId}
          onMove={onOverlayMove || (() => {})}
        />
      ))}

      {/* Caption band */}
      {activeCaption && (
        <div className="absolute bottom-0 left-0 right-0 flex justify-center pointer-events-none" style={{ padding: '0 8px 16px' }}>
          <div
            className="px-4 py-2 rounded text-white text-center max-w-[90%]"
            style={{ backgroundColor: 'rgba(0, 0, 0, 0.75)', textShadow: '0 1px 3px rgba(0,0,0,0.8)', lineHeight: 1.4 }}
            role="status"
            aria-live="polite"
            aria-label={`Caption: ${activeCaption.text}`}
          >
            {activeCaption.text}
          </div>
        </div>
      )}

      {sources.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-white/60 text-lg">
          No video source loaded
        </div>
      )}
    </div>
  )
}
