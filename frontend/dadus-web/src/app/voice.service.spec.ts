import { TestBed } from '@angular/core/testing';
import { VoiceService } from './voice.service';

interface FakeResultEvent {
  resultIndex: number;
  results: Array<{ isFinal: boolean; length: number; 0: { transcript: string } }>;
}

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = '';
  continuous = true;
  interimResults = true;
  onstart: (() => void) | null = null;
  onspeechstart: (() => void) | null = null;
  onspeechend: (() => void) | null = null;
  onresult: ((event: FakeResultEvent) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();

  constructor() {
    FakeRecognition.instances.push(this);
  }

  result(text: string, final = true): void {
    this.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: final, length: 1, 0: { transcript: text } }],
    });
  }
}

class FakeUtterance {
  lang = '';
  voice: SpeechSynthesisVoice | null = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event?: { error: string }) => void) | null = null;

  constructor(readonly text: string) {}
}

function voice(lang: string): SpeechSynthesisVoice {
  return { lang, name: lang, voiceURI: lang, localService: true, default: false };
}

describe('VoiceService', () => {
  let voices: SpeechSynthesisVoice[];
  let voiceEvents: EventTarget;
  let synthesizer: {
    getVoices: ReturnType<typeof vi.fn>;
    speak: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    paused: boolean;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    FakeRecognition.instances = [];
    voices = [voice('en-US'), voice('mr-IN'), voice('hi-IN'), voice('en-IN')];
    voiceEvents = new EventTarget();
    synthesizer = {
      getVoices: vi.fn(() => voices),
      speak: vi.fn(),
      cancel: vi.fn(),
      resume: vi.fn(),
      paused: false,
      addEventListener: vi.fn(voiceEvents.addEventListener.bind(voiceEvents)),
      removeEventListener: vi.fn(voiceEvents.removeEventListener.bind(voiceEvents)),
    };
    vi.stubGlobal('SpeechRecognition', FakeRecognition);
    vi.stubGlobal('webkitSpeechRecognition', undefined);
    vi.stubGlobal('speechSynthesis', synthesizer);
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    TestBed.configureTestingModule({});
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function service(): VoiceService {
    return TestBed.inject(VoiceService);
  }

  function recognition(): FakeRecognition {
    return FakeRecognition.instances[FakeRecognition.instances.length - 1];
  }

  function spoken(): FakeUtterance {
    return synthesizer.speak.mock.calls[synthesizer.speak.mock.calls.length - 1][0];
  }

  it('does not request microphone access or read replies before user action', () => {
    const api = service();
    expect(api.language()).toBe('mr-IN');
    expect(api.readReplies()).toBe(false);
    expect(FakeRecognition.instances).toHaveLength(0);
    api.readReply('नमस्कार');
    expect(synthesizer.speak).not.toHaveBeenCalled();
  });

  it('supports prefixed recognition and uses the selected language', () => {
    vi.stubGlobal('SpeechRecognition', undefined);
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    const api = service();
    api.setLanguage('hi-IN');
    api.startListening(vi.fn());
    expect(api.recognitionSupported).toBe(true);
    expect(recognition().lang).toBe('hi-IN');
    expect(recognition().continuous).toBe(true);
    expect(recognition().interimResults).toBe(true);
    expect(recognition().start).toHaveBeenCalledOnce();
  });

  it('reports unsupported voice typing without interrupting text chat', () => {
    vi.stubGlobal('SpeechRecognition', undefined);
    const api = service();
    api.startListening(vi.fn());
    expect(api.recognitionSupported).toBe(false);
    expect(api.listening()).toBe(false);
    expect(api.error()).toContain('type your message');
  });

  it('delivers final text once and ignores interim and duplicate results', () => {
    const received = vi.fn();
    const api = service();
    api.startListening(received);
    recognition().result('नम', false);
    expect(received).not.toHaveBeenCalled();
    expect(api.interimTranscript()).toBe('नम');
    recognition().result('  नमस्कार मित्रा  ');
    recognition().result('नमस्कार मित्रा');
    expect(received).toHaveBeenCalledExactlyOnceWith('नमस्कार मित्रा');
    expect(api.interimTranscript()).toBe('');
  });

  it('allows the browser final transcript after stopping the microphone', () => {
    const api = service();
    const received = vi.fn();
    api.startListening(received);
    api.stopListening();
    expect(recognition().stop).toHaveBeenCalledOnce();
    recognition().result('कसा आहेस');
    recognition().onend?.();
    expect(received).toHaveBeenCalledExactlyOnceWith('कसा आहेस');
    expect(api.listening()).toBe(false);
    expect(api.status()).toContain('Review');
  });

  it('ends an automatic turn after a quiet pause and delivers the final words before completion', () => {
    const api = service();
    const received = vi.fn();
    const finished = vi.fn();
    api.startListening(received, finished, { autoFinishAfterSilenceMs: 1800 });
    const active = recognition();
    const oldEnd = active.onend;
    active.result('माझ्याशी बोल');
    vi.advanceTimersByTime(1799);
    expect(active.stop).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(active.stop).toHaveBeenCalledOnce();
    oldEnd?.();
    oldEnd?.();
    vi.advanceTimersByTime(5000);
    expect(received).toHaveBeenCalledExactlyOnceWith('माझ्याशी बोल');
    expect(finished).toHaveBeenCalledOnce();
    expect(received.mock.invocationCallOrder[0]).toBeLessThan(finished.mock.invocationCallOrder[0]);
    expect(api.listening()).toBe(false);
    expect(FakeRecognition.instances).toHaveLength(1);
  });

  it('resets the quiet pause while tentative words and final results continue arriving', () => {
    const api = service();
    const finished = vi.fn();
    api.startListening(vi.fn(), finished, { autoFinishAfterSilenceMs: 1800 });
    const active = recognition();
    active.result('पहिले', false);
    vi.advanceTimersByTime(1200);
    active.result('पहिले वाक्य अजून बोलतोय', false);
    vi.advanceTimersByTime(1200);
    expect(active.stop).not.toHaveBeenCalled();
    active.result('पहिले वाक्य पूर्ण झाले');
    vi.advanceTimersByTime(1799);
    expect(active.stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(active.stop).toHaveBeenCalledOnce();
    active.onend?.();
    expect(finished).toHaveBeenCalledOnce();
  });

  it('completes a confirmed automatic turn even when continuous Chrome never emits speechend', () => {
    const api = service();
    const finished = vi.fn();
    api.startListening(vi.fn(), finished, { autoFinishAfterSilenceMs: 1800 });
    const active = recognition();
    active.onspeechstart?.();
    active.result('A complete question.');
    vi.advanceTimersByTime(1800);
    expect(active.stop).toHaveBeenCalledOnce();
    active.onend?.();
    expect(finished).toHaveBeenCalledOnce();
    expect(api.listening()).toBe(false);
  });

  it('extends tentative active speech and uses a bounded idle fallback if speechend is missing', () => {
    const api = service();
    const received = vi.fn();
    const finished = vi.fn();
    api.startListening(received, finished, { autoFinishAfterSilenceMs: 1800 });
    const active = recognition();
    active.onspeechstart?.();
    active.result('अजून', false);
    vi.advanceTimersByTime(4000);
    expect(active.stop).not.toHaveBeenCalled();
    active.result('अजून बोलतोय', false);
    vi.advanceTimersByTime(4999);
    expect(active.stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(active.stop).toHaveBeenCalledOnce();
    // stop() can make the recognizer finalize words that were tentative.
    active.result('अजून बोलतोय आणि आता पूर्ण झाले');
    active.onend?.();
    expect(received).toHaveBeenCalledExactlyOnceWith('अजून बोलतोय आणि आता पूर्ण झाले');
    expect(finished).toHaveBeenCalledOnce();
  });

  it('cancels a pending quiet endpoint when new speech starts and rearms after speechend', () => {
    const api = service();
    api.startListening(vi.fn(), vi.fn(), { autoFinishAfterSilenceMs: 1800 });
    const active = recognition();
    active.result('First part.');
    vi.advanceTimersByTime(1000);
    active.onspeechstart?.();
    vi.advanceTimersByTime(2000);
    expect(active.stop).not.toHaveBeenCalled();
    active.onspeechend?.();
    vi.advanceTimersByTime(1800);
    expect(active.stop).toHaveBeenCalledOnce();
  });

  it('does not finish an automatic turn before any new speech has been captured', () => {
    const api = service();
    const finished = vi.fn();
    api.startListening(vi.fn(), finished, { autoFinishAfterSilenceMs: 1800 });
    const active = recognition();
    active.onspeechstart?.();
    active.onspeechend?.();
    vi.advanceTimersByTime(10000);
    expect(active.stop).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
    expect(api.listening()).toBe(true);
  });

  it.each(['timeout', 'end'])(
    'keeps tentative-only automatic speech for review on %s',
    (ending) => {
      const api = service();
      const received = vi.fn();
      const finished = vi.fn();
      api.startListening(received, finished, { autoFinishAfterSilenceMs: 1800 });
      const active = recognition();
      active.result('not finalized', false);
      vi.advanceTimersByTime(1800);
      expect(active.stop).toHaveBeenCalledOnce();
      if (ending === 'timeout') vi.advanceTimersByTime(1500);
      else active.onend?.();
      expect(received).not.toHaveBeenCalled();
      expect(finished).not.toHaveBeenCalled();
      expect(api.listening()).toBe(false);
      expect(api.error()).toContain('could not confirm the last spoken words');
    },
  );

  it('finishes a confirmed automatic question when the browser ends instead of reopening the mic', () => {
    const api = service();
    const finished = vi.fn();
    api.startListening(vi.fn(), finished, { autoFinishAfterSilenceMs: 1800 });
    const active = recognition();
    active.result('That is my question.');
    active.onend?.();
    vi.advanceTimersByTime(5000);
    expect(finished).toHaveBeenCalledOnce();
    expect(active.stop).not.toHaveBeenCalled();
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(api.listening()).toBe(false);
  });

  it('never submits a partial automatic question when the browser ends with tentative tail words', () => {
    const api = service();
    const finished = vi.fn();
    api.startListening(vi.fn(), finished, { autoFinishAfterSilenceMs: 1800 });
    recognition().onresult?.({
      resultIndex: 0,
      results: [
        { isFinal: true, length: 1, 0: { transcript: 'Confirmed beginning' } },
        { isFinal: false, length: 1, 0: { transcript: 'unconfirmed ending' } },
      ],
    });
    recognition().onend?.();
    vi.advanceTimersByTime(5000);
    expect(finished).not.toHaveBeenCalled();
    expect(api.error()).toContain('confirmed text is kept');
    expect(FakeRecognition.instances).toHaveLength(1);
  });

  it('does not add silence-based completion to ordinary manual dictation', () => {
    const api = service();
    const finished = vi.fn();
    api.startListening(vi.fn(), finished);
    const active = recognition();
    active.result('Review these words first.');
    active.onspeechend?.();
    vi.advanceTimersByTime(10000);
    expect(active.stop).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
    expect(api.listening()).toBe(true);
  });

  it('clears quiet timers and retained callbacks before a new recording starts', () => {
    const api = service();
    const finished = vi.fn();
    api.startListening(vi.fn(), finished, { autoFinishAfterSilenceMs: 1800 });
    const old = recognition();
    const oldSpeechEnd = old.onspeechend;
    old.result('Cancelled question');
    api.cancelListening();
    api.startListening(vi.fn(), finished, { autoFinishAfterSilenceMs: 1800 });
    oldSpeechEnd?.();
    vi.advanceTimersByTime(5000);
    expect(old.stop).not.toHaveBeenCalled();
    expect(recognition().stop).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
  });

  it('clears automatic quiet completion after fatal recognition errors', () => {
    const api = service();
    const finished = vi.fn();
    api.startListening(vi.fn(), finished, { autoFinishAfterSilenceMs: 1800 });
    const active = recognition();
    active.result('Words before the error');
    active.onerror?.({ error: 'network' });
    vi.advanceTimersByTime(5000);
    expect(active.stop).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
    expect(api.listening()).toBe(false);
  });

  it('allows a same-run final result to recover tentative words after no-speech', () => {
    const api = service();
    const received = vi.fn();
    const finished = vi.fn();
    api.startListening(received, finished, { autoFinishAfterSilenceMs: 1800 });
    const active = recognition();
    active.result('recoverable tentative words', false);
    active.onerror?.({ error: 'no-speech' });
    active.result('The complete recovered question.');
    vi.advanceTimersByTime(1800);
    expect(active.stop).toHaveBeenCalledOnce();
    active.onend?.();
    expect(received).toHaveBeenCalledExactlyOnceWith('The complete recovered question.');
    expect(finished).toHaveBeenCalledOnce();
    expect(api.error()).toBe('');
  });

  it.each(['language', 'destroy'])('clears pending automatic completion on %s', (action) => {
    const api = service();
    const finished = vi.fn();
    api.startListening(vi.fn(), finished, { autoFinishAfterSilenceMs: 1800 });
    const active = recognition();
    active.result('This recording is cancelled');
    if (action === 'language') api.setLanguage('hi-IN');
    else TestBed.resetTestingModule();
    vi.advanceTimersByTime(5000);
    expect(active.stop).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
    expect(api.listening()).toBe(false);
  });

  it('resets speech activity after an empty browser run before quiet-completing the next run', () => {
    const api = service();
    const finished = vi.fn();
    api.startListening(vi.fn(), finished, { autoFinishAfterSilenceMs: 1800 });
    recognition().onspeechstart?.();
    recognition().onend?.();
    vi.advanceTimersByTime(250);
    const next = recognition();
    next.result('Now I have a question.');
    vi.advanceTimersByTime(1800);
    expect(next.stop).toHaveBeenCalledOnce();
    next.onend?.();
    expect(finished).toHaveBeenCalledOnce();
    expect(FakeRecognition.instances).toHaveLength(2);
  });

  it('rejects callbacks from a cancelled microphone session after another session starts', () => {
    const api = service();
    const oldReceived = vi.fn();
    api.startListening(oldReceived);
    const oldRecognition = recognition();
    const lateResult = oldRecognition.onresult;
    const lateError = oldRecognition.onerror;
    const lateEnd = oldRecognition.onend;
    api.cancelListening();
    expect(oldRecognition.abort).toHaveBeenCalledOnce();
    const currentReceived = vi.fn();
    api.startListening(currentReceived);
    lateResult?.({
      resultIndex: 0,
      results: [{ isFinal: true, length: 1, 0: { transcript: 'old text' } }],
    });
    lateError?.({ error: 'not-allowed' });
    lateEnd?.();
    expect(oldReceived).not.toHaveBeenCalled();
    expect(api.listening()).toBe(true);
    expect(api.error()).toBe('');
    recognition().result('new text');
    expect(currentReceived).toHaveBeenCalledWith('new text');
  });

  it('continues after a browser pause and accepts fresh result indexes in the next run', () => {
    const api = service();
    const received = vi.fn();
    const finished = vi.fn();
    api.startListening(received, finished);
    const first = recognition();
    first.result('पहिले वाक्य');
    first.onend?.();
    expect(api.listening()).toBe(true);
    expect(finished).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(FakeRecognition.instances).toHaveLength(2);
    expect(recognition().lang).toBe('mr-IN');
    recognition().result('दुसरे वाक्य');
    expect(received.mock.calls).toEqual([['पहिले वाक्य'], ['दुसरे वाक्य']]);
    api.stopListening();
    recognition().result('दुसरे वाक्य');
    recognition().onend?.();
    expect(received).toHaveBeenCalledTimes(2);
    expect(finished).toHaveBeenCalledOnce();
    expect(api.listening()).toBe(false);
  });

  it('delivers stop-time final speech before finishing once and ignores old end events', () => {
    const api = service();
    const received = vi.fn();
    const finished = vi.fn();
    api.startListening(received, finished);
    const active = recognition();
    const oldEnd = active.onend;
    api.stopListening();
    active.result('माझे पूर्ण वाक्य');
    oldEnd?.();
    oldEnd?.();
    vi.advanceTimersByTime(5000);
    expect(received).toHaveBeenCalledExactlyOnceWith('माझे पूर्ण वाक्य');
    expect(finished).toHaveBeenCalledOnce();
    expect(received.mock.invocationCallOrder[0]).toBeLessThan(finished.mock.invocationCallOrder[0]);
    expect(FakeRecognition.instances).toHaveLength(1);
  });

  it('does not restore interim words when the final-text callback cancels capture', () => {
    const api = service();
    api.startListening(() => api.cancelListening());
    recognition().onresult?.({
      resultIndex: 0,
      results: [
        { isFinal: true, length: 1, 0: { transcript: 'confirmed' } },
        { isFinal: false, length: 1, 0: { transcript: 'stale preview' } },
      ],
    });
    expect(api.listening()).toBe(false);
    expect(api.interimTranscript()).toBe('');
  });

  it('can stop in the pause between browser runs without reopening the microphone', () => {
    const api = service();
    const finished = vi.fn();
    api.startListening(vi.fn(), finished);
    recognition().result('hello');
    recognition().onend?.();
    api.stopListening();
    expect(finished).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(api.listening()).toBe(false);
  });

  it('bounds the final-results wait and never sends an unconfirmed interim transcript', () => {
    const api = service();
    const received = vi.fn();
    const finished = vi.fn();
    api.startListening(received, finished);
    const active = recognition();
    const lateResult = active.onresult;
    active.result('unconfirmed words', false);
    api.stopListening();
    vi.advanceTimersByTime(1499);
    expect(finished).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(finished).not.toHaveBeenCalled();
    expect(active.abort).toHaveBeenCalledOnce();
    expect(api.interimTranscript()).toBe('');
    expect(api.error()).toContain('could not confirm the last spoken words');
    lateResult?.({
      resultIndex: 0,
      results: [{ isFinal: true, length: 1, 0: { transcript: 'late words' } }],
    });
    expect(received).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'end'])(
    'keeps earlier final words for review instead of auto-finishing with an unconfirmed tail on %s',
    (ending) => {
      const api = service();
      const received = vi.fn();
      const finished = vi.fn();
      api.startListening(received, finished);
      recognition().onresult?.({
        resultIndex: 0,
        results: [
          { isFinal: true, length: 1, 0: { transcript: 'confirmed beginning' } },
          { isFinal: false, length: 1, 0: { transcript: 'unfinished last words' } },
        ],
      });
      api.stopListening();
      if (ending === 'timeout') vi.advanceTimersByTime(1500);
      else recognition().onend?.();
      expect(received).toHaveBeenCalledExactlyOnceWith('confirmed beginning');
      expect(finished).not.toHaveBeenCalled();
      expect(api.listening()).toBe(false);
      expect(api.error()).toContain('confirmed text is kept');
      expect(api.interimTranscript()).toBe('');
    },
  );

  it('can finish on the bounded stop timeout when all received words are confirmed', () => {
    const api = service();
    const finished = vi.fn();
    api.startListening(vi.fn(), finished);
    recognition().result('fully confirmed speech');
    api.stopListening();
    vi.advanceTimersByTime(1500);
    expect(finished).toHaveBeenCalledOnce();
    expect(api.error()).toBe('');
    expect(api.listening()).toBe(false);
  });

  it('finishes normally when the pending tail becomes final before the browser ends', () => {
    const api = service();
    const received = vi.fn();
    const finished = vi.fn();
    api.startListening(received, finished);
    recognition().onresult?.({
      resultIndex: 0,
      results: [
        { isFinal: true, length: 1, 0: { transcript: 'first words' } },
        { isFinal: false, length: 1, 0: { transcript: 'last words' } },
      ],
    });
    api.stopListening();
    recognition().onresult?.({
      resultIndex: 1,
      results: [
        { isFinal: true, length: 1, 0: { transcript: 'first words' } },
        { isFinal: true, length: 1, 0: { transcript: 'last words' } },
      ],
    });
    recognition().onend?.();
    expect(received.mock.calls).toEqual([['first words'], ['last words']]);
    expect(finished).toHaveBeenCalledOnce();
    expect(api.error()).toBe('');
  });

  it.each(['pause', 'no-speech'])(
    'does not forget unconfirmed words across a %s restart when later words become final',
    (ending) => {
      const api = service();
      const received = vi.fn();
      const finished = vi.fn();
      api.startListening(received, finished);
      recognition().onresult?.({
        resultIndex: 0,
        results: [
          { isFinal: true, length: 1, 0: { transcript: 'confirmed beginning' } },
          { isFinal: false, length: 1, 0: { transcript: 'words that were not confirmed' } },
        ],
      });
      if (ending === 'no-speech') recognition().onerror?.({ error: 'no-speech' });
      recognition().onend?.();
      expect(api.listening()).toBe(true);
      vi.advanceTimersByTime(250);
      recognition().result('later confirmed words');
      expect(api.interimTranscript()).toBe('');
      api.stopListening();
      recognition().onend?.();
      expect(received.mock.calls).toEqual([['confirmed beginning'], ['later confirmed words']]);
      expect(finished).not.toHaveBeenCalled();
      expect(api.error()).toContain('could not confirm the last spoken words');
      expect(api.listening()).toBe(false);
    },
  );

  it('retries benign no-speech endings but stops after three empty runs without auto-finish', () => {
    const api = service();
    const finished = vi.fn();
    api.startListening(vi.fn(), finished);
    for (let index = 0; index < 3; index++) {
      recognition().onerror?.({ error: 'no-speech' });
      expect(api.error()).toBe('');
      recognition().onend?.();
      vi.advanceTimersByTime(250);
    }
    expect(FakeRecognition.instances).toHaveLength(3);
    expect(api.listening()).toBe(false);
    expect(api.error()).toContain('No speech was captured');
    expect(finished).not.toHaveBeenCalled();
  });

  it('stops a long session at two minutes and keeps confirmed speech for review', () => {
    const api = service();
    const received = vi.fn();
    const finished = vi.fn();
    api.startListening(received, finished);
    recognition().result('a long spoken message');
    vi.advanceTimersByTime(120000);
    expect(recognition().stop).toHaveBeenCalledOnce();
    recognition().onend?.();
    expect(api.listening()).toBe(false);
    expect(api.status()).toContain('two-minute');
    expect(received).toHaveBeenCalledExactlyOnceWith('a long spoken message');
    expect(finished).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'language', 'destroy'])(
    'clears a scheduled browser restart on %s and never calls the finish action',
    (action) => {
      const api = service();
      const finished = vi.fn();
      api.startListening(vi.fn(), finished);
      recognition().onend?.();
      if (action === 'cancel') api.cancelListening();
      if (action === 'language') api.setLanguage('hi-IN');
      if (action === 'destroy') TestBed.resetTestingModule();
      vi.advanceTimersByTime(125000);
      expect(FakeRecognition.instances).toHaveLength(1);
      expect(api.listening()).toBe(false);
      expect(finished).not.toHaveBeenCalled();
    },
  );

  it('does not run the finish action if permission fails while stop is draining finals', () => {
    const api = service();
    const finished = vi.fn();
    api.startListening(vi.fn(), finished);
    api.stopListening();
    recognition().onerror?.({ error: 'not-allowed' });
    vi.advanceTimersByTime(2000);
    expect(finished).not.toHaveBeenCalled();
    expect(api.listening()).toBe(false);
    expect(api.error()).toContain('site settings');
  });

  it.each([
    ['not-allowed', 'site settings'],
    ['audio-capture', 'microphone'],
    ['network', 'internet connection'],
    ['language-not-supported', 'another voice language'],
  ])('provides recovery guidance for recognition error %s', (code, expected) => {
    const api = service();
    api.startListening(vi.fn());
    recognition().onerror?.({ error: code });
    expect(api.listening()).toBe(false);
    expect(api.error()).toContain(expected);
    api.startListening(vi.fn());
    expect(api.error()).toBe('');
    expect(api.listening()).toBe(true);
  });

  it('recovers if the browser throws while starting microphone access', () => {
    class ThrowingRecognition extends FakeRecognition {
      override start = vi.fn(() => {
        throw new Error('browser failure');
      });
    }
    vi.stubGlobal('SpeechRecognition', ThrowingRecognition);
    const api = service();
    api.startListening(vi.fn());
    expect(api.listening()).toBe(false);
    expect(api.error()).toContain('permission');
  });

  it('prefers an exact voice language and reads automatic replies only after opt-in', () => {
    const api = service();
    api.setLanguage('en-IN');
    api.setReadReplies(true);
    api.readReply('Hello!');
    expect(spoken().text).toBe('Hello!');
    expect(spoken().voice?.lang).toBe('en-IN');
    expect(api.speaking()).toBe(false);
    expect(api.preparingSpeech()).toBe(true);
    spoken().onstart?.();
    expect(api.speaking()).toBe(true);
    spoken().onend?.();
    expect(api.speaking()).toBe(false);
  });

  it('allows an explicitly requested read without enabling automatic replies', () => {
    const api = service();
    api.speak('नमस्कार');
    expect(synthesizer.speak).toHaveBeenCalledOnce();
    expect(spoken().lang).toBe('mr-IN');
    expect(spoken().voice?.lang).toBe('mr-IN');
    expect(api.readReplies()).toBe(false);
  });

  it('can use a same-language voice from another locale and identifies that locale', () => {
    voices = [voice('en-US')];
    const api = service();
    api.setLanguage('en-IN');
    api.speak('Hello');
    expect(spoken().voice?.lang).toBe('en-US');
    spoken().onstart?.();
    expect(api.status()).toContain('en-US');
  });

  it('uses an available Hindi voice for Marathi with an explicit pronunciation notice', () => {
    voices = [voice('en-US'), voice('hi-IN')];
    const api = service();
    api.speak('नमस्कार');
    expect(spoken().voice?.lang).toBe('hi-IN');
    expect(spoken().lang).toBe('hi-IN');
    expect(spoken().text).toBe('नमस्कार');
    expect(api.voiceAvailability()).toContain('Using Hindi voice');
    expect(api.voiceAvailability()).toContain('pronunciation may differ');
    spoken().onstart?.();
    expect(api.status()).toContain('Hindi voice');
    expect(api.language()).toBe('mr-IN');
  });

  it('does not silently substitute English for Marathi when no Indic voice exists', () => {
    voices = [voice('en-US')];
    const api = service();
    api.speak('नमस्कार');
    expect(synthesizer.speak).not.toHaveBeenCalled();
    expect(api.error()).toContain('No Marathi speech voice');
  });

  it('lets the user choose an installed speech voice without changing AI or mic language', () => {
    const api = service();
    expect(api.speechVoices()).toContainEqual({ value: 'en-US', label: 'en-US (en-US)' });
    api.setSpeechVoice('en-US');
    expect(api.selectedSpeechVoice()).toBe('en-US');
    expect(api.language()).toBe('mr-IN');
    expect(api.voiceAvailability()).toContain('Selected speech voice: en-US');
    api.speak('नमस्कार');
    expect(spoken().lang).toBe('en-US');
    expect(spoken().voice?.lang).toBe('en-US');
    api.setSpeechVoice('unknown');
    expect(api.selectedSpeechVoice()).toBe('en-US');
    api.setSpeechVoice('auto');
    expect(api.selectedSpeechVoice()).toBe('auto');
    api.speak('नमस्कार');
    expect(spoken().lang).toBe('mr-IN');
  });

  it('waits for delayed browser voices and starts the current explicit read once loaded', () => {
    voices = [];
    const api = service();
    api.speak('नमस्कार');
    expect(api.error()).toBe('');
    expect(api.preparingSpeech()).toBe(true);
    expect(api.checkingVoice()).toBe(true);
    expect(api.voiceAvailability()).toContain('Loading');
    expect(synthesizer.speak).not.toHaveBeenCalled();
    voices = [voice('mr-IN')];
    voiceEvents.dispatchEvent(new Event('voiceschanged'));
    expect(synthesizer.speak).toHaveBeenCalledOnce();
    expect(spoken().text).toBe('नमस्कार');
    expect(api.checkingVoice()).toBe(false);
    expect(api.voiceAvailability()).toContain('mr-IN');
    spoken().onstart?.();
    expect(api.speaking()).toBe(true);
  });

  it('turns off automatic reading and cancels playback without accepting late events', () => {
    const api = service();
    api.setReadReplies(true);
    api.readReply('नमस्कार');
    const oldEnd = spoken().onend;
    const oldError = spoken().onerror;
    api.setReadReplies(false);
    expect(synthesizer.cancel).toHaveBeenCalledOnce();
    oldEnd?.();
    oldError?.();
    api.readReply('पुन्हा नमस्कार');
    expect(synthesizer.speak).toHaveBeenCalledOnce();
    expect(api.speaking()).toBe(false);
    expect(api.error()).toBe('');
    expect(api.status()).toBe('');
  });

  it('stops speaker playback before opening the microphone', () => {
    const api = service();
    api.speak('नमस्कार');
    api.startListening(vi.fn());
    expect(synthesizer.cancel).toHaveBeenCalledOnce();
    expect(api.speaking()).toBe(false);
    expect(api.listening()).toBe(true);
  });

  it('discards pending microphone input before reading a reply', () => {
    const api = service();
    const received = vi.fn();
    api.startListening(received);
    const oldRecognition = recognition();
    const lateResult = oldRecognition.onresult;
    api.speak('नमस्कार');
    lateResult?.({
      resultIndex: 0,
      results: [{ isFinal: true, length: 1, 0: { transcript: 'speaker echo' } }],
    });
    expect(oldRecognition.abort).toHaveBeenCalledOnce();
    expect(received).not.toHaveBeenCalled();
    expect(api.listening()).toBe(false);
  });

  it('cancels capture and speech when the language changes and ignores invalid languages', () => {
    const api = service();
    api.startListening(vi.fn());
    api.setLanguage('hi-IN');
    expect(recognition().abort).toHaveBeenCalledOnce();
    expect(api.language()).toBe('hi-IN');
    api.speak('नमस्ते');
    api.setLanguage('en-IN');
    expect(synthesizer.cancel).toHaveBeenCalledOnce();
    expect(api.speaking()).toBe(false);
    api.setLanguage('invalid');
    expect(api.language()).toBe('en-IN');
  });

  it('reports playback failures and lets the next explicit read recover', () => {
    const api = service();
    api.speak('नमस्कार');
    spoken().onerror?.();
    expect(api.speaking()).toBe(false);
    expect(api.error()).toContain('audio settings');
    api.speak('नमस्कार');
    expect(api.error()).toBe('');
    spoken().onstart?.();
    expect(api.speaking()).toBe(true);
  });

  it('does not enable automatic reading when speech synthesis is unavailable', () => {
    vi.stubGlobal('speechSynthesis', undefined);
    const api = service();
    api.setReadReplies(true);
    api.speak('Hello');
    expect(api.synthesisSupported).toBe(false);
    expect(api.readReplies()).toBe(false);
    expect(api.error()).toContain('not available');
  });

  it('releases active browser resources when the service is destroyed', () => {
    const api = service();
    api.startListening(vi.fn());
    const activeRecognition = recognition();
    TestBed.resetTestingModule();
    expect(activeRecognition.abort).toHaveBeenCalledOnce();
    expect(api.listening()).toBe(false);
    api.startListening(vi.fn());
    api.speak('नमस्कार');
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(synthesizer.speak).not.toHaveBeenCalled();
  });

  it('cancels speech on destroy and ignores already queued playback callbacks', () => {
    const api = service();
    api.speak('नमस्कार');
    const lateStart = spoken().onstart;
    const lateEnd = spoken().onend;
    const lateError = spoken().onerror;
    TestBed.resetTestingModule();
    expect(synthesizer.cancel).toHaveBeenCalledOnce();
    lateStart?.();
    lateEnd?.();
    lateError?.();
    expect(api.speaking()).toBe(false);
    expect(api.error()).toBe('');
    expect(api.status()).toBe('');
  });

  it('plays an explicit test sample in the selected language without opting into replies', () => {
    const api = service();
    api.setLanguage('en-IN');
    api.testVoice();
    expect(spoken().text).toContain('Can you hear my voice');
    expect(spoken().voice?.lang).toBe('en-IN');
    expect(api.readReplies()).toBe(false);
    expect(FakeRecognition.instances).toHaveLength(0);
  });

  it('shows selected voice availability independently of chat or playback', () => {
    const api = service();
    expect(api.voiceAvailability()).toContain('Marathi voice available');
    voices = [voice('en-US')];
    voiceEvents.dispatchEvent(new Event('voiceschanged'));
    expect(api.voiceAvailability()).toContain('No Marathi speech voice');
    api.setLanguage('en-IN');
    expect(api.voiceAvailability()).toContain('en-US');
    expect(synthesizer.speak).not.toHaveBeenCalled();
  });

  it('uses a bounded voice discovery timeout instead of waiting forever', () => {
    voices = [];
    const api = service();
    api.testVoice();
    vi.advanceTimersByTime(1999);
    expect(api.preparingSpeech()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(api.checkingVoice()).toBe(false);
    expect(api.preparingSpeech()).toBe(false);
    expect(api.speaking()).toBe(false);
    expect(api.error()).toContain('No browser speech voices loaded');
    expect(synthesizer.speak).not.toHaveBeenCalled();
    voices = [voice('mr-IN')];
    voiceEvents.dispatchEvent(new Event('voiceschanged'));
    expect(api.voiceAvailability()).toContain('Marathi voice available');
    expect(synthesizer.speak).not.toHaveBeenCalled();
    api.testVoice();
    expect(synthesizer.speak).toHaveBeenCalledOnce();
  });

  it('rechecks voices at the discovery timeout when the browser omits voiceschanged', () => {
    voices = [];
    const api = service();
    api.speak('नमस्कार');
    voices = [voice('mr-IN')];
    vi.advanceTimersByTime(2000);
    expect(synthesizer.speak).toHaveBeenCalledOnce();
    expect(api.error()).toBe('');
    expect(api.preparingSpeech()).toBe(true);
    expect(api.speaking()).toBe(false);
  });

  it.each(['stop', 'language', 'destroy'])('cancels pending voice discovery on %s', (action) => {
    voices = [];
    const api = service();
    api.speak('नमस्कार');
    if (action === 'stop') api.stopAll();
    if (action === 'language') api.setLanguage('en-IN');
    if (action === 'destroy') TestBed.resetTestingModule();
    voices = [voice('mr-IN'), voice('en-IN')];
    voiceEvents.dispatchEvent(new Event('voiceschanged'));
    vi.advanceTimersByTime(10000);
    expect(synthesizer.speak).not.toHaveBeenCalled();
    expect(api.speaking()).toBe(false);
    expect(api.preparingSpeech()).toBe(false);
    expect(api.error()).toBe('');
    if (action === 'destroy') expect(synthesizer.removeEventListener).toHaveBeenCalledOnce();
  });

  it('starts only the newest reply after delayed voice discovery', () => {
    voices = [];
    const api = service();
    api.speak('old reply');
    api.speak('new reply');
    voices = [voice('mr-IN')];
    voiceEvents.dispatchEvent(new Event('voiceschanged'));
    expect(synthesizer.speak).toHaveBeenCalledOnce();
    expect(spoken().text).toBe('new reply');
  });

  it('does not claim speech started when the browser silently ignores playback', () => {
    const api = service();
    api.testVoice();
    const lateStart = spoken().onstart;
    expect(api.speaking()).toBe(false);
    expect(api.preparingSpeech()).toBe(true);
    expect(api.status()).toContain('Starting');
    vi.advanceTimersByTime(8000);
    expect(api.speaking()).toBe(false);
    expect(api.preparingSpeech()).toBe(false);
    expect(api.status()).toBe('');
    expect(api.error()).toContain('Audio did not start');
    expect(synthesizer.cancel).toHaveBeenCalledOnce();
    lateStart?.();
    expect(api.speaking()).toBe(false);
  });

  it('clears the playback start deadline when the browser confirms speech started', () => {
    const api = service();
    api.speak('नमस्कार');
    spoken().onstart?.();
    vi.advanceTimersByTime(8000);
    expect(api.speaking()).toBe(true);
    expect(api.preparingSpeech()).toBe(false);
    expect(api.error()).toBe('');
    expect(synthesizer.cancel).not.toHaveBeenCalled();
  });

  it('cancels a queued playback start and suppresses its timeout after stop', () => {
    const api = service();
    api.speak('नमस्कार');
    api.stopSpeaking();
    vi.advanceTimersByTime(8000);
    expect(api.error()).toBe('');
    expect(api.preparingSpeech()).toBe(false);
    expect(api.speaking()).toBe(false);
  });

  it('resumes a paused speech engine before queuing audio', () => {
    synthesizer.paused = true;
    service().testVoice();
    expect(synthesizer.resume).toHaveBeenCalledOnce();
    expect(synthesizer.resume.mock.invocationCallOrder[0]).toBeLessThan(
      synthesizer.speak.mock.invocationCallOrder[0],
    );
  });

  it.each([
    ['not-allowed', 'blocked audio playback'],
    ['audio-hardware', 'speaker or headphone'],
    ['network', 'internet connection'],
    ['voice-unavailable', 'available voice'],
  ])('explains speech synthesis error %s without losing text chat', (code, expected) => {
    const api = service();
    api.testVoice();
    spoken().onerror?.({ error: code });
    expect(api.error()).toContain(expected);
    expect(api.speaking()).toBe(false);
    expect(api.preparingSpeech()).toBe(false);
    vi.advanceTimersByTime(8000);
    expect(api.error()).toContain(expected);
  });

  it('reads long Unicode replies as short sequential utterances without dropping text', () => {
    const api = service();
    const text = 'नमस्कार 😀 मित्रा. '.repeat(80).trim();
    api.speak(text);
    expect(synthesizer.speak).toHaveBeenCalledOnce();
    const parts: string[] = [];
    for (let index = 0; index < 100; index++) {
      const current = spoken();
      parts.push(current.text);
      expect(Array.from(current.text).length).toBeLessThanOrEqual(220);
      expect(current.text).not.toMatch(/\uD83D(?!\uDE00)|(?<!\uD83D)\uDE00/u);
      current.onstart?.();
      const calls = synthesizer.speak.mock.calls.length;
      current.onend?.();
      if (synthesizer.speak.mock.calls.length === calls) break;
    }
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join(' ')).toBe(text);
    expect(api.speaking()).toBe(false);
    expect(api.preparingSpeech()).toBe(false);
    expect(api.status()).toContain('Finished');
  });

  it('does not queue another long-reply segment after cancellation', () => {
    const api = service();
    api.speak('नमस्कार मित्रा. '.repeat(80));
    const lateEnd = spoken().onend;
    api.stopSpeaking();
    lateEnd?.();
    expect(synthesizer.speak).toHaveBeenCalledOnce();
    expect(api.speaking()).toBe(false);
    expect(api.preparingSpeech()).toBe(false);
  });
});
