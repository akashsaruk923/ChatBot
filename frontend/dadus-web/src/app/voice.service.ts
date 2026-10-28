import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';

export type VoiceLanguage = 'mr-IN' | 'hi-IN' | 'en-IN';

interface RecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { readonly transcript: string };
}

interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    readonly [index: number]: RecognitionResult;
  };
}

interface BrowserRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface RecognitionBrowser {
  SpeechRecognition?: new () => BrowserRecognition;
  webkitSpeechRecognition?: new () => BrowserRecognition;
}

interface SpeechRequest {
  readonly version: number;
  readonly text: string;
  readonly language: VoiceLanguage;
}

@Injectable({ providedIn: 'root' })
export class VoiceService {
  private readonly destroyRef = inject(DestroyRef);
  private readonly recognitionConstructor =
    (globalThis as RecognitionBrowser).SpeechRecognition ??
    (globalThis as RecognitionBrowser).webkitSpeechRecognition;
  private readonly synthesis = globalThis.speechSynthesis;
  private recognition: BrowserRecognition | null = null;
  private utterance: SpeechSynthesisUtterance | null = null;
  private recognitionVersion = 0;
  private speechVersion = 0;
  private destroyed = false;
  private readonly availableVoices = signal<SpeechSynthesisVoice[]>([]);
  private voiceLoadTimer: ReturnType<typeof setTimeout> | null = null;
  private speechStartTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSpeech: SpeechRequest | null = null;
  private readonly voicesChanged = () => {
    if (this.destroyed) return;
    if (this.refreshVoices().length) {
      this.finishVoiceDiscovery();
      this.playPendingSpeech();
    }
  };

  readonly recognitionSupported = typeof this.recognitionConstructor === 'function';
  readonly synthesisSupported =
    !!this.synthesis && typeof globalThis.SpeechSynthesisUtterance === 'function';
  readonly languages: ReadonlyArray<{ value: VoiceLanguage; label: string }> = [
    { value: 'mr-IN', label: 'Marathi' },
    { value: 'hi-IN', label: 'Hindi' },
    { value: 'en-IN', label: 'English' },
  ];
  readonly language = signal<VoiceLanguage>('mr-IN');
  readonly listening = signal(false);
  readonly speaking = signal(false);
  readonly preparingSpeech = signal(false);
  readonly checkingVoice = signal(false);
  readonly readReplies = signal(false);
  readonly status = signal('');
  readonly error = signal('');
  readonly voiceAvailability = computed(() => {
    if (!this.synthesisSupported) return 'Speech playback is not supported in this browser.';
    const voice = this.findVoice(this.language());
    const label = this.languageLabel(this.language());
    if (voice) return `${label} voice available: ${voice.name} (${voice.lang}).`;
    if (this.checkingVoice()) return 'Loading available browser speech voices…';
    if (!this.availableVoices().length)
      return 'No browser speech voices were found. Check Windows speech voice settings.';
    return `No ${label} speech voice is available. Choose a language with an available voice, or check browser and Windows support for ${label} speech.`;
  });

