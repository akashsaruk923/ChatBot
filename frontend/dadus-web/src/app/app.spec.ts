import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { App } from './app';
import { AgentDefinition, ChatApi, ChatResult, HistoryResult } from './chat-api';
import { VoiceService } from './voice.service';

const CONVERSATION = {
  id: '9b2ef616-5a80-4cc2-9f32-c94544427048',
  title: 'A Marathi conversation',
  updatedAt: '2026-10-27T10:00:00Z',
};
const AGENTS: AgentDefinition[] = [
  {
    id: 'companion',
    name: 'Companion',
    description: 'Everyday questions and conversation.',
    tools: ['calculate', 'get_current_time'],
  },
  {
    id: 'planner',
    name: 'Planner',
    description: 'Break goals into clear, practical steps.',
    tools: ['calculate', 'get_current_time'],
  },
  {
    id: 'coding',
    name: 'Coding helper',
    description: 'Explain and review code without executing it.',
    tools: ['calculate', 'get_current_time'],
  },
];
const answer: ChatResult = {
  conversationId: CONVERSATION.id,
  message: {
    id: 'answer-1',
    role: 'assistant',
    content: 'बोल भावा! Demo reply.',
    createdAt: '2026-10-27T10:00:00.1234567Z',
  },
  mode: 'demo',
};

function createVoiceMock() {
  const voice = {
    recognitionSupported: true,
    synthesisSupported: true,
    languages: [
      { value: 'mr-IN', label: 'Marathi' },
      { value: 'hi-IN', label: 'Hindi' },
      { value: 'en-IN', label: 'English' },
    ],
    language: signal('mr-IN'),
    listening: signal(false),
    speaking: signal(false),
    preparingSpeech: signal(false),
    checkingVoice: signal(false),
    interimTranscript: signal(''),
    speechVoices: signal([{ value: 'test-hindi', label: 'Available Hindi voice (hi-IN)' }]),
    selectedSpeechVoice: signal('auto'),
    voiceAvailability: signal('A Marathi browser voice is available for testing.'),
    readReplies: signal(false),
    status: signal(''),
    error: signal(''),
    startListening:
      vi.fn<(onFinalTranscript: (text: string) => void, onFinished?: () => void) => void>(),
    stopListening: vi.fn(),
    cancelListening: vi.fn(),
    setLanguage: vi.fn(),
    setSpeechVoice: vi.fn(),
    setReadReplies: vi.fn(),
    readReply: vi.fn(),
    speak: vi.fn(),
    testVoice: vi.fn(),
    stopSpeaking: vi.fn(),
    stopAll: vi.fn(),
  };
  voice.startListening.mockImplementation(() => voice.listening.set(true));
  voice.stopListening.mockImplementation(() => voice.listening.set(false));
  voice.cancelListening.mockImplementation(() => voice.listening.set(false));
  voice.stopSpeaking.mockImplementation(() => {
    voice.speaking.set(false);
    voice.preparingSpeech.set(false);
  });
  voice.stopAll.mockImplementation(() => {
    voice.listening.set(false);
    voice.speaking.set(false);
    voice.preparingSpeech.set(false);
  });
  voice.setLanguage.mockImplementation((language: string) => {
    voice.stopAll();
    voice.language.set(language);
  });
  voice.setReadReplies.mockImplementation((enabled: boolean) => {
    voice.readReplies.set(enabled);
    if (!enabled) voice.stopSpeaking();
  });
  voice.speak.mockImplementation(() => {
    voice.listening.set(false);
    voice.speaking.set(true);
  });
  voice.testVoice.mockImplementation(() => {
    voice.listening.set(false);
    voice.preparingSpeech.set(true);
  });
  return voice;
}

