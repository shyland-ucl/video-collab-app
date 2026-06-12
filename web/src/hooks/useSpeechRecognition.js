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
  useEffect(() => () => {
    mountedRef.current = false;
    try { recognitionRef.current?.abort?.(); } catch { /* ignore */ }
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
      announce(announcement);
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
        announce(msg);
      }
    };

    recognition.onend = () => {
      if (!mountedRef.current) return;
      setIsListening(false);
      setIsPreparing(false);
      // If the recogniser ended without ever firing onresult (silence timeout,
      // etc.), nudge them so they're not left wondering whether they were
      // heard — but stay quiet when the user themselves stopped it.
      if (!recognition._cancelled && !gotResultRef.current) {
        announce('Microphone closed.');
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
    // Pre-flight state: button shows "preparing" / "Wait..." until onstart
    // confirms the mic is hot. Brief on most devices, ~300–500ms on Android.
    setIsPreparing(true);
    announce('Getting the microphone ready.');
  }, [isListening, isPreparing, lang, onResult, announcement]);

  return { isListening, isPreparing, toggleListening };
}
