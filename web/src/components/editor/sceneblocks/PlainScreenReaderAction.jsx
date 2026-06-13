import { useCallback, useEffect, useRef } from 'react';

// Ported verbatim from
// video-collab-probe/src/components/shared/PlainScreenReaderAction.jsx
// (Phase 2a Task 1). No study-only imports — nothing stripped.

const ACTIVATE_DEDUPE_MS = 250;
const BLUR_DISARM_DELAY_MS = 650;
const POINTER_CANCEL_PX = 10;
const RECENT_POINTER_MS = 800;

function getEventElement(target) {
  return target instanceof Element ? target : target?.parentElement || null;
}

/**
 * Roleless action target for the few controls where TalkBack/VoiceOver must
 * speak only the provided phrase, without "button" or activation hints.
 *
 * The node itself has no click action. While it is focused, a document-level
 * capture listener catches screen-reader double-tap clicks before they can
 * fall through to nearby scene controls. Pointer activation is handled with
 * pointer events so sighted taps still work normally.
 */
export default function PlainScreenReaderAction({
  actionRef,
  ariaLabel,
  onActivate,
  className,
  style,
  children,
  ...props
}) {
  const rootRef = useRef(null);
  const documentDisarmRef = useRef(null);
  const lastDocumentPointerRef = useRef(null);
  const lastActivatedAtRef = useRef(0);
  const blurDisarmTimerRef = useRef(null);
  const pointerRef = useRef(null);

  const setRootRef = useCallback((node) => {
    rootRef.current = node;
    if (typeof actionRef === 'function') {
      actionRef(node);
    } else if (actionRef && 'current' in actionRef) {
      actionRef.current = node;
    }
  }, [actionRef]);

  const disarmDocumentActivation = useCallback(() => {
    if (blurDisarmTimerRef.current !== null) {
      clearTimeout(blurDisarmTimerRef.current);
      blurDisarmTimerRef.current = null;
    }
    if (documentDisarmRef.current) {
      documentDisarmRef.current();
      documentDisarmRef.current = null;
    }
  }, []);

  const scheduleDocumentDisarm = useCallback(() => {
    if (blurDisarmTimerRef.current !== null) {
      clearTimeout(blurDisarmTimerRef.current);
    }
    blurDisarmTimerRef.current = setTimeout(() => {
      blurDisarmTimerRef.current = null;
      disarmDocumentActivation();
    }, BLUR_DISARM_DELAY_MS);
  }, [disarmDocumentActivation]);

  const activate = useCallback(() => {
    const now = Date.now();
    if (now - lastActivatedAtRef.current < ACTIVATE_DEDUPE_MS) return;
    lastActivatedAtRef.current = now;
    onActivate?.();
  }, [onActivate]);
  const activateRef = useRef(activate);
  activateRef.current = activate;

  const armDocumentActivation = useCallback((node) => {
    disarmDocumentActivation();
    const doc = node.ownerDocument;
    if (!doc) return;

    const handleDocumentPointerDown = (event) => {
      const target = getEventElement(event.target);
      lastDocumentPointerRef.current = {
        inside: Boolean(target && node.contains(target)),
        time: Date.now(),
      };
    };

    const handleDocumentClick = (event) => {
      if (rootRef.current !== node) return;

      const target = getEventElement(event.target);
      const clickedInside = Boolean(target && node.contains(target));
      const pointer = lastDocumentPointerRef.current;
      const hadRecentPointer = pointer && Date.now() - pointer.time < RECENT_POINTER_MS;
      const isLikelyAssistiveClick = event.detail === 0;

      // A normal click somewhere else should keep behaving normally. A
      // TalkBack/VoiceOver double-tap often arrives as a synthetic click with
      // no useful pointerdown, and may target the scene header or another
      // nearby element; capture that case and route it to the focused action.
      if (hadRecentPointer && !pointer.inside && !clickedInside && !isLikelyAssistiveClick) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      activateRef.current?.();
      if (node.isConnected && node.ownerDocument.activeElement !== node) {
        node.focus({ preventScroll: true });
      }
    };

    doc.addEventListener('pointerdown', handleDocumentPointerDown, true);
    doc.addEventListener('click', handleDocumentClick, true);
    documentDisarmRef.current = () => {
      doc.removeEventListener('pointerdown', handleDocumentPointerDown, true);
      doc.removeEventListener('click', handleDocumentClick, true);
      lastDocumentPointerRef.current = null;
    };
  }, [disarmDocumentActivation]);

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return undefined;

    const handlePointerDown = (event) => {
      if (event.button != null && event.button !== 0) return;
      pointerRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        active: true,
      };
    };

    const handlePointerMove = (event) => {
      const pointer = pointerRef.current;
      if (!pointer || pointer.pointerId !== event.pointerId || !pointer.active) return;
      const dx = Math.abs(event.clientX - pointer.startX);
      const dy = Math.abs(event.clientY - pointer.startY);
      if (dx > POINTER_CANCEL_PX || dy > POINTER_CANCEL_PX) {
        pointer.active = false;
      }
    };

    const handlePointerUp = (event) => {
      const pointer = pointerRef.current;
      pointerRef.current = null;
      const target = getEventElement(event.target);
      if (!pointer || pointer.pointerId !== event.pointerId || !pointer.active) return;
      if (!target || !node.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
      activate();
    };

    const handlePointerCancel = () => {
      pointerRef.current = null;
    };

    node.addEventListener('pointerdown', handlePointerDown);
    node.addEventListener('pointermove', handlePointerMove);
    node.addEventListener('pointerup', handlePointerUp);
    node.addEventListener('pointercancel', handlePointerCancel);
    return () => {
      node.removeEventListener('pointerdown', handlePointerDown);
      node.removeEventListener('pointermove', handlePointerMove);
      node.removeEventListener('pointerup', handlePointerUp);
      node.removeEventListener('pointercancel', handlePointerCancel);
    };
  }, [activate]);

  useEffect(() => disarmDocumentActivation, [disarmDocumentActivation]);

  return (
    <div
      ref={setRootRef}
      tabIndex={0}
      onFocus={(event) => armDocumentActivation(event.currentTarget)}
      onBlur={scheduleDocumentDisarm}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
        }
      }}
      aria-label={ariaLabel}
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        ...style,
      }}
      {...props}
    >
      {children}
    </div>
  );
}
