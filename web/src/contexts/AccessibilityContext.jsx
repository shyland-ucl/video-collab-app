import { createContext, useContext, useReducer, useCallback, useEffect, useMemo } from 'react';

// Stripped from probe: highContrast state, TOGGLE_CONTRAST action, toggleContrast
// callback, and toggleContrast in the exported value (settings-UI coupling only
// used by the probe's researcher settings panel).

const AccessibilityContext = createContext(null);

const STORAGE_KEY = 'accessibilitySettings';

const defaults = {
  textSize: 'medium',
  audioEnabled: false,
  speechRate: 1.2,
};

// Validate persisted settings before they feed rendering / TTS. A corrupt or
// hand-edited localStorage value (wrong types, out-of-range rate) would
// otherwise propagate into speechSynthesis.rate (throws) or class names.
function loadFromStorage() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object') return null;
    const clean = {};
    if (['small', 'medium', 'large'].includes(parsed.textSize)) clean.textSize = parsed.textSize;
    if (typeof parsed.audioEnabled === 'boolean') clean.audioEnabled = parsed.audioEnabled;
    if (typeof parsed.speechRate === 'number' && parsed.speechRate >= 0.5 && parsed.speechRate <= 3) {
      clean.speechRate = parsed.speechRate;
    }
    return clean;
  } catch { /* ignore */ }
  return null;
}

const initialState = { ...defaults, ...loadFromStorage() };

function reducer(state, action) {
  switch (action.type) {
    case 'SET_TEXT_SIZE':
      return { ...state, textSize: action.payload };
    case 'TOGGLE_AUDIO':
      return { ...state, audioEnabled: !state.audioEnabled };
    case 'SET_SPEECH_RATE':
      return { ...state, speechRate: action.payload };
    default:
      return state;
  }
}

export function AccessibilityProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Persist to localStorage with debounce to avoid thrashing on rapid changes
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch { /* quota / serialization — settings persist in memory this session */ }
    }, 500);
    return () => clearTimeout(timer);
  }, [state]);

  const setTextSize = useCallback((size) => {
    dispatch({ type: 'SET_TEXT_SIZE', payload: size });
  }, []);

  const toggleAudio = useCallback(() => {
    dispatch({ type: 'TOGGLE_AUDIO' });
  }, []);

  const setSpeechRate = useCallback((rate) => {
    dispatch({ type: 'SET_SPEECH_RATE', payload: rate });
  }, []);

  const value = useMemo(() => ({
    ...state,
    setTextSize,
    toggleAudio,
    setSpeechRate,
  }), [state, setTextSize, toggleAudio, setSpeechRate]);

  return (
    <AccessibilityContext.Provider value={value}>
      {children}
    </AccessibilityContext.Provider>
  );
}

export function useAccessibility() {
  const context = useContext(AccessibilityContext);
  if (!context) {
    throw new Error('useAccessibility must be used within an AccessibilityProvider');
  }
  return context;
}
