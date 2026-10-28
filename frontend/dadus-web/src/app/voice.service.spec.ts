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
    expect(recognition().continuous).toBe(false);
    expect(recognition().interimResults).toBe(false);
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
    service().startListening(received);
    recognition().result('नम', false);
    expect(received).not.toHaveBeenCalled();
    recognition().result('  नमस्कार मित्रा  ');
    recognition().result('नमस्कार मित्रा');
    expect(received).toHaveBeenCalledExactlyOnceWith('नमस्कार मित्रा');
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

  it.each([
    ['not-allowed', 'site settings'],
    ['audio-capture', 'microphone'],
    ['no-speech', 'No speech'],
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

  it('does not pretend a different language voice can read Marathi', () => {
    voices = [voice('en-US'), voice('hi-IN')];
    const api = service();
    api.speak('नमस्कार');
    expect(synthesizer.speak).not.toHaveBeenCalled();
    expect(api.error()).toContain('No Marathi speech voice');
    expect(api.speaking()).toBe(false);
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
