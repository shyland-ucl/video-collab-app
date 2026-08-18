import { createContext, useContext, useReducer, useCallback, useEffect, useMemo } from 'react';

// Stripped from probe: highContrast state, TOGGLE_CONTRAST action, toggleContrast
// callback, and toggleContrast in the exported value (settings-UI coupling only
// used by the probe's researcher settings panel).

const AccessibilityContext = createContext(null);

const STORAGE_KEY = 'accessibilitySettings';

const THEMES = ['default', 'dark', 'hc-dark', 'hc-light'];
const TEXT_SIZES = ['small', 'medium', 'large', 'x-large'];

// First visit honors the OS: dark scheme -> dark, and an explicit contrast
// preference upgrades to the HC variant of that polarity. A stored choice
// (validated below) always wins. jsdom has no matchMedia — treat as default.
function systemTheme() {
  if (typeof matchMedia !== 'function') return 'default';
  try {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const hc = matchMedia('(prefers-contrast: more)').matches;
    return hc ? (dark ? 'hc-dark' : 'hc-light') : (dark ? 'dark' : 'default');
  } catch {
    return 'default';
  }
}

const defaults = {
  textSize: 'medium',
  theme: systemTheme(),
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
    if (TEXT_SIZES.includes(parsed.textSize)) clean.textSize = parsed.textSize;
    if (THEMES.includes(parsed.theme)) clean.theme = parsed.theme;
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
    case 'SET_THEME':
      return { ...state, theme: action.payload };
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

  // Apply text size at the document root so the setting affects every route,
  // including the editor, instead of only changing the Settings screen.
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.dataset.textSize;
    root.dataset.textSize = state.textSize;
    return () => {
      if (previous) root.dataset.textSize = previous;
      else delete root.dataset.textSize;
    };
  }, [state.textSize]);

  // Theme mirrors the text-size treatment; the boot script in index.html set
  // the pre-paint value, this keeps it live for the session.
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.dataset.theme;
    root.dataset.theme = state.theme;
    return () => {
      if (previous) root.dataset.theme = previous;
      else delete root.dataset.theme;
    };
  }, [state.theme]);

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

  const setTheme = useCallback((theme) => {
    dispatch({ type: 'SET_THEME', payload: theme });
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
    setTheme,
    toggleAudio,
    setSpeechRate,
  }), [state, setTextSize, setTheme, toggleAudio, setSpeechRate]);

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
