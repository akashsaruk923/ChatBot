import { TestBed } from '@angular/core/testing';
import { Observable, of } from 'rxjs';
import { SpeechConfiguration } from './online-speech';
import { VoiceService } from './voice.service';

const CONFIGURATION: SpeechConfiguration = {
  provider: 'azure',
  configured: true,
  languages: ['mr-IN', 'hi-IN', 'en-IN'],
  maxTextLength: 1000,
};

class AudioPlayer {
  static instances: AudioPlayer[] = [];
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
  removeAttribute = vi.fn();
  load = vi.fn();
  constructor() {
    AudioPlayer.instances.push(this);
  }
}

describe('VoiceService with online speech', () => {
  let voice: VoiceService;
  const wav = () => new Blob([new Uint8Array(100)], { type: 'audio/wav' });
  let revoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    AudioPlayer.instances = [];
    revoke = vi.fn();
    vi.stubGlobal('speechSynthesis', undefined);
    vi.stubGlobal('SpeechSynthesisUtterance', undefined);
    vi.stubGlobal('Audio', AudioPlayer);
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:voice'), revokeObjectURL: revoke });
    TestBed.configureTestingModule({});
    voice = TestBed.inject(VoiceService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
  });

  it('plays a Marathi test without any browser speech voice and without auto-reading', () => {
    const transport = vi.fn(() => of(wav()));
    voice.configureOnlineSpeech(transport);
    voice.configureSpeech(CONFIGURATION);
    expect(voice.synthesisSupported).toBe(false);
    expect(voice.playbackSupported()).toBe(true);
    expect(voice.voiceAvailability()).toContain('Marathi Azure online voice is configured');
    voice.readReply('Do not read yet');
    expect(transport).not.toHaveBeenCalled();
    voice.testVoice();
    expect(transport).toHaveBeenCalledExactlyOnceWith(
      'नमस्कार! मी दादूस आहे. माझा आवाज ऐकू येतोय का?',
      'mr-IN',
    );
    expect(voice.preparingSpeech()).toBe(true);
    AudioPlayer.instances[0].onplaying?.();
    expect(voice.speaking()).toBe(true);
    expect(voice.preparingSpeech()).toBe(false);
    AudioPlayer.instances[0].onended?.();
    expect(voice.status()).toContain('Finished');
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('shows backend setup guidance for missing Azure credentials without requesting speech', () => {
    const transport = vi.fn(() => of(wav()));
    voice.configureOnlineSpeech(transport);
    voice.configureSpeech({ ...CONFIGURATION, configured: false });
    voice.testVoice();
    expect(voice.voiceAvailability()).toContain('Azure Speech key and region');
    expect(voice.error()).toContain('restart the API');
    expect(voice.error()).not.toContain('No Marathi speech voice');
    expect(transport).not.toHaveBeenCalled();
  });

  it('supports explicit reading opt-in, selected Hindi and English speech, and cancels on language change', () => {
    const transport = vi.fn(() => of(wav()));
    voice.configureOnlineSpeech(transport);
    voice.configureSpeech(CONFIGURATION);
    voice.setReadReplies(true);
    expect(voice.readReplies()).toBe(true);
    voice.setLanguage('hi-IN');
    voice.readReply('नमस्ते');
    expect(transport).toHaveBeenLastCalledWith('नमस्ते', 'hi-IN');
    const first = AudioPlayer.instances[0];
    voice.setLanguage('en-IN');
    expect(first.pause).toHaveBeenCalledOnce();
    expect(voice.speaking()).toBe(false);
    voice.readReply('Hello');
    expect(transport).toHaveBeenLastCalledWith('Hello', 'en-IN');
    voice.setReadReplies(false);
    expect(voice.preparingSpeech()).toBe(false);
    expect(AudioPlayer.instances[1].pause).toHaveBeenCalledOnce();
  });

  it('aborts pending audio generation on Stop and service destruction', () => {
    const cancelled = vi.fn();
    voice.configureOnlineSpeech(() => new Observable<Blob>(() => cancelled));
    voice.configureSpeech(CONFIGURATION);
    voice.testVoice();
    voice.stopSpeaking();
    expect(cancelled).toHaveBeenCalledOnce();
    voice.testVoice();
    TestBed.resetTestingModule();
    expect(cancelled).toHaveBeenCalledTimes(2);
    expect(voice.preparingSpeech()).toBe(false);
  });

  it('does not silently fall back to online speech when metadata selects browser or is absent', () => {
    const transport = vi.fn(() => of(wav()));
    voice.configureOnlineSpeech(transport);
    voice.configureSpeech();
    expect(voice.onlineSpeech()).toBe(false);
    expect(voice.playbackSupported()).toBe(false);
    voice.testVoice();
    expect(voice.error()).toContain('not available in this browser');
    expect(transport).not.toHaveBeenCalled();
    voice.configureSpeech(CONFIGURATION);
    voice.testVoice();
    voice.configureSpeech({ ...CONFIGURATION, provider: 'browser' });
    expect(AudioPlayer.instances[0].pause).toHaveBeenCalledOnce();
    expect(voice.onlineSpeech()).toBe(false);
  });

  it('bounds speech to the maximum stored AI reply size before calling Azure', () => {
    const transport = vi.fn(() => of(wav()));
    voice.configureOnlineSpeech(transport);
    voice.configureSpeech(CONFIGURATION);
    voice.speak('x'.repeat(12001));
    expect(transport).not.toHaveBeenCalled();
    expect(voice.error()).toContain('too long');
  });
});
