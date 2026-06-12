import { useState, useCallback, useEffect, useRef } from 'react';
import { announce } from '../utils/announcer.js';

// Stripped from probe: EventLoggerContext import, eventTypes import, Actors import,
// logEvent calls in handleTextMove/handleTextChange/handleTextApply/handleTextRemove,
// and actor param (researcher telemetry only).

function getOverlaySignature(overlays = []) {
  return overlays
    .map((overlay) => `${overlay.id}:${overlay.sceneId || ''}:${overlay.content}:${overlay.size}:${overlay.color}:${overlay.x}:${overlay.y}:${overlay.appliedAt || ''}`)
    .join('|');
}

export default function useTextOverlay({
  initialOverlays = [],
  onOverlaysChange,
  sceneId = null,
} = {}) {
  const [textOverlays, setTextOverlays] = useState(initialOverlays);
  const [activeOverlayId, setActiveOverlayId] = useState(null);
  const [textToolActive, setTextToolActive] = useState(false);
  const syncingFromPropsRef = useRef(false);
  const onOverlaysChangeRef = useRef(onOverlaysChange);
  const initialSignature = getOverlaySignature(initialOverlays);
  // Track the props signature we last reconciled with. Without this, any
  // local edit (e.g. adding a text overlay via the T Text tool) re-runs the
  // props-sync effect, sees that local has diverged from props (the parent
  // hasn't broadcast the new overlay back yet), and clobbers the local
  // state — wiping out the new overlay AND setTextToolActive(false). The
  // gate makes the sync only fire when props themselves changed.
  const lastInitialSignatureRef = useRef(initialSignature);

  useEffect(() => {
    onOverlaysChangeRef.current = onOverlaysChange;
  }, [onOverlaysChange]);

  useEffect(() => {
    if (initialSignature === lastInitialSignatureRef.current) {
      // Props unchanged since last reconciliation — this fire was caused by
      // a local textOverlays update. Do not revert.
      return;
    }
    // Don't reconcile from props while the user is actively editing an overlay
    // (text tool open with a selection). A parent echoing a stale set here
    // would wipe the in-progress overlay and close the tool mid-edit. The
    // signature is intentionally NOT recorded, so the sync re-fires and
    // reconciles once the edit ends (textToolActive flips false).
    if (textToolActive && activeOverlayId) return;
    lastInitialSignatureRef.current = initialSignature;
    const currentSignature = getOverlaySignature(textOverlays);
    if (initialSignature === currentSignature) return;
    syncingFromPropsRef.current = true;
    setTextOverlays(initialOverlays);
    if (activeOverlayId && !initialOverlays.some((overlay) => overlay.id === activeOverlayId)) {
      setActiveOverlayId(null);
      setTextToolActive(false);
    }
  }, [activeOverlayId, textToolActive, initialOverlays, initialSignature, textOverlays]);

  useEffect(() => {
    if (!onOverlaysChangeRef.current) return;
    if (syncingFromPropsRef.current) {
      syncingFromPropsRef.current = false;
      return;
    }
    onOverlaysChangeRef.current(textOverlays);
  }, [textOverlays]);

  const handleTextTool = useCallback(() => {
    if (textToolActive) {
      setTextToolActive(false);
      setActiveOverlayId(null);
      return;
    }
    const newOverlay = {
      id: `text-${Date.now()}`,
      content: 'Text',
      size: 'M',
      color: '#FFFFFF',
      x: 50,
      y: 50,
      sceneId,
    };
    setTextOverlays(prev => [...prev, newOverlay]);
    setActiveOverlayId(newOverlay.id);
    setTextToolActive(true);
    announce('Text overlay tool activated. Type your text and drag to position.');
  }, [sceneId, textToolActive]);

  const handleTextMove = useCallback((id, x, y) => {
    setTextOverlays(prev => prev.map(o => o.id === id ? { ...o, x, y } : o));
  }, []);

  const handleTextChange = useCallback((field, value) => {
    if (!activeOverlayId) return;
    setTextOverlays(prev => prev.map(o =>
      o.id === activeOverlayId ? { ...o, [field]: value } : o
    ));
  }, [activeOverlayId]);

  const handleTextApply = useCallback(() => {
    const overlay = textOverlays.find(o => o.id === activeOverlayId);
    if (overlay) {
      setTextOverlays(prev => prev.map(o =>
        o.id === activeOverlayId ? { ...o, appliedAt: Date.now() } : o
      ));
      announce(`Text overlay applied with text: ${overlay.content}`);
    } else {
      announce('Text overlay applied');
    }
    setActiveOverlayId(null);
    setTextToolActive(false);
  }, [activeOverlayId, textOverlays]);

  const handleTextRemove = useCallback(() => {
    setTextOverlays(prev => prev.filter(o => o.id !== activeOverlayId));
    setActiveOverlayId(null);
    setTextToolActive(false);
    announce('Text overlay removed');
  }, [activeOverlayId]);

  const activeOverlay = textOverlays.find(o => o.id === activeOverlayId) || null;

  return {
    textOverlays, activeOverlay, activeOverlayId, textToolActive,
    handleTextTool, handleTextMove, handleTextChange, handleTextApply, handleTextRemove,
  };
}
