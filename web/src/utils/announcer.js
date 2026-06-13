/**
 * Screen-reader live announcer.
 *
 * Messages are queued and drained one at a time with a small gap between
 * each, which gives the screen reader enough of a DOM-mutation signal to
 * pick up each announcement separately. The previous setTimeout-clear-
 * then-set pattern dropped the first message whenever a second announce()
 * ran within ~100ms (M8 in walkthrough_findings_2026-04-25.md). Concrete
 * example of the dropped case: a user expands a scene block, which fires
 * `announce("Opened scene 1...")`; meanwhile the granularity selector
 * happens to fire `announce("Detail level changed to Detailed")` because
 * a parent-driven re-render commits in the same frame. With the old
 * implementation the user heard only the second; with the queue both
 * announcements are read.
 *
 * The elements set `aria-live` + `aria-atomic="true"` in App.jsx (NO explicit
 * role="status"/"alert" — that makes VoiceOver speak the role name after every
 * message). This module only manages the text content.
 */

const QUEUE_GAP_MS = 150;
// M2: how long an announcement stays in the live region before being
// cleared. Long enough that screen readers always finish speaking; short
// enough that re-focusing the [status] region later doesn't re-read a
// many-actions-stale message.
const STALE_CLEAR_MS = 2000;

const queue = [];
let draining = false;
let clearTimer = null;
let muted = false;

function setText(text, assertive) {
  // Two live regions live in the page (App.jsx):
  //   #sr-announcer (polite) — default, queues behind current speech.
  //   #sr-announcer-assertive (alert) — interrupts current speech.
  //
  // Assertive is needed when an announce immediately follows a React
  // state-driven re-render that TalkBack reacts to (e.g. detail-level
  // change re-renders nearby DOM and TalkBack starts re-reading the
  // activated button — the polite live-region update gets dropped).
  const id = assertive ? 'sr-announcer-assertive' : 'sr-announcer';
  const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
  if (!el) return;
  // A pending stale-clear from a previous message would otherwise wipe
  // the new message before SR finishes speaking it.
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
  // Clear first so the screen reader sees a real DOM change even when the
  // next message is identical to the current text.
  el.textContent = '';
  // Schedule the actual set on the next tick — this gives the live region
  // a moment to register the empty state before the new content arrives,
  // which is what makes assistive tech announce the content reliably.
  setTimeout(() => {
    el.textContent = text;
    // M2: queue a delayed clear so the live region returns to empty
    // between announcements. The guards make sure we don't blank out a
    // newer message that arrived during the wait.
    clearTimer = setTimeout(() => {
      clearTimer = null;
      if (queue.length === 0 && el.textContent === text) {
        el.textContent = '';
      }
    }, STALE_CLEAR_MS);
  }, 30);
}

function drain() {
  if (queue.length === 0) {
    draining = false;
    return;
  }
  draining = true;
  const next = queue.shift();
  setText(next.message, next.assertive);
  setTimeout(drain, QUEUE_GAP_MS);
}

/**
 * Announce a message to assistive technology.
 * @param {string} message
 * @param {{ assertive?: boolean }} [options]
 *   When `assertive` is true the message goes to the assertive live
 *   region and interrupts current speech. Use for direct feedback to a
 *   user action (e.g. detail-level change) where TalkBack would
 *   otherwise drown out a polite announce by re-reading the just-
 *   activated button. Default is polite.
 */
export function announce(message, options) {
  if (typeof message !== 'string' || message.length === 0) return;
  if (muted) return;
  queue.push({ message, assertive: !!(options && options.assertive) });
  if (!draining) drain();
}

/**
 * Mute or unmute the live-region announcer.
 * Returns the previous mute state for symmetric restoration.
 */
export function setAnnouncerMuted(next) {
  const prev = muted;
  muted = !!next;
  if (muted) {
    queue.length = 0;
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
    if (typeof document !== 'undefined') {
      const polite = document.getElementById('sr-announcer');
      const assertive = document.getElementById('sr-announcer-assertive');
      if (polite) polite.textContent = '';
      if (assertive) assertive.textContent = '';
    }
  }
  return prev;
}

/**
 * Test-only: clear the pending queue without speaking.
 */
export function _resetAnnouncerForTests() {
  queue.length = 0;
  draining = false;
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
}
