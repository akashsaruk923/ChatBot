import { Observable, Subscription, take } from 'rxjs';

export type SpeechLanguage = 'mr-IN' | 'hi-IN' | 'en-IN';

export interface SpeechConfiguration {
  provider: 'browser' | 'azure';
  configured: boolean;
  languages: SpeechLanguage[];
  maxTextLength: number;
}

export type SpeechTransport = (text: string, language: SpeechLanguage) => Observable<Blob>;

interface PlaybackState {
  preparing: boolean;
  speaking: boolean;
  status: string;
  error?: string;
}

/** A single cancellable online read. Audio and object URLs never enter chat storage. */
export class OnlineSpeechPlayer {
  private version = 0;
  private request: Subscription | null = null;
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly state: (value: PlaybackState) => void) {}

  static get supported(): boolean {
    return (
      typeof globalThis.Audio === 'function' &&
      typeof globalThis.URL?.createObjectURL === 'function' &&
      typeof globalThis.URL?.revokeObjectURL === 'function'
    );
  }

  play(text: string, language: SpeechLanguage, transport: SpeechTransport, limit: number): void {
    this.cancel();
    let chunks: string[];
    try {
      chunks = splitOnlineSpeech(text, limit);
    } catch {
      this.fail(
        'This text cannot be split safely for speech. Try a shorter reply or update your browser.',
      );
      return;
    }
    if (chunks.length) this.playChunk(chunks, 0, language, transport, this.version);
  }

  cancel(): void {
    ++this.version;
    this.clearTimer();
    this.request?.unsubscribe();
    this.request = null;
    this.releaseAudio();
    this.state({ preparing: false, speaking: false, status: '' });
  }

  private playChunk(
    chunks: readonly string[],
    index: number,
    language: SpeechLanguage,
    transport: SpeechTransport,
    version: number,
  ): void {
    if (version !== this.version) return;
    this.state({ preparing: true, speaking: false, status: 'Preparing online voice…' });
    this.timer = setTimeout(() => {
      if (version === this.version)
        this.fail('Online voice timed out. Check the backend connection and try Test voice again.');
    }, 50000);
    let received = false;
    try {
      this.request = transport(chunks[index], language)
        .pipe(take(1))
        .subscribe({
          next: (blob) => {
            if (version !== this.version) return;
            received = true;
            this.clearTimer();
            if (
              !(blob instanceof Blob) ||
              blob.size <= 44 ||
              blob.size > 4 * 1024 * 1024 ||
              !['audio/wav', 'audio/x-wav'].includes(blob.type.toLowerCase())
            ) {
              this.fail('Online voice returned unusable audio. Try Test voice again.');
              return;
            }
            this.playAudio(blob, chunks, index, language, transport, version);
          },
          error: (failure: unknown) => {
            if (version !== this.version) return;
            this.clearTimer();
            // ProblemDetails arrive as a Blob because this request expects audio.
            void this.explainFailure(failure).then((message) => {
              if (version === this.version) this.fail(message);
            });
          },
          complete: () => {
            if (!received && version === this.version)
              this.fail('Online voice returned no audio. Try Test voice again.');
          },
        });
    } catch {
      this.fail('Online voice could not start. Reconnect to the API and try Test voice again.');
    }
  }

  private playAudio(
    blob: Blob,
    chunks: readonly string[],
    index: number,
    language: SpeechLanguage,
    transport: SpeechTransport,
    version: number,
  ): void {
    try {
      this.objectUrl = URL.createObjectURL(blob);
      const audio = new Audio(this.objectUrl);
      this.audio = audio;
      const current = () => version === this.version && this.audio === audio;
      audio.onplaying = () => {
        if (!current()) return;
        this.clearTimer();
        this.state({ preparing: false, speaking: true, status: 'Reading with online voice…' });
      };
      audio.onended = () => {
        if (!current()) return;
        this.clearTimer();
        this.releaseAudio();
        if (index + 1 < chunks.length)
          this.playChunk(chunks, index + 1, language, transport, version);
        else
          this.state({ preparing: false, speaking: false, status: 'Finished reading the reply.' });
      };
      audio.onerror = () => {
        if (current())
          this.fail(
            'The browser could not play online audio. Check sound settings and try Test voice.',
          );
      };
      this.timer = setTimeout(() => {
        if (current())
          this.fail(
            'Audio did not start. Click Test voice directly, unmute this tab, and check Windows speaker output.',
          );
      }, 8000);
      const started = audio.play();
      void started?.catch((error: unknown) => {
        if (!current()) return;
        const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
        this.fail(
          name === 'NotAllowedError'
            ? 'Your browser blocked audio. Click Test voice or Read aloud directly and allow sound for this site.'
            : 'The browser could not play online audio. Check sound settings and try Test voice.',
        );
      });
    } catch {
      if (version === this.version)
        this.fail(
          'The browser could not prepare online audio. Update your browser and try Test voice.',
        );
    }
  }

  private async explainFailure(failure: unknown): Promise<string> {
    if (!failure || typeof failure !== 'object')
      return 'Online voice is unavailable. Try again shortly.';
    const response = failure as { status?: unknown; error?: unknown };
    let body = response.error;
    if (body instanceof Blob) {
      if (body.size > 16384) body = undefined;
      else {
        try {
          body = JSON.parse(await body.text());
        } catch {
          body = undefined;
        }
      }
    }
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const problem = body as Record<string, unknown>;
      if (problem['status'] === response.status) {
        switch (problem['code']) {
          case 'speech_not_configured':
            return 'Online voice needs an Azure Speech key and region in the backend. Complete speech setup, restart the API, then reconnect.';
          case 'speech_authentication_failed':
            return 'Azure Speech rejected its backend credentials. Check the Speech resource key and matching region, then restart the API.';
          case 'speech_rate_limited':
            return 'Speech quota or request limit was reached. Wait before retrying and check the Azure F0 allowance.';
          case 'speech_timeout':
            return 'Online voice timed out. Check the backend connection and try Test voice again.';
          case 'invalid_speech_audio':
            return 'Online voice returned unusable audio. Try Test voice again.';
          case 'invalid_speech_text':
          case 'invalid_speech_language':
            return 'This text or language could not be read. Reconnect and try a shorter reply.';
          case 'invalid_session':
            return 'The speech session is invalid. Refresh this page and try Test voice again.';
          case 'speech_provider_unavailable':
            return 'Azure Speech is unavailable. Check the backend internet connection and try again shortly.';
        }
      }
    }
    if (response.status === 0)
      return 'Cannot reach the speech API. Start the backend and reconnect.';
    if (response.status === 429)
      return 'Too many speech requests. Wait a minute before trying again.';
    return 'Online voice is unavailable. Check the backend speech setup and try again shortly.';
  }

  private fail(message: string): void {
    this.cancel();
    this.state({ preparing: false, speaking: false, status: '', error: message });
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private releaseAudio(): void {
    if (this.audio) {
      const audio = this.audio;
      this.audio = null;
      audio.onplaying = null;
      audio.onended = null;
      audio.onerror = null;
      try {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      } catch {
        /* Cleanup still revokes the URL when a media engine has closed. */
      }
    }
    if (this.objectUrl !== null) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}

export function splitOnlineSpeech(text: string, requestedLimit: number): string[] {
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(1000, Math.max(1, requestedLimit))
    : 1000;
  const graphemes = Array.from(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text.trim()),
    (item) => item.segment,
  );
  const chunks: string[] = [];
  let offset = 0;
  while (offset < graphemes.length) {
    let end = offset;
    let length = 0;
    let naturalBoundary = -1;
    while (end < graphemes.length && length + graphemes[end].length <= limit) {
      length += graphemes[end].length;
      if (length >= limit * 0.6 && /[\s.!?।]/u.test(graphemes[end])) naturalBoundary = end + 1;
      end++;
    }
    if (end === offset) throw new RangeError('A speech grapheme exceeds the request limit.');
    if (end < graphemes.length && naturalBoundary > offset) end = naturalBoundary;
    const chunk = graphemes.slice(offset, end).join('').trim();
    if (chunk) chunks.push(chunk);
    offset = end;
  }
  return chunks;
}
