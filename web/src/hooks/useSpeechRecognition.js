import { useState, useRef, useCallback, useEffect } from 'react';
import { announce } from '../utils/announcer.js';
import { playEarcon } from '../utils/earcon.js';

// Two-tone earcons frame the listening window so a BLV participant knows
// exactly when the mic is hot (rising "go" chime) and when it has captured
// their speech (falling "got it" tone). Frequencies are picked to be
// distinct from typical phone notification ranges.
const READY_EARCON = { freq: 880, duration: 140 };   // bright "speak now"
const HEARD_EARCON = { freq: 587, duration: 110 };   // soft "got it"
const ERROR_EARCON = { freq: 330, duration: 220 };   // low "something went wrong"

export default function useSpeechRecognition({
  lang = 'en-GB',
  onResult,
  announcement = 'Speak now.',
} = {}) {
  const [isListening, setIsListening] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const recognitionRef = useRef(null);
  const gotResultRef = useRef(false);
  const mountedRef = useRef(true);

  // Stop recognition and block any further state updates once unmounted.
  // StrictMode runs setup -> cleanup -> setup once in development, so the
  // setup must explicitly re-arm the ref after that trial cleanup.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      try { recognitionRef.current?.abort?.(); } catch { /* ignore */ }
    };
  }, []);

  const toggleListening = useCallback(() => {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      announce('Voice input is not supported in this browser.');
      return;
    }

    if ((isListening || isPreparing) && recognitionRef.current) {
      // Mark this instance cancelled so a late onstart/onresult (which can fire
      // after stop() during the preparing window) can't flip us back to
      // listening or emit a result the user has chosen to discard.
      recognitionRef.current._cancelled = true;
      recognitionRef.current.stop();
      setIsListening(false);
      setIsPreparing(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = lang;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    // onstart fires when the speech service has actually opened the mic —
    // not at recognition.start() which returns synchronously well before
    // capture begins. This is the correct moment to tell the participant
    // they can speak.
    recognition.onstart = () => {
      if (recognition._cancelled || !mountedRef.current) return;
      setIsPreparing(false);
      setIsListening(true);
      gotResultRef.current = false;
      playEarcon(READY_EARCON.freq, READY_EARCON.duration);
      // Assertive so it replaces any queued chatter and is the single spoken
      // cue for "the mic is open" — the earcon is the audible "go", this is
      // the words. Everything else (preparing/closed) is intentionally silent
      // to keep the voice flow quiet for screen-reader users.
      announce(announcement, { assertive: true });
    };

    recognition.onresult = (event) => {
      if (recognition._cancelled || !mountedRef.current) return;
      const transcript = event.results[0][0].transcript;
      gotResultRef.current = true;
      setIsListening(false);
      setIsPreparing(false);
      playEarcon(HEARD_EARCON.freq, HEARD_EARCON.duration);
      onResult(transcript);
    };

    recognition.onerror = (event) => {
      if (!mountedRef.current) return;
      setIsListening(false);
      setIsPreparing(false);
      // Chrome on Android refuses microphone access on insecure origins
      // (anything that isn't HTTPS or localhost) and surfaces it as
      // 'not-allowed' before even prompting the user. Detect that case
      // and tell the user the actionable thing — "switch to HTTPS" — not
      // the misleading "permission denied".
      const insecure =
        typeof window !== 'undefined' &&
        !window.isSecureContext &&
        window.location?.hostname !== 'localhost' &&
        window.location?.hostname !== '127.0.0.1';
      const messages = {
        'not-allowed': insecure
          ? 'Voice input requires a secure HTTPS connection. Please reopen this page over HTTPS, or use the keyboard microphone instead.'
          : 'Microphone access denied. Please allow microphone permissions in your browser settings.',
        'no-speech': 'No speech detected. Please try again.',
        'audio-capture': 'No microphone found. Please check your audio device.',
        'network': 'Network error during speech recognition. Please check your connection.',
        'service-not-allowed': insecure
          ? 'Voice input requires a secure HTTPS connection.'
          : 'Speech recognition service unavailable.',
      };
      const msg = messages[event.error];
      if (msg) {
        playEarcon(ERROR_EARCON.freq, ERROR_EARCON.duration);
        announce(msg, { assertive: true });
        recognition._errored = true; // so onend doesn't double-announce
      }
    };

    recognition.onend = () => {
      if (!mountedRef.current) return;
      setIsListening(false);
      setIsPreparing(false);
      // Silent on normal close: a captured result, a user-initiated stop, or an
      // already-announced error all need nothing more. Only speak when the mic
      // closed on its own with nothing heard and no error — the one case the
      // user genuinely can't infer (the error earcon already signals failures).
      if (!recognition._cancelled && !gotResultRef.current && !recognition._errored) {
        announce('Microphone closed, nothing heard.', { assertive: true });
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
    // Pre-flight state: button shows "preparing" until onstart confirms the
    // mic is hot (~300–500ms on Android). Deliberately NOT announced — the
    // single "Speak now…" on onstart is the only spoken cue, so the flow
    // isn't a pile-up of "getting ready / speak now / closed".
    setIsPreparing(true);
  }, [isListening, isPreparing, lang, onResult, announcement]);

  return { isListening, isPreparing, toggleListening };
}
