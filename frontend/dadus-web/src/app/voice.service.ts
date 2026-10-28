import { DestroyRef, Injectable, inject, signal } from '@angular/core';

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
  readonly readReplies = signal(false);
  readonly status = signal('');
  readonly error = signal('');

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.stopAll();
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
    const language = this.language();
    const label = this.languages.find((item) => item.value === language)?.label ?? language;
    const voices = this.synthesis.getVoices();
    const voice =
      voices.find((item) => item.lang.toLowerCase() === language.toLowerCase()) ??
      voices.find((item) => item.lang.toLowerCase().split('-')[0] === language.split('-')[0]);
    if (!voice) {
      this.error.set(
        voices.length
          ? `No ${label} speech voice is available in this browser. Install a ${label} voice in Windows, or choose another voice language.`
          : 'Browser speech voices are still loading or unavailable. Try Read reply again, or check Windows speech voice settings.',
      );
      return;
    }

    const version = ++this.speechVersion;
    const utterance = new SpeechSynthesisUtterance(text.trim());
    utterance.lang = language;
    utterance.voice = voice;
    this.utterance = utterance;
    const current = () =>
      !this.destroyed && this.utterance === utterance && this.speechVersion === version;
    utterance.onstart = () => {
      if (current()) this.speaking.set(true);
    };
    utterance.onend = () => {
      if (!current()) return;
      this.releaseUtterance();
      this.status.set('Finished reading the reply.');
    };
    utterance.onerror = () => {
      if (!current()) return;
      this.releaseUtterance();
      this.status.set('');
      this.error.set(
        'The browser could not read this reply. Check your speech voice and audio settings.',
      );
    };
    this.speaking.set(true);
    this.status.set(
      voice.lang.toLowerCase() === language.toLowerCase()
        ? 'Reading the reply…'
        : `Reading with a ${label} voice (${voice.lang}).`,
    );
    try {
      this.synthesis.speak(utterance);
    } catch {
      this.releaseUtterance();
      this.status.set('');
      this.error.set(
        'The browser could not start speech. Check your audio settings and try again.',
      );
    }
  }

  stopSpeaking(): void {
    ++this.speechVersion;
    if (this.utterance) {
      this.releaseUtterance();
      this.synthesis.cancel();
    }
    this.speaking.set(false);
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
    if (this.utterance) {
      this.utterance.onstart = null;
      this.utterance.onend = null;
      this.utterance.onerror = null;
    }
    this.utterance = null;
    this.speaking.set(false);
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