describe('DADUS chat', () => {
  let fixture: ComponentFixture<App>;
  let app: App;
  let element: HTMLElement;
  let voice: ReturnType<typeof createVoiceMock>;
  let api: {
    agents: ReturnType<typeof vi.fn>;
    health: ReturnType<typeof vi.fn>;
    conversations: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    history: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    voice = createVoiceMock();
    api = {
      agents: vi.fn(() => of({ agents: AGENTS })),
      health: vi.fn(() => of({ status: 'ok', database: 'ready', mode: 'demo' })),
      conversations: vi.fn(() => of({ conversations: [] })),
      send: vi.fn(() => of(answer)),
      history: vi.fn(() => of({ conversationId: CONVERSATION.id, messages: [], hasMore: false })),
    };
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        { provide: ChatApi, useValue: api },
        { provide: VoiceService, useValue: voice },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(App);
    app = fixture.componentInstance;
    element = fixture.nativeElement;
    fixture.detectChanges();
    await fixture.whenStable();
  });

  async function compose(text: string): Promise<void> {
    const input = element.querySelector('textarea')!;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();
  }
  async function submit(): Promise<void> {
    element
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    fixture.detectChanges();
    await fixture.whenStable();
  }

  it('greets in Marathi and clearly labels sample replies as demo mode', () => {
    expect(element.querySelector('.welcome-description')?.textContent).toContain(
      'मराठी, हिन्दी किंवा Englishमध्ये मनमोकळं बोल.',
    );
    expect(element.querySelector('h2')?.textContent).toContain('आज काय बोलूया?');
    expect(element.querySelector('.demo-banner')?.textContent).toContain('sample replies');
    expect(element.querySelector('.demo-banner')?.textContent).toContain('Gemini or OpenAI');
    expect(element.querySelector('.connection')?.textContent).toContain('Demo mode');
    expect(element.textContent).toContain('not a live AI model');
  });

  it('sends a multilingual draft, disables duplicate sends, and displays escaped model text', async () => {
    const result = new Subject<ChatResult>();
    api.send.mockReturnValue(result);
    await compose('नमस्कार, hello दोस्त!');
    await submit();
    expect(api.send).toHaveBeenCalledWith('नमस्कार, hello दोस्त!', null, 'companion', 'mr');
    expect(element.querySelector('textarea')?.disabled).toBe(true);
    expect(element.querySelector('.typing')?.textContent).toContain('replying');
    const unsafe = '<img src=x onerror=alert(1)>\nThis is plain text.';
    result.next({ ...answer, message: { ...answer.message, content: unsafe } });
    result.complete();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(element.querySelector('.message-feed')?.textContent).toContain(unsafe);
    expect(element.querySelector('.message-feed img')).toBeNull();
    expect(element.querySelectorAll('.message')).toHaveLength(2);
    expect(element.querySelector('textarea')?.disabled).toBe(false);
    expect(app.conversationId()).toBe(CONVERSATION.id);
  });

  it('identifies Gemini configuration without claiming that a live model request has succeeded', async () => {
    api.health.mockReturnValue(of({ status: 'ok', database: 'ready', mode: 'gemini' }));
    app.checkConnection();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(app.mode()).toBe('gemini');
    expect(element.querySelector('.connection')?.textContent).toContain('Gemini configured');
    expect(element.querySelector('.connection')?.textContent).not.toContain('OpenAI');
    expect(element.querySelector('.demo-banner')).toBeNull();
    expect(api.send).not.toHaveBeenCalled();
  });

  it('labels a Gemini reply correctly and keeps opt-in reading available', async () => {
    api.health.mockReturnValue(of({ status: 'ok', database: 'ready', mode: 'openai' }));
    app.checkConnection();
    const geminiReply: ChatResult = {
      ...answer,
      mode: 'gemini',
      agentId: 'companion',
      message: { ...answer.message, content: 'नमस्कार! आपण मराठीत गप्पा मारूया.' },
    };
    api.send.mockReturnValue(of(geminiReply));
    voice.readReplies.set(true);
    await compose('मराठीत बोलूया');
    await submit();
    expect(api.send).toHaveBeenCalledWith('मराठीत बोलूया', null, 'companion', 'mr');
    expect(app.mode()).toBe('gemini');
    expect(element.querySelector('.connection')?.textContent).toContain('Gemini configured');
    expect(element.querySelector('.run-mode')?.textContent).toBe('Gemini');
    expect(element.querySelector('.message-feed')?.textContent).toContain(
      geminiReply.message.content,
    );
    expect(voice.readReply).toHaveBeenCalledWith(geminiReply.message.content);
  });

  it('gives provider-neutral guidance for a rejected Gemini key and preserves the draft', async () => {
    api.health.mockReturnValue(of({ status: 'ok', database: 'ready', mode: 'gemini' }));
    app.checkConnection();
    api.send.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 502,
            error: {
              status: 502,
              title: 'Service unavailable',
              code: 'provider_authentication_failed',
              detail: 'PRIVATE_PROVIDER_DETAIL OpenAI',
            },
          }),
      ),
    );
    await compose('माझ्याशी बोल');
    await submit();
    const error = element.querySelector('.error-banner')!;
    expect(error.textContent).toContain('The AI provider rejected the backend API key');
    expect(error.textContent).not.toContain('OpenAI');
    expect(error.textContent).not.toContain('PRIVATE_PROVIDER_DETAIL');
    expect(app.draft()).toBe('माझ्याशी बोल');
    expect(app.messages()).toEqual([]);
  });

  it.each(['provider_quota_exceeded', 'provider_rate_limited'])(
    'explains Gemini free-tier limits for %s without suggesting a billing upgrade',
    async (code) => {
      api.health.mockReturnValue(of({ status: 'ok', database: 'ready', mode: 'gemini' }));
      app.checkConnection();
      api.send.mockReturnValue(
        throwError(
          () =>
            new HttpErrorResponse({
              status: 502,
              error: {
                status: 502,
                title: 'Service unavailable',
                code,
                detail: 'PRIVATE_PROVIDER_QUOTA_BODY',
              },
            }),
        ),
      );
      await compose('आपण गप्पा मारूया');
      await submit();
      const error = element.querySelector('.error-banner')!;
      expect(error.textContent).toContain('Gemini free-tier quota or rate limit was reached');
      expect(error.textContent).toContain('Google AI Studio limits');
      expect(error.textContent).toContain('retry when the allowance resets');
      expect(error.textContent).not.toMatch(/billing|upgrade|OpenAI|PRIVATE_PROVIDER_QUOTA_BODY/i);
      expect(app.draft()).toBe('आपण गप्पा मारूया');
      expect(app.messages()).toEqual([]);
    },
  );

  it('does not guess a provider when readiness reports a missing key before mode is known', async () => {
    app.mode.set(null);
    api.health.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 503,
            error: {
              status: 503,
              title: 'Service unavailable',
              code: 'key_missing',
              detail: 'PRIVATE_GEMINI_KEY',
            },
          }),
      ),
    );
    app.checkConnection();
    fixture.detectChanges();
    await fixture.whenStable();
    const banner = element.querySelector('.connection-banner')!;
    expect(banner.textContent).toContain('server API key for the selected provider');
    expect(banner.textContent).not.toContain('OpenAI');
    expect(banner.textContent).not.toContain('Gemini');
    expect(banner.textContent).not.toContain('PRIVATE_GEMINI_KEY');
  });

  it('restores a failed draft and resubmits it without duplicate user messages', async () => {
    api.send.mockReturnValueOnce(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 503,
            error: {
              status: 503,
              title: 'Service unavailable',
              code: 'key_missing',
              detail: 'The provider is not configured.',
            },
          }),
      ),
    );
    await compose('Please help me plan tomorrow.');
    await submit();
    expect(element.querySelector('textarea')?.value).toBe('Please help me plan tomorrow.');
    expect(element.querySelector('[role=alert]')?.textContent).toContain(
      'Set the API key in the backend',
    );
    expect(element.querySelectorAll('.message')).toHaveLength(0);
    await submit();
    expect(api.send).toHaveBeenCalledTimes(2);
    expect(element.querySelectorAll('.user-message')).toHaveLength(1);
    expect(app.draft()).toBe('');
    expect(element.querySelector('[role=alert]')).toBeNull();
  });

  it('leaves Shift+Enter and composition input alone, and sends on Enter', async () => {
    await compose('हाय');
    const input = element.querySelector('textarea')!;
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(api.send).not.toHaveBeenCalled();
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    expect(api.send).toHaveBeenCalledWith('हाय', null, 'companion', 'mr');
  });

  it('loads history and requests older messages with the precise timestamp cursor', async () => {
    api.conversations.mockReturnValue(of({ conversations: [CONVERSATION] }));
    app.checkConnection();
    const cursor = '2026-10-27T10:00:00.1234567Z';
    api.history.mockReturnValueOnce(
      of({
        conversationId: CONVERSATION.id,
        messages: [
          { id: 'recent', role: 'assistant', content: 'Recent message', createdAt: cursor },
        ],
        hasMore: true,
      }),
    );
    fixture.detectChanges();
    (element.querySelector('.conversation') as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(element.textContent).toContain('Recent message');
    api.history.mockReturnValueOnce(
      of({
        conversationId: CONVERSATION.id,
        messages: [
          {
            id: 'older',
            role: 'user',
            content: 'Older message',
            createdAt: '2026-10-27T09:00:00Z',
          },
        ],
        hasMore: false,
      }),
    );
    (element.querySelector('.load-older') as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(api.history).toHaveBeenLastCalledWith(CONVERSATION.id, cursor);
    expect(app.messages().map((message) => message.content)).toEqual([
      'Older message',
      'Recent message',
    ]);
    expect(element.querySelector('.load-older')).toBeNull();
  });

  it('starts a fresh conversation while preserving a draft', async () => {
    app.messages.set([
      { id: 'one', role: 'assistant', content: 'Prior chat', createdAt: '2026-10-27T10:00:00Z' },
    ]);
    app.conversationId.set(CONVERSATION.id);
    app.hasMore.set(true);
    await compose('An unsent thought');
    (element.querySelector('.new-chat') as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(app.conversationId()).toBeNull();
    expect(app.messages()).toEqual([]);
    expect(app.hasMore()).toBe(false);
    expect(element.querySelector('textarea')?.value).toBe('An unsent thought');
    expect(element.querySelector('h2')).not.toBeNull();
  });

  it('ignores an old history response after starting a new conversation', async () => {
    const old = new Subject<HistoryResult>();
    api.history.mockReturnValue(old);
    app.selectConversation(CONVERSATION);
    app.newConversation();
    old.next({ conversationId: CONVERSATION.id, messages: [answer.message], hasMore: true });
    old.complete();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(app.messages()).toEqual([]);
    expect(app.conversationId()).toBeNull();
    expect(app.loadingHistory()).toBe(false);
  });

  it('does not send empty or overlong messages', () => {
    app.draft.set('  \n ');
    app.sendMessage();
    app.draft.set('x'.repeat(4001));
    app.sendMessage();
    expect(api.send).not.toHaveBeenCalled();
    expect(app.draft().length).toBe(4001);
  });

  it('shows rate limit guidance and keeps the draft for retry', async () => {
    api.send.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 429 })));
    await compose('Still here');
    await submit();
    expect(element.querySelector('[role=alert]')?.textContent).toContain('try again in a minute');
    expect(element.querySelector('textarea')?.value).toBe('Still here');
  });

  it('supports reconnecting after the API becomes available', async () => {
    api.health.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 0 })));
    app.checkConnection();
    fixture.detectChanges();
    expect(element.querySelector('.connection-banner')?.textContent).toContain(
      'Cannot reach the API on port 5088',
    );
    (element.querySelector('.connection-banner button') as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(element.querySelector('.connection-banner')).toBeNull();
    expect(element.querySelector('.connection')?.textContent).toContain('Demo mode');
  });
  it('renders the agent catalog and applies a selected role to the next request', async () => {
    const select = element.querySelector('#agent-select') as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.textContent?.trim())).toEqual([
      'Companion',
      'Planner',
      'Coding helper',
    ]);
    select.value = 'planner';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(element.querySelector('#agent-description')?.textContent).toContain('Break goals');
    expect(element.querySelector('#agent-scope')?.textContent).toContain('next message');
    await compose('Plan a weekend project');
    await submit();
    expect(api.send).toHaveBeenCalledWith('Plan a weekend project', null, 'planner', 'mr');
    expect(element.querySelector('.last-run')?.textContent).toContain('Planner');
    select.value = 'coding';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(element.querySelector('.last-run')?.textContent).toContain('Planner');
    expect(element.querySelector('.last-run')?.textContent).not.toContain('Coding helper');
  });

  it('shows escaped tool names and summaries for the latest response only', async () => {
    const unsafeName = '<svg onload=alert(1)>';
    const unsafeSummary = '<img src=x onerror=alert(1)> 30';
    api.send.mockReturnValue(
      of({ ...answer, agentId: 'coding', tools: [{ name: unsafeName, summary: unsafeSummary }] }),
    );
    await compose('/calculate (12+3)*2');
    await submit();
    const run = element.querySelector('.last-run')!;
    expect(run.textContent).toContain('Coding helper');
    expect(run.textContent).toContain(unsafeName);
    expect(run.textContent).toContain(unsafeSummary);
    expect(run.querySelector('svg, img')).toBeNull();
    expect(run.textContent).toContain('not saved in chat history');
    app.newConversation();
    fixture.detectChanges();
    expect(element.querySelector('.last-run')).toBeNull();
  });

  it('falls back to companion when the agent catalog fails without blocking chat', async () => {
    api.agents.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 503 })));
    app.checkConnection();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(element.querySelector('.catalog-notice')?.textContent).toContain(
      'Companion is still available',
    );
    expect((element.querySelector('#agent-select') as HTMLSelectElement).options).toHaveLength(1);
    await compose('Hello after the catalog failed');
    await submit();
    expect(api.send).toHaveBeenCalledWith(
      'Hello after the catalog failed',
      null,
      'companion',
      'mr',
    );
    expect(app.messages()).toHaveLength(2);
    expect(element.querySelector('[role=alert]')).toBeNull();
  });

  it('keeps the chosen role fixed while a message is in flight', async () => {
    const response = new Subject<ChatResult>();
    api.send.mockReturnValue(response);
    app.selectAgent('planner');
    await compose('Help me plan');
    await submit();
    expect((element.querySelector('#agent-select') as HTMLSelectElement).disabled).toBe(true);
    app.selectAgent('coding');
    expect(app.selectedAgentId()).toBe('planner');
    response.next({ ...answer, agentId: 'planner', tools: [] });
    response.complete();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(element.querySelector('.last-run')?.textContent).toContain('Planner');
    expect(element.querySelector('.last-run')?.textContent).toContain('No tools were used');
  });

  it('prefills a real tool command without submitting or losing conversation history', async () => {
    app.messages.set([answer.message]);
    fixture.detectChanges();
    const button = Array.from(element.querySelectorAll('.tool-examples button')).find((item) =>
      item.textContent?.includes('/time'),
    ) as HTMLButtonElement;
    button.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(app.draft()).toBe('/time Asia/Kolkata');
    expect(api.send).not.toHaveBeenCalled();
    expect(app.messages()).toEqual([answer.message]);
  });
  function startOverlappingConversationRefreshes() {
    fixture.destroy();
    const initial = new Subject<{ conversations: (typeof CONVERSATION)[] }>();
    const afterSend = new Subject<{ conversations: (typeof CONVERSATION)[] }>();
    api.conversations.mockReset().mockReturnValueOnce(initial).mockReturnValueOnce(afterSend);
    fixture = TestBed.createComponent(App);
    app = fixture.componentInstance;
    element = fixture.nativeElement;
    fixture.detectChanges();
    return { initial, afterSend };
  }

  it('keeps the saved conversation when the initial empty sidebar response arrives late', async () => {
    const { initial, afterSend } = startOverlappingConversationRefreshes();
    app.draft.set('Start a saved conversation');
    app.sendMessage();
    expect(api.conversations).toHaveBeenCalledTimes(2);
    const saved = { ...CONVERSATION, title: 'Fresh saved chat' };
    afterSend.next({ conversations: [saved] });
    afterSend.complete();
    initial.next({ conversations: [] });
    initial.complete();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(app.conversations()).toEqual([saved]);
    expect(app.currentTitle()).toBe('Fresh saved chat');
    expect(element.querySelector('.conversation-title')?.textContent).toBe('Fresh saved chat');
    expect(app.historyError()).toBe('');
    expect(element.querySelector('.history-error')).toBeNull();
  });

  it('ignores an old sidebar request error after the saved conversation has loaded', async () => {
    const { initial, afterSend } = startOverlappingConversationRefreshes();
    app.draft.set('Save this conversation');
    app.sendMessage();
    expect(api.conversations).toHaveBeenCalledTimes(2);
    const saved = { ...CONVERSATION, title: 'Saved without a sidebar error' };
    afterSend.next({ conversations: [saved] });
    afterSend.complete();
    initial.error(new HttpErrorResponse({ status: 503 }));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(app.conversations()).toEqual([saved]);
    expect(app.currentTitle()).toBe(saved.title);
    expect(app.historyError()).toBe('');
    expect(element.querySelector('.history-error')).toBeNull();
    expect(element.querySelector('.conversation-title')?.textContent).toBe(saved.title);
  });

  it('keeps the latest sidebar error when an older successful response arrives afterwards', async () => {
    const { initial, afterSend } = startOverlappingConversationRefreshes();
    app.draft.set('A message saved before the sidebar failed');
    app.sendMessage();
    expect(api.conversations).toHaveBeenCalledTimes(2);
    afterSend.error(new HttpErrorResponse({ status: 503 }));
    initial.next({ conversations: [CONVERSATION] });
    initial.complete();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(app.conversations()).toEqual([]);
    expect(app.historyError()).toBe('Conversation history could not be loaded.');
    expect(element.querySelector('.history-error')?.textContent).toContain('could not be loaded');
    expect(app.messages()).toHaveLength(2);
  });
  it.each([
    { code: 'database_unavailable', expected: 'Start SQL Server' },
    { code: 'key_missing', expected: 'Configure the server API key' },
    { code: 'demo_not_allowed', expected: 'Start the local API in Development' },
  ])(
    'shows safe recovery guidance for $code while preserving the draft',
    async ({ code, expected }) => {
      await compose('An unsent thought');
      api.health.mockReturnValue(
        throwError(
          () =>
            new HttpErrorResponse({
              status: 503,
              error: {
                status: 503,
                title: 'Service unavailable',
                code,
                detail: 'PRIVATE_STACK_TRACE Password=do-not-display <script>private()</script>',
              },
            }),
        ),
      );
      app.checkConnection();
      fixture.detectChanges();
      await fixture.whenStable();
      const banner = element.querySelector('.connection-banner')!;
      expect(banner.textContent).toContain(expected);
      expect(banner.textContent).toContain(code);
      expect(banner.textContent).toContain('Your draft will stay here.');
      expect(banner.textContent).not.toContain('PRIVATE_STACK_TRACE');
      expect(banner.textContent).not.toContain('Password=');
      expect(banner.querySelector('script')).toBeNull();
      expect(element.querySelector('textarea')?.value).toBe('An unsent thought');
      api.health.mockReturnValue(of({ status: 'ok', database: 'ready', mode: 'demo' }));
      (banner.querySelector('button') as HTMLButtonElement).click();
      fixture.detectChanges();
      await fixture.whenStable();
      expect(element.querySelector('.connection-banner')).toBeNull();
      expect(app.connectionCode()).toBe('');
      expect(app.draft()).toBe('An unsent thought');
    },
  );

  it('identifies an unreachable API with the expected port without exposing the network error', async () => {
    await compose('Keep this draft');
    api.health.mockReturnValue(
      throwError(
        () => new HttpErrorResponse({ status: 0, error: { message: 'PRIVATE_NETWORK_ERROR' } }),
      ),
    );
    app.checkConnection();
    fixture.detectChanges();
    await fixture.whenStable();
    const banner = element.querySelector('.connection-banner')!;
    expect(banner.textContent).toContain('Cannot reach the API on port 5088');
    expect(banner.textContent).toContain('Start the backend');
    expect(banner.textContent).not.toContain('PRIVATE_NETWORK_ERROR');
    expect(banner.querySelector('a')).toBeNull();
    expect(app.connectionCode()).toBe('');
    expect(element.querySelector('textarea')?.value).toBe('Keep this draft');
  });

  it('uses safe fallback guidance for HTML, malformed errors, and unknown ProblemDetails', async () => {
    await compose('A draft during setup');
    for (const body of [
      '<html><body>PRIVATE_SERVER_BODY</body></html>',
      { code: 'database_unavailable', detail: 'PRIVATE_SERVER_BODY' },
      {
        status: 503,
        title: 'Unexpected failure',
        code: 'PRIVATE_SERVER_CODE',
        detail: 'PRIVATE_SERVER_BODY',
      },
    ]) {
      api.health.mockReturnValue(
        throwError(() => new HttpErrorResponse({ status: 503, error: body })),
      );
      app.checkConnection();
      fixture.detectChanges();
      await fixture.whenStable();
      const banner = element.querySelector('.connection-banner')!;
      expect(banner.textContent).toContain('Confirm the backend is running on port 5088');
      expect(banner.textContent).not.toContain('PRIVATE_SERVER');
      expect(banner.textContent).not.toContain('database_unavailable');
      expect(app.connectionCode()).toBe('');
      expect(app.draft()).toBe('A draft during setup');
    }
  });

  it('ignores an old health failure after a newer successful readiness check', async () => {
    const old = new Subject<{ status: string; mode: 'demo' | 'openai'; database: string }>();
    const latest = new Subject<{ status: string; mode: 'demo' | 'openai'; database: string }>();
    api.health.mockReturnValueOnce(old).mockReturnValueOnce(latest);
    app.checkConnection();
    app.checkConnection();
    latest.next({ status: 'ok', mode: 'openai', database: 'ready' });
    latest.complete();
    old.error(new HttpErrorResponse({ status: 0 }));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(app.connected()).toBe(true);
    expect(app.mode()).toBe('openai');
    expect(app.checkingConnection()).toBe(false);
    expect(element.querySelector('.connection-banner')).toBeNull();
    expect(element.querySelector('.connection')?.textContent).toContain('OpenAI configured');
  });

  it('does not let an older health success hide a newer database readiness failure', async () => {
    const old = new Subject<{ status: string; mode: 'demo' | 'openai'; database: string }>();
    const latest = new Subject<{ status: string; mode: 'demo' | 'openai'; database: string }>();
    api.health.mockReturnValueOnce(old).mockReturnValueOnce(latest);
    app.checkConnection();
    app.checkConnection();
    latest.error(
      new HttpErrorResponse({
        status: 503,
        error: {
          status: 503,
          title: 'Storage unavailable',
          detail: 'The database is not ready.',
          code: 'database_unavailable',
        },
      }),
    );
    old.next({ status: 'ok', mode: 'openai', database: 'ready' });
    old.complete();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(app.connected()).toBe(false);
    expect(app.checkingConnection()).toBe(false);
    expect(app.connectionCode()).toBe('database_unavailable');
    expect(element.querySelector('.connection-banner')?.textContent).toContain('Start SQL Server');
  });

  it('keeps a successful send connected when an earlier health check fails later', async () => {
    const old = new Subject<{ status: string; mode: 'demo' | 'openai'; database: string }>();
    api.health.mockReturnValueOnce(old);
    app.checkConnection();
    await compose('A successful message');
    await submit();
    old.error(new HttpErrorResponse({ status: 0 }));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(app.messages()).toHaveLength(2);
    expect(app.connected()).toBe(true);
    expect(app.mode()).toBe('demo');
    expect(app.checkingConnection()).toBe(false);
    expect(app.connectionCode()).toBe('');
    expect(element.querySelector('.connection-banner')).toBeNull();
  });

  it('shows mic and language controls without requesting the microphone or speaking on load', () => {
    expect(element.querySelector('.mic-button')?.textContent).toContain('Mic');
    expect((element.querySelector('#voice-language') as HTMLSelectElement).value).toBe('mr-IN');
    expect((element.querySelector('.read-replies-toggle input') as HTMLInputElement).checked).toBe(
      false,
    );
    expect(voice.startListening).not.toHaveBeenCalled();
    expect(voice.speak).not.toHaveBeenCalled();
    expect(voice.readReply).not.toHaveBeenCalled();
    expect(voice.testVoice).not.toHaveBeenCalled();
    expect(element.querySelector('#voice-help')?.textContent).toContain('may process audio online');
  });

  it.each([
    {
      locale: 'en-IN',
      language: 'en',
      greeting: 'What would you like to talk about?',
      placeholder: 'Message DADUS',
      reply: 'Of course. What would you like to talk about?',
    },
    {
      locale: 'hi-IN',
      language: 'hi',
      greeting: 'आज क्या बात करें?',
      placeholder: 'मन की बात कहें…',
      reply: 'ज़रूर। बताओ, आज क्या चल रहा है?',
    },
    {
      locale: 'mr-IN',
      language: 'mr',
      greeting: 'आज काय बोलूया?',
      placeholder: 'मनातलं बोल…',
      reply: 'हो, बोल ना. आज काय चाललंय?',
    },
  ] as const)(
    'uses $language for the AI reply, microphone and optional spoken answer',
    async ({ locale, language, greeting, placeholder, reply }) => {
      const select = element.querySelector('#voice-language') as HTMLSelectElement;
      select.value = locale;
      select.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      await fixture.whenStable();
      expect(voice.setLanguage).toHaveBeenCalledWith(locale);
      expect(app.replyLanguage()).toBe(language);
      expect(element.querySelector('h2')?.textContent).toContain(greeting);
      expect(element.querySelector('textarea')?.placeholder).toBe(placeholder);
      voice.readReplies.set(true);
      api.send.mockReturnValue(
        of({ ...answer, mode: 'gemini', language, message: { ...answer.message, content: reply } }),
      );
      await compose('Tell me how you are doing');
      await submit();
      expect(api.send).toHaveBeenCalledWith(
        'Tell me how you are doing',
        null,
        'companion',
        language,
      );
      expect(voice.language()).toBe(locale);
      expect(voice.readReply).toHaveBeenCalledWith(reply);
      expect(element.querySelector('.message-feed')?.textContent).toContain(reply);
    },
  );

  it('switches reply language on the next turn without clearing the conversation or its prior messages', async () => {
    api.send.mockReturnValueOnce(of(answer)).mockReturnValueOnce(
      of({
        ...answer,
        language: 'hi',
        message: {
          ...answer.message,
          id: 'answer-hi',
          content: 'हाँ, हम उसी बात को आगे बढ़ाते हैं।',
        },
      }),
    );
    await compose('मराठीत बोलूया');
    await submit();
    const before = [...app.messages()];
    const select = element.querySelector('#voice-language') as HTMLSelectElement;
    select.value = 'hi-IN';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(app.conversationId()).toBe(CONVERSATION.id);
    expect(app.messages()).toEqual(before);
    await compose('अब हिन्दी में आगे बात करें');
    await submit();
    expect(api.send).toHaveBeenLastCalledWith(
      'अब हिन्दी में आगे बात करें',
      CONVERSATION.id,
      'companion',
      'hi',
    );
    expect(app.messages()).toHaveLength(4);
    expect(app.messages()[0].content).toBe('मराठीत बोलूया');
    expect(app.messages()[3].content).toBe('हाँ, हम उसी बात को आगे बढ़ाते हैं।');
  });

  it('retains the selected reply language and unsent draft when the server rejects a language setting', async () => {
    app.changeVoiceLanguage('hi-IN');
    api.send.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 400,
            error: {
              status: 400,
              title: 'Request rejected',
              code: 'invalid_language',
              detail: 'PRIVATE_SERVER_DETAIL',
            },
          }),
      ),
    );
    await compose('मुझसे बात करो');
    await submit();
    expect(element.querySelector('.error-banner')?.textContent).toContain(
      'Choose English, हिन्दी or मराठी',
    );
    expect(element.textContent).not.toContain('PRIVATE_SERVER_DETAIL');
    expect(app.draft()).toBe('मुझसे बात करो');
    expect(app.replyLanguage()).toBe('hi');
    expect(api.send).toHaveBeenCalledWith('मुझसे बात करो', null, 'companion', 'hi');
  });

  it('appends dictated text to a typed draft for review without automatically sending', async () => {
    await compose('आज आपण');
    (element.querySelector('.mic-button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(element.querySelector('.mic-button')?.textContent).toContain('Stop dictation');
    const transcript = voice.startListening.mock.calls[0][0];
    transcript('मराठीत गप्पा मारूया');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(element.querySelector('textarea')?.value).toBe('आज आपण मराठीत गप्पा मारूया');
    expect(api.send).not.toHaveBeenCalled();
    (element.querySelector('.mic-button') as HTMLButtonElement).click();
    expect(voice.stopListening).toHaveBeenCalledOnce();
    await submit();
    expect(api.send).toHaveBeenCalledWith('आज आपण मराठीत गप्पा मारूया', null, 'companion', 'mr');
    expect(voice.stopAll).toHaveBeenCalled();
  });

  it('enables spoken replies from the ordinary Mic and reads only the completed AI answer', async () => {
    const response = new Subject<ChatResult>();
    api.send.mockReturnValue(response);
    (element.querySelector('.mic-button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect((element.querySelector('.read-replies-toggle input') as HTMLInputElement).checked).toBe(
      true,
    );
    voice.startListening.mock.calls[0][0]('माझ्याशी बोल');
    expect(api.send).not.toHaveBeenCalled();
    expect(voice.readReply).not.toHaveBeenCalled();
    expect(voice.speak).not.toHaveBeenCalled();
    (element.querySelector('.mic-button') as HTMLButtonElement).click();
    await submit();
    expect(api.send).toHaveBeenCalledExactlyOnceWith('माझ्याशी बोल', null, 'companion', 'mr');
    expect(voice.readReply).not.toHaveBeenCalled();
    response.next(answer);
    response.complete();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(voice.readReply).toHaveBeenCalledExactlyOnceWith(answer.message.content);
    expect(voice.startListening).toHaveBeenCalledOnce();
  });

  it.each(['recording', 'waiting'])(
    'respects spoken-reply opt-out during ordinary Mic %s',
    async (phase) => {
      const response = new Subject<ChatResult>();
      api.send.mockReturnValue(response);
      (element.querySelector('.mic-button') as HTMLButtonElement).click();
      voice.startListening.mock.calls[0][0]('Keep this reply silent');
      const optOut = () => {
        const toggle = element.querySelector('.read-replies-toggle input') as HTMLInputElement;
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change'));
      };
      if (phase === 'recording') optOut();
      (element.querySelector('.mic-button') as HTMLButtonElement).click();
      await submit();
      if (phase === 'waiting') optOut();
      response.next(answer);
      response.complete();
      fixture.detectChanges();
      await fixture.whenStable();
      expect(voice.setReadReplies.mock.calls).toEqual([[true], [false]]);
      expect(voice.readReplies()).toBe(false);
      expect(voice.readReply).not.toHaveBeenCalled();
      expect(voice.speak).not.toHaveBeenCalled();
      expect(element.querySelector('.message-feed')?.textContent).toContain(answer.message.content);
    },
  );

  it('retains a failed ordinary Mic draft without reading the draft or the request error', async () => {
    const response = new Subject<ChatResult>();
    api.send.mockReturnValue(response);
    (element.querySelector('.mic-button') as HTMLButtonElement).click();
    voice.startListening.mock.calls[0][0]('हे शब्द जप');
    (element.querySelector('.mic-button') as HTMLButtonElement).click();
    await submit();
    response.error(new HttpErrorResponse({ status: 0 }));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(app.draft()).toBe('हे शब्द जप');
    expect(voice.readReplies()).toBe(true);
    expect(voice.readReply).not.toHaveBeenCalled();
    expect(voice.speak).not.toHaveBeenCalled();
  });

  it('finishes a voice turn before sending all final words and automatically reads the reply', async () => {
    voice.stopListening.mockImplementation(() => {});
    (element.querySelector('.start-voice-chat') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(voice.readReplies()).toBe(true);
    const [transcript, finished] = voice.startListening.mock.calls[0];
    transcript('आज माझा दिवस');
    voice.interimTranscript.set('थोडा busy होता');
    fixture.detectChanges();
    expect(element.querySelector('#voice-help')?.textContent).toContain('Hearing: थोडा busy होता');
    expect(app.draft()).toBe('आज माझा दिवस');
    expect((element.querySelector('.send-button') as HTMLButtonElement).disabled).toBe(true);
    await submit();
    expect(api.send).not.toHaveBeenCalled();
    (element.querySelector('.finish-voice-chat') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(voice.stopListening).toHaveBeenCalledOnce();
    expect(api.send).not.toHaveBeenCalled();
    app.finishVoiceChat();
    expect(voice.stopListening).toHaveBeenCalledOnce();
    transcript('थोडा busy होता');
    voice.listening.set(false);
    finished?.();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(api.send).toHaveBeenCalledExactlyOnceWith(
      'आज माझा दिवस थोडा busy होता',
      null,
      'companion',
      'mr',
    );
    expect(voice.readReply).toHaveBeenCalledWith(answer.message.content);
    expect(voice.startListening).toHaveBeenCalledOnce();
    expect(app.voiceChatActive()).toBe(false);
    finished?.();
    expect(api.send).toHaveBeenCalledOnce();
  });

  it('does not send an earlier typed draft when a voice turn captures no speech', async () => {
    await compose('Keep this typed thought');
    voice.stopListening.mockImplementation(() => {});
    app.startVoiceChat();
    app.finishVoiceChat();
    voice.listening.set(false);
    voice.startListening.mock.calls[0][1]?.();
    fixture.detectChanges();
    expect(api.send).not.toHaveBeenCalled();
    expect(app.draft()).toBe('Keep this typed thought');
    expect(app.dictationNotice()).toContain('No speech was captured');
  });

  it('cancels a voice turn while retaining the draft and ignores its late completion', () => {
    app.startVoiceChat();
    const [transcript, finished] = voice.startListening.mock.calls[0];
    transcript('हे शब्द ठेव');
    app.cancelVoiceChat();
    transcript('stale words');
    finished?.();
    expect(app.draft()).toBe('हे शब्द ठेव');
    expect(api.send).not.toHaveBeenCalled();
    expect(app.voiceChatActive()).toBe(false);
  });

  it('invalidates a pending voice send when language or conversation changes', () => {
    voice.stopListening.mockImplementation(() => {});
    app.startVoiceChat();
    const [transcript, finished] = voice.startListening.mock.calls[0];
    transcript('Unsent words');
    app.finishVoiceChat();
    app.changeVoiceLanguage('hi-IN');
    finished?.();
    app.startVoiceChat();
    const nextFinished = voice.startListening.mock.calls[1][1];
    app.finishVoiceChat();
    app.newConversation();
    nextFinished?.();
    expect(api.send).not.toHaveBeenCalled();
    expect(app.draft()).toBe('Unsent words');
  });

  it('recovers from recognition failure without leaving voice chat stuck or sending a draft', async () => {
    app.startVoiceChat();
    voice.startListening.mock.calls[0][0]('Captured before the error');
    voice.error.set('Microphone disconnected.');
    voice.listening.set(false);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(app.voiceChatActive()).toBe(false);
    expect(app.voiceChatFinishing()).toBe(false);
    expect(app.draft()).toBe('Captured before the error');
    expect(api.send).not.toHaveBeenCalled();
    expect(element.querySelector('.start-voice-chat')).not.toBeNull();
  });

  it('keeps an oversized voice draft for review instead of sending truncated speech', () => {
    voice.stopListening.mockImplementation(() => {});
    app.startVoiceChat();
    voice.startListening.mock.calls[0][0]('x'.repeat(4001));
    app.finishVoiceChat();
    voice.listening.set(false);
    voice.startListening.mock.calls[0][1]?.();
    expect(api.send).not.toHaveBeenCalled();
    expect(app.draft()).toHaveLength(4000);
    expect(app.dictationNotice()).toContain('Review the captured draft');
  });

  it('keeps the voice draft after a failed AI request and permits reading opt-out while waiting', async () => {
    const result = new Subject<ChatResult>();
    api.send.mockReturnValue(result);
    voice.stopListening.mockImplementation(() => {});
    app.startVoiceChat();
    voice.startListening.mock.calls[0][0]('Reply to my spoken question');
    app.finishVoiceChat();
    voice.listening.set(false);
    voice.startListening.mock.calls[0][1]?.();
    app.setReadReplies(false);
    result.error(new HttpErrorResponse({ status: 0 }));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(app.draft()).toBe('Reply to my spoken question');
    expect(voice.readReply).not.toHaveBeenCalled();
    expect(voice.startListening).toHaveBeenCalledOnce();
  });

  it('selects an installed speech voice independently of the AI and microphone language', () => {
    const select = element.querySelector('#speech-voice') as HTMLSelectElement;
    select.value = 'test-hindi';
    select.dispatchEvent(new Event('change'));
    expect(voice.setSpeechVoice).toHaveBeenCalledWith('test-hindi');
    expect(app.replyLanguage()).toBe('mr');
    expect(voice.setLanguage).not.toHaveBeenCalled();
  });

  it('tests browser speech explicitly without an AI request, microphone access, or changing the chat', async () => {
    app.messages.set([answer.message]);
    app.conversationId.set(CONVERSATION.id);
    await compose('Keep this unsent thought');
    (element.querySelector('.test-voice') as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(voice.testVoice).toHaveBeenCalledOnce();
    expect(voice.startListening).not.toHaveBeenCalled();
    expect(voice.readReplies()).toBe(false);
    expect(api.send).not.toHaveBeenCalled();
    expect(api.history).not.toHaveBeenCalled();
    expect(api.conversations).toHaveBeenCalledOnce();
    expect(app.conversationId()).toBe(CONVERSATION.id);
    expect(app.messages()).toEqual([answer.message]);
    expect(app.draft()).toBe('Keep this unsent thought');
    expect(element.querySelector('#voice-availability')?.textContent).toContain(
      'Marathi browser voice',
    );
    expect(element.querySelector('.stop-reading')).not.toBeNull();
    (element.querySelector('.stop-reading') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(voice.stopSpeaking).toHaveBeenCalledOnce();
    expect(voice.preparingSpeech()).toBe(false);
    expect(element.querySelector('.stop-reading')).toBeNull();
  });

  it('keeps Stop available while browser voices are loading, including during history loading', () => {
    voice.preparingSpeech.set(true);
    voice.checkingVoice.set(true);
    voice.voiceAvailability.set('Checking browser speech voices…');
    app.loadingHistory.set(true);
    fixture.detectChanges();
    expect((element.querySelector('.test-voice') as HTMLButtonElement).disabled).toBe(false);
    const stop = element.querySelector('.stop-reading') as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    expect(element.querySelector('#voice-availability')?.textContent).toContain(
      'Checking browser speech voices',
    );
    stop.click();
    expect(voice.preparingSpeech()).toBe(false);
  });

  it.each([
    'No Marathi speech voice is available. Choose an available voice language or install a supported voice.',
    'The browser blocked audio playback. Press Test voice, check that this tab is unmuted, and try again.',
  ])(
    'shows a prominent actionable voice error without losing a typed draft: %s',
    async (message) => {
      await compose('हा draft जप');
      app.messages.set([answer.message]);
      voice.voiceAvailability.set('No Marathi browser voice is available.');
      voice.testVoice.mockImplementation(() => voice.error.set(message));
      (element.querySelector('.test-voice') as HTMLButtonElement).click();
      fixture.detectChanges();
      await fixture.whenStable();
      const alert = element.querySelector('.composer-area > .voice-error')!;
      expect(alert.getAttribute('role')).toBe('alert');
      expect(alert.textContent).toContain(message);
      expect(element.querySelector('#voice-availability')?.textContent).toContain(
        'No Marathi browser voice',
      );
      expect(element.querySelector('#voice-help .voice-error')).toBeNull();
      expect(app.draft()).toBe('हा draft जप');
      expect(app.messages()).toEqual([answer.message]);
      expect(api.send).not.toHaveBeenCalled();
      (alert.querySelector('button') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(element.querySelector('.voice-error')).toBeNull();
    },
  );

  it('allows a queued individual reply to be stopped before speech begins', () => {
    app.messages.set([answer.message]);
    voice.speak.mockImplementation(() => voice.preparingSpeech.set(true));
    fixture.detectChanges();
    const read = element.querySelector('.read-reply') as HTMLButtonElement;
    read.click();
    fixture.detectChanges();
    expect(voice.speaking()).toBe(false);
    expect(read.textContent).toContain('Stop reading');
    expect(element.querySelector('.stop-reading')).not.toBeNull();
    read.click();
    fixture.detectChanges();
    expect(voice.preparingSpeech()).toBe(false);
    expect(read.textContent).toContain('Read aloud');
  });

  it('limits dictated drafts to 4,000 characters and explains truncation', async () => {
    await compose('x'.repeat(3998));
    app.toggleDictation();
    voice.startListening.mock.calls[0][0]('काही नवीन शब्द');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(app.draft().length).toBe(4000);
    expect(app.draft().startsWith('x'.repeat(3998))).toBe(true);
    expect(element.querySelector('#voice-help')?.textContent).toContain('4,000-character limit');
    expect(api.send).not.toHaveBeenCalled();
  });

  it('discards late dictation after changing conversations and cleans up on destroy', async () => {
    await compose('Keep my draft');
    app.toggleDictation();
    const transcript = voice.startListening.mock.calls[0][0];
    app.newConversation();
    transcript('stale words from the old chat');
    expect(app.draft()).toBe('Keep my draft');
    expect(voice.stopAll).toHaveBeenCalledOnce();
    fixture.destroy();
    expect(voice.stopAll).toHaveBeenCalledTimes(2);
  });

  it('disables dictation during a request and does not let late text replace a failed draft', async () => {
    const response = new Subject<ChatResult>();
    api.send.mockReturnValue(response);
    await compose('Please reply');
    app.toggleDictation();
    const transcript = voice.startListening.mock.calls[0][0];
    await submit();
    expect((element.querySelector('.mic-button') as HTMLButtonElement).disabled).toBe(true);
    transcript('late microphone result');
    expect(app.draft()).toBe('');
    response.error(new HttpErrorResponse({ status: 0 }));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(app.draft()).toBe('Please reply');
    expect(element.querySelector('.error-banner')?.textContent).toContain('port 5088');
  });

  it('cancels voice when changing language and never auto-reads history', async () => {
    voice.listening.set(true);
    const select = element.querySelector('#voice-language') as HTMLSelectElement;
    select.value = 'hi-IN';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(voice.setLanguage).toHaveBeenCalledWith('hi-IN');
    expect(voice.listening()).toBe(false);
    voice.readReplies.set(true);
    api.history.mockReturnValue(
      of({ conversationId: CONVERSATION.id, messages: [answer.message], hasMore: false }),
    );
    app.selectConversation(CONVERSATION);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(voice.readReply).not.toHaveBeenCalled();
    expect(voice.speak).not.toHaveBeenCalled();
  });

  it('reads new replies only after opt-in and allows explicit reading and stopping', async () => {
    await compose('Hello');
    await submit();
    expect(voice.readReply).not.toHaveBeenCalled();
    expect(voice.speak).not.toHaveBeenCalled();
    const read = element.querySelector('.read-reply') as HTMLButtonElement;
    read.click();
    fixture.detectChanges();
    expect(voice.speak).toHaveBeenCalledWith(answer.message.content);
    expect(read.textContent).toContain('Stop reading');
    read.click();
    fixture.detectChanges();
    expect(voice.stopSpeaking).toHaveBeenCalled();
    const toggle = element.querySelector('.read-replies-toggle input') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await compose('Another question');
    await submit();
    expect(voice.readReply).toHaveBeenCalledWith(answer.message.content);
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    expect(voice.readReplies()).toBe(false);
    expect(voice.stopSpeaking).toHaveBeenCalled();
  });

  it('keeps voice controls visible with honest unsupported guidance while typing still works', async () => {
    voice.recognitionSupported = false;
    voice.synthesisSupported = false;
    fixture.detectChanges();
    expect((element.querySelector('.mic-button') as HTMLButtonElement).disabled).toBe(true);
    expect((element.querySelector('.read-replies-toggle input') as HTMLInputElement).disabled).toBe(
      true,
    );
    expect((element.querySelector('.test-voice') as HTMLButtonElement).disabled).toBe(true);
    expect(element.querySelector('#voice-help')?.textContent).toContain(
      'Mic dictation is unavailable',
    );
    expect(element.querySelector('#voice-help')?.textContent).toContain(
      'Reading aloud is unavailable',
    );
    await compose('I can still type');
    await submit();
    expect(api.send).toHaveBeenCalledWith('I can still type', null, 'companion', 'mr');
    expect(element.querySelector('.message-feed')?.textContent).toContain(answer.message.content);
  });

  it('lets the user opt out of reading while waiting for an AI reply', async () => {
    const response = new Subject<ChatResult>();
    api.send.mockReturnValue(response);
    voice.readReplies.set(true);
    await compose('Please answer without speaking');
    await submit();
    const toggle = element.querySelector('.read-replies-toggle input') as HTMLInputElement;
    expect(toggle.disabled).toBe(false);
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    response.next(answer);
    response.complete();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(voice.readReply).not.toHaveBeenCalled();
    expect(element.querySelector('.message-feed')?.textContent).toContain(answer.message.content);
  });

  it.each([
    { code: 'provider_authentication_failed', expected: 'rejected the backend API key' },
    { code: 'provider_access_denied', expected: 'project and model permissions' },
    { code: 'provider_quota_exceeded', expected: 'API billing' },
    { code: 'provider_rate_limited', expected: 'Wait a little' },
    { code: 'provider_model_unavailable', expected: 'backend model setting' },
    { code: 'provider_unavailable', expected: 'backend internet connection' },
    { code: 'provider_dns_failed', expected: 'resolve the AI provider address' },
    { code: 'provider_connection_failed', expected: 'connect to the AI provider' },
    { code: 'provider_tls_failed', expected: 'TLS connection' },
    { code: 'provider_proxy_failed', expected: 'configured proxy' },
    { code: 'provider_failed', expected: 'backend API key, model access and provider quota' },
  ])(
    'explains $code without exposing provider details or losing the draft',
    async ({ code, expected }) => {
      api.send.mockReturnValue(
        throwError(
          () =>
            new HttpErrorResponse({
              status: 502,
              error: {
                status: 502,
                title: 'Service unavailable',
                code,
                detail: 'PRIVATE_KEY_VALUE private-provider-body',
              },
            }),
        ),
      );
      await compose('Please answer this');
      await submit();
      const error = element.querySelector('.error-banner')!;
      expect(error.textContent).toContain(expected);
      expect(error.textContent).not.toContain('PRIVATE_KEY_VALUE');
      expect(error.textContent).not.toContain('private-provider-body');
      expect(element.querySelector('textarea')?.value).toBe('Please answer this');
      expect(app.messages()).toEqual([]);
    },
  );

  it('reports invalid backend key configuration during readiness without exposing the value', async () => {
    api.health.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 503,
            error: {
              status: 503,
              title: 'Service unavailable',
              code: 'invalid_api_key_configuration',
              detail: 'PRIVATE_KEY_VALUE',
            },
          }),
      ),
    );
    app.checkConnection();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(app.connected()).toBe(false);
    expect(app.connectionCode()).toBe('invalid_api_key_configuration');
    expect(element.querySelector('.connection-banner')?.textContent).toContain(
      'key format is invalid',
    );
    expect(element.textContent).not.toContain('PRIVATE_KEY_VALUE');
  });

  it('retains the draft when malformed key configuration prevents sending', async () => {
    api.send.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 503,
            error: {
              status: 503,
              title: 'Service unavailable',
              code: 'invalid_api_key_configuration',
              detail: 'PRIVATE_KEY_VALUE',
            },
          }),
      ),
    );
    await compose('Please keep this');
    await submit();
    expect(element.querySelector('.error-banner')?.textContent).toContain('key format is invalid');
    expect(element.textContent).not.toContain('PRIVATE_KEY_VALUE');
    expect(app.draft()).toBe('Please keep this');
    expect(app.messages()).toEqual([]);
  });

  it.each([503, 599, '503', 400, 503.5, 'PRIVATE_UPSTREAM_DATA'])(
    'distinguishes upstream service failure and only reflects a validated status: %s',
    async (providerStatus) => {
      api.health.mockReturnValue(of({ status: 'ok', database: 'ready', mode: 'gemini' }));
      app.checkConnection();
      fixture.detectChanges();
      await fixture.whenStable();
      api.send.mockReturnValue(
        throwError(
          () =>
            new HttpErrorResponse({
              status: 502,
              error: {
                status: 502,
                title: 'Service unavailable',
                code: 'provider_service_unavailable',
                providerStatus,
                detail: 'PRIVATE_KEY_VALUE private-provider-body',
              },
            }),
        ),
      );
      await compose('Try a Gemini reply');
      await submit();
      const text = element.querySelector('.error-banner')!.textContent!;
      expect(text).toContain('Gemini returned a service error');
      if (
        typeof providerStatus === 'number' &&
        Number.isInteger(providerStatus) &&
        providerStatus >= 500 &&
        providerStatus <= 599
      )
        expect(text).toContain(`HTTP ${providerStatus}`);
      else expect(text).not.toContain('HTTP');
      expect(text).not.toContain('PRIVATE_KEY_VALUE');
      expect(text).not.toContain('PRIVATE_UPSTREAM_DATA');
      expect(text).not.toContain('private-provider-body');
      expect(text).not.toContain('backend internet connection');
      expect(app.draft()).toBe('Try a Gemini reply');
      expect(app.messages()).toEqual([]);
      expect(api.send).toHaveBeenCalledOnce();
    },
  );

  it('does not echo unknown chat failure bodies and explains unclassified proxy failures', async () => {
    api.send.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 502,
            error: { detail: '<html>PRIVATE_SERVER_DATA</html>' },
          }),
      ),
    );
    await compose('Keep this message');
    await submit();
    expect(element.querySelector('.error-banner')?.textContent).toContain(
      'backend terminal on port 5088',
    );
    expect(element.querySelector('.error-banner')?.textContent).not.toContain(
      'PRIVATE_SERVER_DATA',
    );
    expect(app.draft()).toBe('Keep this message');
  });
});
