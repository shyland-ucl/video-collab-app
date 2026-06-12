import { useEffect } from 'react';

let rootInertLocks = 0;
let rootWasAlreadyInert = false;

function resolveTarget(target) {
  if (!target) return null;
  if (typeof target === 'function') return target();
  if ('current' in target) return target.current;
  return target;
}

function acquireRootInert() {
  const root = document.getElementById('root');
  if (!root) return () => {};

  if (rootInertLocks === 0) {
    rootWasAlreadyInert = root.hasAttribute('inert');
    root.setAttribute('inert', '');
  }

  rootInertLocks += 1;
  let released = false;

  return () => {
    if (released) return;
    released = true;
    rootInertLocks = Math.max(0, rootInertLocks - 1);

    if (rootInertLocks === 0 && !rootWasAlreadyInert) {
      root.removeAttribute('inert');
    }
  };
}

export function useRootInert(
  active,
  { initialFocus, restoreFocus, focusDelay = 0 } = {},
) {
  useEffect(() => {
    if (!active) return undefined;

    const release = acquireRootInert();
    let focusTimer = null;
    const focusFrame = requestAnimationFrame(() => {
      focusTimer = setTimeout(() => {
        resolveTarget(initialFocus)?.focus?.({ preventScroll: true });
      }, focusDelay);
    });

    return () => {
      cancelAnimationFrame(focusFrame);
      if (focusTimer !== null) clearTimeout(focusTimer);
      release();
      resolveTarget(restoreFocus)?.focus?.({ preventScroll: true });
    };
  }, [active, initialFocus, restoreFocus, focusDelay]);
}
