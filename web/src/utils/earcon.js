// One shared AudioContext for the whole session. Browsers cap the number of
// concurrent (un-closed) AudioContexts (~6 in Chrome); creating a fresh one per
// earcon — which fire on every speech-recognition state change and many probe
// actions — quickly hits that cap, after which `new AudioContext()` throws and
// the BLV participant silently loses their audio cues. Reusing one context (and
// disconnecting each tone's nodes when it ends) keeps earcons working all session.
let sharedCtx = null;

function getCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!sharedCtx) sharedCtx = new AC();
  // Autoplay policy may leave the context suspended until a user gesture.
  if (sharedCtx.state === 'suspended') sharedCtx.resume().catch(() => {});
  return sharedCtx;
}

export function playEarcon(freq = 660, duration = 150) {
  try {
    const ctx = getCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = freq;
    gain.gain.value = 0.3;
    osc.onended = () => {
      try { osc.disconnect(); gain.disconnect(); } catch { /* already gone */ }
    };
    osc.start();
    osc.stop(ctx.currentTime + duration / 1000);
  } catch { /* ignore audio errors */ }
}
