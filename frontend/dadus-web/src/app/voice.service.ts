import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';

export type VoiceLanguage = 'mr-IN' | 'hi-IN' | 'en-IN';

export interface ListeningOptions {
  autoFinishAfterSilenceMs?: number;
}

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
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
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

interface DictationSession {
  readonly version: number;
  readonly onFinalTranscript: (text: string) => void;
  readonly onFinished?: () => void;
  readonly autoFinishAfterSilenceMs: number | null;
  receivedText: boolean;
  lostInterim: boolean;
  emptyEnds: number;
  stopping: boolean;
  userStopped: boolean;
  automaticStop: boolean;
  speechActive: boolean;
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
  private dictation: DictationSession | null = null;
  private recognitionRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private recognitionSessionTimer: ReturnType<typeof setTimeout> | null = null;
  private recognitionStopTimer: ReturnType<typeof setTimeout> | null = null;
  private recognitionSilenceTimer: ReturnType<typeof setTimeout> | null = null;
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
  readonly interimTranscript = signal('');
  readonly selectedSpeechVoice = signal('auto');
  readonly speechVoices = computed(() =>
    this.availableVoices().map((voice) => ({
      value: this.voiceKey(voice),
      label: `${voice.name} (${voice.lang})`,
    })),
  );
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
    if (this.selectedSpeechVoice() !== 'auto')
      return voice
        ? `Selected speech voice: ${voice.name} (${voice.lang}). AI replies and microphone stay in ${label}.`
        : 'The selected speech voice is unavailable. Choose another available voice or Auto.';
    if (voice && this.language() === 'mr-IN' && this.voiceLanguage(voice) === 'hi')
      return `No Marathi voice is installed. Using Hindi voice: ${voice.name} (${voice.lang}); Marathi pronunciation may differ.`;
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

  setSpeechVoice(value: string): void {
    if (value !== 'auto' && !this.availableVoices().some((voice) => this.voiceKey(voice) === value))
      return;
    this.stopSpeaking();
    this.selectedSpeechVoice.set(value);
    this.error.set('');
  }

  startListening(
    onFinalTranscript: (text: string) => void,
    onFinished?: () => void,
    options: ListeningOptions = {},
  ): void {
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
    const session: DictationSession = {
      version: ++this.recognitionVersion,
      onFinalTranscript,
      onFinished,
      autoFinishAfterSilenceMs:
        typeof options.autoFinishAfterSilenceMs === 'number' &&
        Number.isFinite(options.autoFinishAfterSilenceMs)
          ? Math.min(5000, Math.max(1000, options.autoFinishAfterSilenceMs))
          : null,
      receivedText: false,
      lostInterim: false,
      emptyEnds: 0,
      stopping: false,
      userStopped: false,
      automaticStop: false,
      speechActive: false,
    };
    this.dictation = session;
    this.interimTranscript.set('');
    this.listening.set(true);
    this.recognitionSessionTimer = setTimeout(
      () => this.requestRecognitionStop(session, false),
      120000,
    );
    this.openRecognition(session);
  }