  constructor() {
    if (this.synthesisSupported) {
      this.synthesis.addEventListener('voiceschanged', this.voicesChanged);
      if (!this.refreshVoices().length) this.beginVoiceDiscovery();
    }
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.stopAll();
      this.synthesis?.removeEventListener('voiceschanged', this.voicesChanged);
    });
  }

  setLanguage(value: string): void {
    if (!this.languages.some((language) => language.value === value)) return;
    this.stopAll();
    this.language.set(value as VoiceLanguage);
    this.error.set('');
    this.status.set('');
  }

  setReadReplies(enabled: boolean): void {
    this.readReplies.set(enabled && this.synthesisSupported);
    if (!enabled) this.stopSpeaking();
  }

  startListening(onFinalTranscript: (text: string) => void): void {
    if (this.destroyed || this.listening()) return;
    this.error.set('');
    this.status.set('');
    if (!this.recognitionConstructor) {
      this.error.set(
        'Voice typing is not available in this browser. Try Chrome or Edge, or type your message.',
      );
      return;
    }

    this.stopSpeaking();
    const version = ++this.recognitionVersion;
    let recognition: BrowserRecognition;
    try {
      recognition = new this.recognitionConstructor();
    } catch {
      this.error.set(
        'Voice typing could not start. Try another supported browser or type your message.',
      );
      return;
    }
    this.recognition = recognition;
    recognition.lang = this.language();
    recognition.continuous = false;
    recognition.interimResults = false;
    const deliveredResults = new Set<number>();
    let receivedText = false;
    const current = () =>
      !this.destroyed && this.recognition === recognition && this.recognitionVersion === version;

    recognition.onstart = () => {
      if (!current()) return;
      this.status.set('Listening… Speak, then review the text before sending.');
    };
    recognition.onresult = (event) => {
      if (!current()) return;
      const parts: string[] = [];
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        if (!result.isFinal || deliveredResults.has(index)) continue;
        deliveredResults.add(index);
        const text = result[0]?.transcript?.trim();
        if (text) parts.push(text);
      }
      if (parts.length) {
        receivedText = true;
        onFinalTranscript(parts.join(' '));
      }
    };
    recognition.onerror = (event) => {
      if (!current()) return;
      this.error.set(this.recognitionError(event.error));
      this.status.set('');
      this.releaseRecognition(recognition);
      this.abortRecognition(recognition);
    };
    recognition.onend = () => {
      if (!current()) return;
      this.releaseRecognition(recognition);
      this.status.set(
        receivedText
          ? 'Voice typing finished. Review your message, then send.'
          : 'No speech was captured. Try again, or type your message.',
      );
    };
    this.listening.set(true);
    this.status.set('Starting microphone… Allow microphone access if prompted.');
    try {
      recognition.start();
    } catch {
      this.releaseRecognition(recognition);
      this.abortRecognition(recognition);
      this.status.set('');
      this.error.set(
        'The microphone could not start. Check browser microphone permission and try again.',
      );
    }
  }

  stopListening(): void {
    const recognition = this.recognition;
    if (!recognition) return;
    this.status.set('Finishing microphone input…');
    try {
      // stop() lets the browser deliver its final transcript before onend.
      recognition.stop();
    } catch {
      this.cancelListening();
    }
  }

  cancelListening(): void {
    const recognition = this.recognition;
    ++this.recognitionVersion;
    if (recognition) {
      this.releaseRecognition(recognition);
      this.abortRecognition(recognition);
    }
    this.listening.set(false);
    this.status.set('');
  }

  readReply(text: string): void {
    if (this.readReplies()) this.speak(text);
  }

  testVoice(): void {
    const samples: Record<VoiceLanguage, string> = {
      'mr-IN': 'नमस्कार! मी दादूस आहे. माझा आवाज ऐकू येतोय का?',
      'hi-IN': 'नमस्ते! मैं दादूस हूँ। क्या मेरी आवाज़ सुनाई दे रही है?',
      'en-IN': 'Hello! This is DADUS. Can you hear my voice?',
    };
    this.speak(samples[this.language()]);
  }

  speak(text: string): void {
    if (this.destroyed || !text.trim()) return;
    this.error.set('');
    this.stopSpeaking();
    if (!this.synthesisSupported) {
      this.error.set(
        'Reading replies aloud is not available in this browser. You can still read the text.',
      );
      return;
    }

    // Playback and microphone input never run together, avoiding speaker echo.
    this.cancelListening();
    this.pendingSpeech = {
      version: this.speechVersion,
      text: text.trim(),
      language: this.language(),
    };
    this.preparingSpeech.set(true);
    if (this.refreshVoices().length) {
      this.finishVoiceDiscovery();
      this.playPendingSpeech();
    } else {
      this.status.set('Loading browser speech voices…');
      this.beginVoiceDiscovery();
    }
  }

  stopSpeaking(): void {
    ++this.speechVersion;
    this.pendingSpeech = null;
    this.clearSpeechStartTimer();
    this.finishVoiceDiscovery();
    if (this.utterance) {
      this.releaseUtterance();
      this.cancelSynthesis();
    }
    this.speaking.set(false);
    this.preparingSpeech.set(false);
    this.status.set('');
  }

  stopAll(): void {
    this.cancelListening();
    this.stopSpeaking();
  }

  private releaseRecognition(recognition: BrowserRecognition): void {
    recognition.onstart = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    if (this.recognition === recognition) this.recognition = null;
    this.listening.set(false);
  }

  private abortRecognition(recognition: BrowserRecognition): void {
    try {
      recognition.abort();
    } catch {
      // A browser may already have ended the recognition session.
    }
  }

  private releaseUtterance(): void {
    this.clearSpeechStartTimer();
    if (this.utterance) {
      this.utterance.onstart = null;
      this.utterance.onend = null;
      this.utterance.onerror = null;
    }
    this.utterance = null;
    this.speaking.set(false);
    this.preparingSpeech.set(false);
  }

  private refreshVoices(): SpeechSynthesisVoice[] {
    let voices: SpeechSynthesisVoice[] = [];
    try {
      voices = this.synthesis.getVoices();
    } catch {
      // Some browsers expose speech synthesis before its engine is ready.
    }
    this.availableVoices.set(voices);
    return voices;
  }

  private beginVoiceDiscovery(): void {
    if (this.voiceLoadTimer !== null) return;
    this.checkingVoice.set(true);
    this.voiceLoadTimer = setTimeout(() => {
      this.voiceLoadTimer = null;
      this.checkingVoice.set(false);
      if (this.destroyed) return;
      this.refreshVoices();
      this.playPendingSpeech();
    }, 2000);
  }

  private finishVoiceDiscovery(): void {
    if (this.voiceLoadTimer !== null) clearTimeout(this.voiceLoadTimer);
    this.voiceLoadTimer = null;
    this.checkingVoice.set(false);
  }

  private findVoice(language: VoiceLanguage): SpeechSynthesisVoice | undefined {
    return (
      this.availableVoices().find((voice) => voice.lang.toLowerCase() === language.toLowerCase()) ??
      this.availableVoices().find(
        (voice) => voice.lang.toLowerCase().split('-')[0] === language.split('-')[0],
      )
    );
  }

  private languageLabel(language: VoiceLanguage): string {
    return this.languages.find((item) => item.value === language)?.label ?? language;
  }

  private playPendingSpeech(): void {
    const pending = this.pendingSpeech;
    if (!pending || this.destroyed || pending.version !== this.speechVersion) return;
    this.pendingSpeech = null;
    const voice = this.findVoice(pending.language);
    if (!voice) {
      this.preparingSpeech.set(false);
      this.status.set('');
      const label = this.languageLabel(pending.language);
      this.error.set(
        this.availableVoices().length
          ? `No ${label} speech voice is available in this browser. Choose a language with an available voice, or check browser and Windows support for ${label} speech.`
          : 'No browser speech voices loaded. Check Windows speech voice settings, then click Test voice to try again.',
      );
      return;
    }

    this.playSpeechChunk(pending, voice, this.splitSpeechText(pending.text), 0);
  }

  private playSpeechChunk(
    pending: SpeechRequest,
    voice: SpeechSynthesisVoice,
    chunks: readonly string[],
    index: number,
  ): void {
    if (this.destroyed || pending.version !== this.speechVersion) return;

    let utterance: SpeechSynthesisUtterance;
    try {
      utterance = new SpeechSynthesisUtterance(chunks[index]);
    } catch {
      this.preparingSpeech.set(false);
      this.status.set('');
      this.error.set(
        'The browser speech engine could not start. Restart the browser and try Test voice.',
      );
      return;
    }
    utterance.lang = pending.language;
    utterance.voice = voice;
    this.utterance = utterance;
    const current = () =>
      !this.destroyed && this.utterance === utterance && this.speechVersion === pending.version;
    utterance.onstart = () => {
      if (!current()) return;
      this.clearSpeechStartTimer();
      this.preparingSpeech.set(false);
      this.speaking.set(true);
      this.status.set(
        voice.lang.toLowerCase() === pending.language.toLowerCase()
          ? 'Reading the reply…'
          : `Reading with a ${this.languageLabel(pending.language)} voice (${voice.lang}).`,
      );
    };
    utterance.onend = () => {
      if (!current()) return;
      this.releaseUtterance();
      if (index + 1 < chunks.length) {
        // Queue one short utterance at a time: long utterances can stall in Chrome.
        this.playSpeechChunk(pending, voice, chunks, index + 1);
      } else {
        this.status.set('Finished reading the reply.');
      }
    };
    utterance.onerror = (event) => {
      if (!current()) return;
      this.releaseUtterance();
      this.cancelSynthesis();
      this.status.set('');
      this.error.set(this.synthesisError(event?.error));
    };
    this.speaking.set(false);
    this.preparingSpeech.set(true);
    this.status.set(`Starting ${this.languageLabel(pending.language)} audio…`);
    this.speechStartTimer = setTimeout(() => {
      this.speechStartTimer = null;
      if (!current()) return;
      this.releaseUtterance();
      this.cancelSynthesis();
      this.status.set('');
      this.error.set(
        'Audio did not start. Click Test voice or Read reply directly, unmute this tab, and check Windows speaker output and volume.',
      );
    }, 8000);
    try {
      if (this.synthesis.paused) this.synthesis.resume();
      this.synthesis.speak(utterance);
    } catch {
      this.releaseUtterance();
      this.cancelSynthesis();
      this.status.set('');
      this.error.set(
        'The browser could not start speech. Check your audio settings and try Test voice.',
      );
    }
  }

  private clearSpeechStartTimer(): void {
    if (this.speechStartTimer !== null) clearTimeout(this.speechStartTimer);
    this.speechStartTimer = null;
  }

  private splitSpeechText(text: string): string[] {
    const characters = Array.from(text);
    const chunks: string[] = [];
    let offset = 0;
    while (offset < characters.length) {
      let end = Math.min(offset + 220, characters.length);
      if (end < characters.length) {
        let wordBoundary = -1;
        for (let index = end - 1; index >= offset + 80; index--) {
          if (/[.!?।\n]/u.test(characters[index])) {
            end = index + 1;
            wordBoundary = -1;
            break;
          }
          if (wordBoundary < 0 && /\s/u.test(characters[index])) wordBoundary = index + 1;
        }
        if (wordBoundary >= 0) end = wordBoundary;
      }
      const chunk = characters.slice(offset, end).join('').trim();
      if (chunk) chunks.push(chunk);
      offset = end;
    }
    return chunks;
  }

  private cancelSynthesis(): void {
    try {
      this.synthesis.cancel();
    } catch {
      // Cleanup still clears local state if a browser engine has already stopped.
    }
  }

  private synthesisError(code: string | undefined): string {
    switch (code) {
      case 'not-allowed':
        return 'Your browser blocked audio playback. Click Test voice or Read reply directly, allow sound in site settings, and unmute this tab.';
      case 'audio-busy':
        return 'Audio output is busy. Check Windows speaker output and close other audio apps, then try Test voice.';
      case 'audio-hardware':
        return 'No working audio output was found. Check your Windows speaker or headphone output and volume.';
      case 'network':
        return 'The browser speech voice could not connect. Check your internet connection or install an offline speech voice.';
      case 'synthesis-unavailable':
        return 'The browser speech engine is unavailable. Restart the browser and check Windows speech voices.';
      case 'language-unavailable':
      case 'voice-unavailable':
        return 'The selected speech voice is unavailable. Choose a language with an available voice, or check browser and Windows speech support.';
      case 'text-too-long':
        return 'This reply is too long for the browser speech engine. Try a shorter reply.';
      case 'canceled':
      case 'interrupted':
        return 'Speech was interrupted. Click Test voice or Read reply to try again.';
      default:
        return 'The browser could not read this reply. Check your speech voice and audio settings, then try Test voice.';
    }
  }

  private recognitionError(code: string): string {
    switch (code) {
      case 'not-allowed':
      case 'service-not-allowed':
        return 'Microphone access was denied. Allow microphone access in browser site settings and use localhost or HTTPS.';
      case 'audio-capture':
        return 'No usable microphone was found. Connect a microphone and check Windows input settings.';
      case 'no-speech':
        return 'No speech was detected. Try speaking again, or type your message.';
      case 'network':
        return 'The browser speech service could not connect. Check your internet connection or type your message.';
      case 'language-not-supported':
        return 'The browser speech service does not support this language. Choose another voice language or type your message.';
      case 'aborted':
        return 'Voice typing stopped. You can try again or type your message.';
      default:
        return 'Voice typing could not finish. Try again, or type your message.';
    }
  }
}
