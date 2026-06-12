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