  private openRecognition(session: DictationSession): void {
    if (!this.isCurrentSession(session) || session.stopping || !this.recognitionConstructor) return;
    let recognition: BrowserRecognition;
    try {
      recognition = new this.recognitionConstructor();
    } catch {
      this.finishRecognition(session);
      this.error.set(
        'Voice typing could not start. Try another supported browser or type your message.',
      );
      return;
    }
    this.recognition = recognition;
    session.speechActive = false;
    recognition.lang = this.language();
    recognition.continuous = true;
    recognition.interimResults = true;
    const deliveredResults = new Set<number>();
    let receivedRunText = false;
    const current = () => this.isCurrentSession(session) && this.recognition === recognition;

    recognition.onstart = () => {
      if (!current()) return;
      this.status.set(
        session.autoFinishAfterSilenceMs === null
          ? 'Listening… Keep speaking, then press Stop when you are finished.'
          : 'Listening… Pause after your question to send it automatically.',
      );
    };
    recognition.onspeechstart = () => {
      if (!current() || session.stopping) return;
      session.speechActive = true;
      this.clearRecognitionSilenceTimer();
    };
    recognition.onspeechend = () => {
      if (!current()) return;
      session.speechActive = false;
      this.armRecognitionSilenceTimer(session);
    };
    recognition.onresult = (event) => {
      if (!current()) return;
      const previousPreview = this.interimTranscript();
      const parts: string[] = [];
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        if (!result.isFinal || deliveredResults.has(index)) continue;
        deliveredResults.add(index);
        const text = result[0]?.transcript?.trim();
        if (text) parts.push(text);
      }
      if (parts.length) {
        receivedRunText = true;
        session.receivedText = true;
        session.onFinalTranscript(parts.join(' '));
      }
      if (!current()) return;
      const interim: string[] = [];
      for (let index = 0; index < event.results.length; index++) {
        const result = event.results[index];
        if (!result.isFinal) {
          const text = result[0]?.transcript?.trim();
          if (text) interim.push(text);
        }
      }
      let preview = interim.join(' ').slice(0, 4000);
      if (/[\uD800-\uDBFF]$/.test(preview)) preview = preview.slice(0, -1);
      this.interimTranscript.set(preview);
      if (parts.length || (preview.trim() && preview !== previousPreview))
        this.armRecognitionSilenceTimer(session, parts.length > 0 && !preview.trim());
    };
    recognition.onerror = (event) => {
      if (!current()) return;
      // Chrome commonly reports no-speech before ending a quiet recognition run.
      // Its onend handler can restart this explicitly opened, bounded session.
      if (event.error === 'no-speech') {
        // Keep tentative words available for a later same-run final result.
        // Only onend can establish that a restart actually discarded them.
        this.status.set('Still listening… Speak when you are ready, or press Stop.');
        return;
      }
      session.userStopped = false;
      this.finishRecognition(session);
      this.error.set(this.recognitionError(event.error));
      this.status.set('');
    };
    recognition.onend = () => {
      if (!current()) return;
      this.releaseRecognition(recognition);
      if (session.stopping) {
        this.finishRecognition(session);
        return;
      }
      // In an automatic turn, a browser endpoint is the end of the question.
      // Reopening here would keep the mic active instead of allowing a reply.
      if (
        session.autoFinishAfterSilenceMs !== null &&
        (session.receivedText || this.interimTranscript().trim())
      ) {
        session.stopping = true;
        session.userStopped = true;
        session.automaticStop = true;
        this.finishRecognition(session);
        return;
      }
      // A browser run may end before its tentative tail becomes final. Later
      // runs cannot prove those words were recovered, so do not auto-send them.
      if (this.interimTranscript().trim()) session.lostInterim = true;
      this.interimTranscript.set('');
      session.emptyEnds = receivedRunText ? 0 : session.emptyEnds + 1;
      if (session.emptyEnds >= 3) {
        this.finishRecognition(session);
        this.error.set(
          'No speech was captured after several attempts. Your text is kept; click Mic to continue, or type your message.',
        );
        return;
      }
      this.status.set('Still listening… Continue speaking, or press Stop when finished.');
      this.recognitionRestartTimer = setTimeout(() => {
        this.recognitionRestartTimer = null;
        this.openRecognition(session);
      }, 250);
    };
    this.status.set('Starting microphone… Allow microphone access if prompted.');
    try {
      recognition.start();
    } catch {
      this.finishRecognition(session);
      this.status.set('');
      this.error.set(
        'The microphone could not start. Check browser microphone permission and try again.',
      );
    }
  }

  stopListening(): void {
    if (this.dictation) this.requestRecognitionStop(this.dictation, true);
  }

  private requestRecognitionStop(
    session: DictationSession,
    userStopped: boolean,
    automaticStop = false,
  ): void {
    if (!this.isCurrentSession(session) || session.stopping) return;
    session.stopping = true;
    session.userStopped = userStopped;
    session.automaticStop = automaticStop;
    this.clearRecognitionSilenceTimer();
    if (this.recognitionSessionTimer !== null) clearTimeout(this.recognitionSessionTimer);
    this.recognitionSessionTimer = null;
    if (this.recognitionRestartTimer !== null) clearTimeout(this.recognitionRestartTimer);
    this.recognitionRestartTimer = null;
    const recognition = this.recognition;
    this.status.set(
      userStopped
        ? 'Finishing microphone input…'
        : 'The two-minute listening limit was reached. Finishing your text…',
    );
    if (!recognition) {
      this.finishRecognition(session);
      return;
    }
    // Keep finals that Chrome delivers during stop, but never wait indefinitely.
    this.recognitionStopTimer = setTimeout(() => this.finishRecognition(session), 1500);
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
    this.dictation = null;
    this.clearRecognitionTimers();
    if (recognition) {
      this.releaseRecognition(recognition);
      this.abortRecognition(recognition);
    }
    this.listening.set(false);
    this.interimTranscript.set('');
    this.status.set('');
  }

  private isCurrentSession(session: DictationSession): boolean {
    return (
      !this.destroyed && this.dictation === session && this.recognitionVersion === session.version
    );
  }

  private armRecognitionSilenceTimer(session: DictationSession, confirmedEndpoint = false): void {
    if (
      !this.isCurrentSession(session) ||
      session.stopping ||
      session.autoFinishAfterSilenceMs === null ||
      (!session.receivedText && !this.interimTranscript().trim())
    )
      return;
    this.clearRecognitionSilenceTimer();
    // Chrome can keep speechActive true until the whole continuous stream ends.
    // A final result is still an endpoint; tentative activity gets a longer
    // bounded idle allowance instead of keeping the microphone open forever.
    const quietTime =
      session.speechActive && !confirmedEndpoint ? 5000 : session.autoFinishAfterSilenceMs;
    this.recognitionSilenceTimer = setTimeout(() => {
      this.recognitionSilenceTimer = null;
      this.requestRecognitionStop(session, true, true);
    }, quietTime);
  }

  private clearRecognitionSilenceTimer(): void {
    if (this.recognitionSilenceTimer !== null) clearTimeout(this.recognitionSilenceTimer);
    this.recognitionSilenceTimer = null;
  }

  private finishRecognition(session: DictationSession): void {
    if (!this.isCurrentSession(session)) return;
    const hasUnconfirmedTail =
      session.userStopped && (session.lostInterim || !!this.interimTranscript().trim());
    const recognition = this.recognition;
    this.dictation = null;
    ++this.recognitionVersion;
    this.clearRecognitionTimers();
    if (recognition) {
      this.releaseRecognition(recognition);
      this.abortRecognition(recognition);
    }
    this.listening.set(false);
    this.interimTranscript.set('');
    this.status.set(
      session.stopping && !session.userStopped
        ? 'The two-minute listening limit was reached. Your text is kept; review it or click Mic to continue.'
        : session.receivedText
          ? 'Voice typing finished. Review your message, then send.'
          : 'No speech was captured. Try again, or type your message.',
    );
    if (hasUnconfirmedTail) {
      this.error.set(
        'The browser could not confirm the last spoken words. Your confirmed text is kept; review your draft before sending.',
      );
    } else if (session.userStopped && (!session.automaticStop || session.receivedText))
      session.onFinished?.();
  }

  private clearRecognitionTimers(): void {
    this.clearRecognitionSilenceTimer();
    if (this.recognitionRestartTimer !== null) clearTimeout(this.recognitionRestartTimer);
    if (this.recognitionSessionTimer !== null) clearTimeout(this.recognitionSessionTimer);
    if (this.recognitionStopTimer !== null) clearTimeout(this.recognitionStopTimer);
    this.recognitionRestartTimer = null;
    this.recognitionSessionTimer = null;
    this.recognitionStopTimer = null;
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
    recognition.onspeechstart = null;
    recognition.onspeechend = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    if (this.recognition === recognition) this.recognition = null;
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
    const selected = this.selectedSpeechVoice();
    if (selected !== 'auto')
      return this.availableVoices().find((voice) => this.voiceKey(voice) === selected);
    return (
      this.matchingVoice(language) ??
      (language === 'mr-IN' ? this.matchingVoice('hi-IN') : undefined)
    );
  }

  private matchingVoice(language: VoiceLanguage): SpeechSynthesisVoice | undefined {
    return (
      this.availableVoices().find(
        (voice) => voice.lang.toLowerCase().replace('_', '-') === language.toLowerCase(),
      ) ??
      this.availableVoices().find((voice) => this.voiceLanguage(voice) === language.split('-')[0])
    );
  }

  private voiceKey(voice: SpeechSynthesisVoice): string {
    return voice.voiceURI || `${voice.name}:${voice.lang}`;
  }

  private voiceLanguage(voice: SpeechSynthesisVoice): string {
    return voice.lang.toLowerCase().replace('_', '-').split('-')[0];
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
        this.selectedSpeechVoice() !== 'auto'
          ? 'The selected speech voice is unavailable. Choose another available voice or Auto, then try Test voice.'
          : this.availableVoices().length
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
    // The chosen engine's actual locale matters when a Hindi voice reads Marathi
    // or the user explicitly selects a different installed voice.
    utterance.lang = voice.lang;
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
          : pending.language === 'mr-IN' && this.voiceLanguage(voice) === 'hi'
            ? `Reading with Hindi voice (${voice.lang}); Marathi pronunciation may differ.`
            : `Reading with ${voice.name} (${voice.lang}).`,
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
