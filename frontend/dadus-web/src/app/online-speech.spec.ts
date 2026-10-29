import { EMPTY, Observable, Subject, of, throwError } from 'rxjs';
import { OnlineSpeechPlayer, splitOnlineSpeech } from './online-speech';

class FakeAudio {
  static instances: FakeAudio[] = [];
  static playResult: () => Promise<void> = () => Promise.resolve();
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn(() => FakeAudio.playResult());
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn();
  constructor(readonly src: string) {
    FakeAudio.instances.push(this);
  }
}

describe('OnlineSpeechPlayer', () => {
  let player: OnlineSpeechPlayer;
  let state =
    vi.fn<
      (value: { preparing: boolean; speaking: boolean; status: string; error?: string }) => void
    >();
  let createUrl: ReturnType<typeof vi.fn>;
  let revokeUrl: ReturnType<typeof vi.fn>;
  const wav = () => new Blob([new Uint8Array(100)], { type: 'audio/wav' });
  const audio = () => FakeAudio.instances[FakeAudio.instances.length - 1];
  const latest = () => state.mock.calls[state.mock.calls.length - 1][0];

  beforeEach(() => {
    vi.useFakeTimers();
    FakeAudio.instances = [];
    FakeAudio.playResult = () => Promise.resolve();
    createUrl = vi.fn(() => `blob:audio-${FakeAudio.instances.length}`);
    revokeUrl = vi.fn();
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('URL', { createObjectURL: createUrl, revokeObjectURL: revokeUrl });
    state = vi.fn();
    player = new OnlineSpeechPlayer(state);
  });

  afterEach(() => {
    player.cancel();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not request speech or create audio until explicitly started', () => {
    expect(OnlineSpeechPlayer.supported).toBe(true);
    expect(state).not.toHaveBeenCalled();
    expect(createUrl).not.toHaveBeenCalled();
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it.each(['mr-IN', 'hi-IN', 'en-IN'] as const)(
    'requests and plays the chosen %s voice',
    (language) => {
      const transport = vi.fn(() => of(wav()));
      player.play('नमस्कार!', language, transport, 1000);
      expect(transport).toHaveBeenCalledExactlyOnceWith('नमस्कार!', language);
      expect(latest().preparing).toBe(true);
      expect(latest().speaking).toBe(false);
      audio().onplaying?.();
      expect(latest().speaking).toBe(true);
      expect(latest().preparing).toBe(false);
      audio().onended?.();
      expect(latest().status).toContain('Finished');
      expect(revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:audio-0');
      expect(audio().pause).toHaveBeenCalled();
    },
  );

  it('fetches one bounded grapheme-safe chunk at a time, only after earlier audio ends', () => {
    const transport = vi.fn(() => of(wav()));
    const text = 'माझ्याशी गप्पा मार. '.repeat(150);
    const expected = splitOnlineSpeech(text, 1000);
    expect(expected.length).toBeGreaterThan(1);
    player.play(text, 'mr-IN', transport, 1000);
    expect(transport).toHaveBeenCalledTimes(1);
    expected.forEach((chunk, index) => {
      expect(transport).toHaveBeenLastCalledWith(chunk, 'mr-IN');
      expect(chunk.length).toBeLessThanOrEqual(1000);
      audio().onplaying?.();
      audio().onended?.();
      expect(transport).toHaveBeenCalledTimes(Math.min(index + 2, expected.length));
    });
    expect(revokeUrl).toHaveBeenCalledTimes(expected.length);
    expect(latest().status).toContain('Finished');
  });

  it('cancels a pending HTTP request without requesting the remaining text', () => {
    const disposed = vi.fn();
    const transport = vi.fn(() => new Observable<Blob>(() => disposed));
    player.play('hello '.repeat(500), 'en-IN', transport, 1000);
    player.cancel();
    vi.advanceTimersByTime(60000);
    expect(disposed).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
    expect(FakeAudio.instances).toHaveLength(0);
    expect(latest()).toEqual({ preparing: false, speaking: false, status: '' });
  });

  it('stops audio, revokes its URL and ignores retained callbacks after cancellation', () => {
    const transport = vi.fn(() => of(wav()));
    player.play('hello '.repeat(500), 'en-IN', transport, 1000);
    const old = audio();
    const ended = old.onended;
    const playing = old.onplaying;
    player.cancel();
    ended?.();
    playing?.();
    expect(transport).toHaveBeenCalledOnce();
    expect(revokeUrl).toHaveBeenCalledOnce();
    expect(old.pause).toHaveBeenCalledOnce();
    expect(old.removeAttribute).toHaveBeenCalledWith('src');
    expect(old.load).toHaveBeenCalledOnce();
    expect(old.onplaying).toBeNull();
    expect(latest().speaking).toBe(false);
  });

  it('replaces an active read and ignores a late failure from its play promise', async () => {
    let rejectOld!: (reason: unknown) => void;
    FakeAudio.playResult = () =>
      new Promise<void>((_, reject) => {
        rejectOld = reject;
      });
    player.play('first', 'en-IN', () => of(wav()), 1000);
    const old = audio();
    FakeAudio.playResult = () => Promise.resolve();
    player.play('second', 'hi-IN', () => of(wav()), 1000);
    audio().onplaying?.();
    rejectOld(new Error('private audio error'));
    await Promise.resolve();
    expect(old.pause).toHaveBeenCalledOnce();
    expect(latest().speaking).toBe(true);
    expect(latest().error).toBeUndefined();
  });

  it('times out a pending request and aborts its subscription', () => {
    const disposed = vi.fn();
    player.play('hello', 'en-IN', () => new Observable<Blob>(() => disposed), 1000);
    vi.advanceTimersByTime(50000);
    expect(disposed).toHaveBeenCalledOnce();
    expect(latest().error).toContain('timed out');
    expect(latest().preparing).toBe(false);
  });

  it('times out audio that never reports playback start and releases it', () => {
    player.play('hello', 'en-IN', () => of(wav()), 1000);
    vi.advanceTimersByTime(8000);
    expect(latest().error).toContain('Audio did not start');
    expect(revokeUrl).toHaveBeenCalledOnce();
    expect(audio().pause).toHaveBeenCalledOnce();
  });

  it('stops the startup timeout once playback really starts', () => {
    player.play('hello', 'en-IN', () => of(wav()), 1000);
    audio().onplaying?.();
    vi.advanceTimersByTime(10000);
    expect(latest().speaking).toBe(true);
    expect(latest().error).toBeUndefined();
  });

  it('explains browser autoplay rejection and releases audio', async () => {
    FakeAudio.playResult = () => Promise.reject({ name: 'NotAllowedError', message: 'PRIVATE' });
    player.play('hello', 'en-IN', () => of(wav()), 1000);
    await Promise.resolve();
    expect(latest().error).toContain('Click Test voice');
    expect(latest().error).not.toContain('PRIVATE');
    expect(revokeUrl).toHaveBeenCalledOnce();
  });

  it('releases audio when the media engine reports an error', () => {
    player.play('hello', 'en-IN', () => of(wav()), 1000);
    audio().onerror?.();
    expect(latest().error).toContain('could not play');
    expect(revokeUrl).toHaveBeenCalledOnce();
  });

  it.each([
    () => new Blob([], { type: 'audio/wav' }),
    () => new Blob([new Uint8Array(100)], { type: 'text/html' }),
    () => new Blob([new Uint8Array(4 * 1024 * 1024 + 1)], { type: 'audio/wav' }),
  ])('rejects empty, wrong-format or oversized audio before making a URL', (invalid) => {
    player.play('hello', 'en-IN', () => of(invalid()), 1000);
    expect(latest().error).toContain('unusable audio');
    expect(createUrl).not.toHaveBeenCalled();
  });

  it('reports a response that completes without audio', () => {
    player.play('hello', 'en-IN', () => EMPTY, 1000);
    expect(latest().error).toContain('no audio');
    expect(latest().preparing).toBe(false);
  });

  it.each([
    ['speech_not_configured', 503, 'Azure Speech key and region'],
    ['speech_authentication_failed', 502, 'matching region'],
    ['speech_rate_limited', 429, 'Azure F0 allowance'],
    ['speech_timeout', 504, 'timed out'],
    ['speech_provider_unavailable', 502, 'internet connection'],
    ['invalid_speech_audio', 502, 'unusable audio'],
  ])('maps %s to fixed recovery text without provider details', async (code, status, expected) => {
    const problem = new Blob(['ignored'], { type: 'application/problem+json' });
    Object.defineProperty(problem, 'text', {
      value: async () => JSON.stringify({ status, code, detail: 'PRIVATE_KEY_VALUE' }),
    });
    player.play('hello', 'en-IN', () => throwError(() => ({ status, error: problem })), 1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(latest().error).toContain(expected);
    expect(latest().error).not.toContain('PRIVATE');
    expect(createUrl).not.toHaveBeenCalled();
  });

  it('does not reflect arbitrary error fields or trust a mismatched problem status', async () => {
    player.play(
      'hello',
      'en-IN',
      () =>
        throwError(() => ({
          status: 502,
          error: { status: 503, code: 'speech_not_configured', detail: 'PRIVATE' },
        })),
      1000,
    );
    await Promise.resolve();
    expect(latest().error).toContain('unavailable');
    expect(latest().error).not.toContain('PRIVATE');
    expect(latest().error).not.toContain('Complete speech setup');
  });

  it('ignores an error parsed after the user has cancelled', async () => {
    let resolveBody!: (body: string) => void;
    const problem = new Blob(['ignored']);
    Object.defineProperty(problem, 'text', {
      value: () =>
        new Promise<string>((resolve) => {
          resolveBody = resolve;
        }),
    });
    player.play('hello', 'en-IN', () => throwError(() => ({ status: 503, error: problem })), 1000);
    player.cancel();
    resolveBody(JSON.stringify({ status: 503, code: 'speech_not_configured' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(latest()).toEqual({ preparing: false, speaking: false, status: '' });
  });

  it('releases a URL if constructing the audio engine fails', () => {
    vi.stubGlobal(
      'Audio',
      class {
        constructor() {
          throw new Error('PRIVATE');
        }
      },
    );
    player.play('hello', 'en-IN', () => of(wav()), 1000);
    expect(revokeUrl).toHaveBeenCalledOnce();
    expect(latest().error).toContain('could not prepare');
    expect(latest().error).not.toContain('PRIVATE');
  });
});

describe('online speech chunk boundaries', () => {
  it('preserves emoji and Indic combining graphemes within the UTF-16 limit', () => {
    const text = 'क्षि👩🏽‍💻'.repeat(400);
    const chunks = splitOnlineSpeech(text, 1000);
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1000);
    expect(
      chunks.flatMap((chunk) => Array.from(segmenter.segment(chunk), (part) => part.segment)),
    ).toEqual(Array.from(segmenter.segment(text), (part) => part.segment));
  });

  it('caps an advertised request limit at the server bound', () => {
    expect(splitOnlineSpeech('x'.repeat(2001), 4000).map((chunk) => chunk.length)).toEqual([
      1000, 1000, 1,
    ]);
  });

  it('rejects an indivisible oversized grapheme instead of dropping text', () => {
    expect(() => splitOnlineSpeech('a' + '\u0301'.repeat(1000), 1000)).toThrow(RangeError);
  });
});
