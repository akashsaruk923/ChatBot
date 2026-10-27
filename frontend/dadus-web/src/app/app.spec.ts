import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { App } from './app';
import { AgentDefinition, ChatApi, ChatResult, HistoryResult } from './chat-api';

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

describe('DADUS chat', () => {
  let fixture: ComponentFixture<App>;
  let app: App;
  let element: HTMLElement;
  let api: {
    agents: ReturnType<typeof vi.fn>;
    health: ReturnType<typeof vi.fn>;
    conversations: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    history: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    api = {
      agents: vi.fn(() => of({ agents: AGENTS })),
      health: vi.fn(() => of({ status: 'ok', database: 'ready', mode: 'demo' })),
      conversations: vi.fn(() => of({ conversations: [] })),
      send: vi.fn(() => of(answer)),
      history: vi.fn(() => of({ conversationId: CONVERSATION.id, messages: [], hasMore: false })),
    };
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: ChatApi, useValue: api }],
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
    expect(element.textContent).toContain('बोल भावा!');
    expect(element.querySelector('h2')?.textContent).toContain('काय म्हणतोस?');
    expect(element.querySelector('.demo-banner')?.textContent).toContain('sample replies');
    expect(element.querySelector('.connection')?.textContent).toContain('Demo mode');
    expect(element.textContent).toContain('not a live AI model');
  });

  it('sends a multilingual draft, disables duplicate sends, and displays escaped model text', async () => {
    const result = new Subject<ChatResult>();
    api.send.mockReturnValue(result);
    await compose('नमस्कार, hello दोस्त!');
    await submit();
    expect(api.send).toHaveBeenCalledWith('नमस्कार, hello दोस्त!', null, 'companion');
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

  it('restores a failed draft and resubmits it without duplicate user messages', async () => {
    api.send.mockReturnValueOnce(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 503,
            error: { detail: 'The provider is not configured.' },
          }),
      ),
    );
    await compose('Please help me plan tomorrow.');
    await submit();
    expect(element.querySelector('textarea')?.value).toBe('Please help me plan tomorrow.');
    expect(element.querySelector('[role=alert]')?.textContent).toContain(
      'The provider is not configured.',
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
    expect(api.send).toHaveBeenCalledWith('हाय', null, 'companion');
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
    expect(element.querySelector('.connection-banner')?.textContent).toContain('API is not ready');
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
    expect(api.send).toHaveBeenCalledWith('Plan a weekend project', null, 'planner');
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
    expect(api.send).toHaveBeenCalledWith('Hello after the catalog failed', null, 'companion');
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
});
