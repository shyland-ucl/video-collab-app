import { logEvent } from '../lib/events';

/**
 * Text-to-Speech service singleton using the Web Speech API.
 */
class TTSService {
  constructor() {
    this._synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
  }

  /**
   * Speak the given text.
   * @param {string} text - Text to speak
   * @param {object} options - Optional settings: rate, pitch, lang
   */
  speak(text, options = {}) {
    if (!this._synth) return;
    this.stop();
    // Trial log: every spoken prompt, length only (the text itself is already
    // captured where it matters — ai_edit_request / vqa_request payloads).
    logEvent('tts_spoken', { chars: text?.length ?? 0 });

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = options.rate ?? 1;
    utterance.pitch = options.pitch ?? 1;
    utterance.lang = options.lang ?? 'en-GB';

    this._synth.speak(utterance);
  }

  /** Cancel any current speech. */
  stop() {
    if (this._synth) {
      this._synth.cancel();
    }
  }

  /** Whether speech is currently in progress. */
  get isSpeaking() {
    return this._synth ? this._synth.speaking : false;
  }
}

const ttsService = new TTSService();
export default ttsService;
