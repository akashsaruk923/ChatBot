import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AgentDefinition, ChatApi, ChatResult } from './chat-api';

const SESSION = 'a2aed5ba-fef3-45f4-818a-c10d61cb66f0';
const CONVERSATION = 'b775eb28-f7d7-4edb-ab54-5cc6bb5fac64';

describe('ChatApi', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('uses the stored anonymous browser session on health and conversation requests', () => {
    localStorage.setItem('dadus-session', SESSION);
    const api = TestBed.inject(ChatApi);
    api.health().subscribe();
    const health = http.expectOne('/api/health');
    expect(health.request.headers.get('X-Dadus-Session')).toBe(SESSION);
    health.flush({ status: 'ok', mode: 'demo', database: 'ready' });

    api.conversations().subscribe();
    const conversations = http.expectOne('/api/chat/conversations');
    expect(conversations.request.headers.get('X-Dadus-Session')).toBe(SESSION);
    conversations.flush({ conversations: [] });
  });

  it('creates and persists one cryptographically random session for all requests', () => {
    const api = TestBed.inject(ChatApi);
    api.health().subscribe();
    const health = http.expectOne('/api/health');
    const session = health.request.headers.get('X-Dadus-Session');
    expect(session).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(localStorage.getItem('dadus-session')).toBe(session);
    health.flush({ status: 'ok', mode: 'demo', database: 'ready' });

    const anotherInstance = TestBed.runInInjectionContext(() => new ChatApi());
    anotherInstance.conversations().subscribe();
    const conversations = http.expectOne('/api/chat/conversations');
    expect(conversations.request.headers.get('X-Dadus-Session')).toBe(session);
    conversations.flush({ conversations: [] });
  });

  it('sends text and conversation identity without adding provider credentials', () => {
    localStorage.setItem('dadus-session', SESSION);
    const api = TestBed.inject(ChatApi);
    const result: ChatResult = {
      conversationId: CONVERSATION,
      message: {
        id: 'reply-id',
        role: 'assistant',
        content: 'नमस्कार!',
        createdAt: '2026-10-27T12:00:00Z',
      },
      mode: 'demo',
    };
    let received: ChatResult | undefined;
    api.send('काय म्हणतोस?', CONVERSATION).subscribe((response) => (received = response));
    const request = http.expectOne('/api/chat/message');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      message: 'काय म्हणतोस?',
      conversationId: CONVERSATION,
      agentId: 'companion',
    });
    expect(request.request.headers.get('X-Dadus-Session')).toBe(SESSION);
    expect(request.request.headers.has('Authorization')).toBe(false);
    request.flush(result);
    expect(received).toEqual(result);
  });

  it('starts a conversation with a null conversation id', () => {
    TestBed.inject(ChatApi).send('Hello').subscribe();
    const request = http.expectOne('/api/chat/message');
    expect(request.request.body).toEqual({ message: 'Hello', conversationId: null, agentId: 'companion' });
    request.flush({ conversationId: CONVERSATION, message: {}, mode: 'demo' });
  });

  it('loads the agent catalog using the current browser session', () => {
    localStorage.setItem('dadus-session', SESSION);
    const agents: AgentDefinition[] = [
      {
        id: 'planner',
        name: 'Planner',
        description: 'Organize a practical plan.',
        tools: ['create_plan'],
      },
    ];
    let received: AgentDefinition[] | undefined;
    TestBed.inject(ChatApi).agents().subscribe((response) => (received = response.agents));
    const request = http.expectOne('/api/agents');
    expect(request.request.method).toBe('GET');
    expect(request.request.headers.get('X-Dadus-Session')).toBe(SESSION);
    request.flush({ agents });
    expect(received).toEqual(agents);
  });

  it('sends the selected agent with an existing conversation', () => {
    TestBed.inject(ChatApi).send('Review this function', CONVERSATION, 'coding').subscribe();
    const request = http.expectOne('/api/chat/message');
    expect(request.request.body).toEqual({
      message: 'Review this function',
      conversationId: CONVERSATION,
      agentId: 'coding',
    });
    request.flush({ conversationId: CONVERSATION, message: {}, mode: 'demo', agentId: 'coding' });
  });

  it('returns the responder identity and tool summaries alongside the assistant message', () => {
    const result: ChatResult = {
      conversationId: CONVERSATION,
      message: {
        id: 'tool-reply',
        role: 'assistant',
        content: 'Your plan is ready.',
        createdAt: '2026-10-27T12:00:00Z',
      },
      mode: 'demo',
      agentId: 'planner',
      tools: [{ name: 'create_plan', summary: 'Organized the request into three steps.' }],
    };
    let received: ChatResult | undefined;
    TestBed.inject(ChatApi).send('Plan my day', null, 'planner').subscribe((response) => (received = response));
    const request = http.expectOne('/api/chat/message');
    expect(request.request.body.agentId).toBe('planner');
    request.flush(result);
    expect(received?.agentId).toBe('planner');
    expect(received?.tools).toEqual(result.tools);
  });

  it('requests a bounded chronological history page and encodes its timestamp cursor', () => {
    localStorage.setItem('dadus-session', SESSION);
    const before = '2026-10-27T11:12:13.1234567+05:30';
    TestBed.inject(ChatApi).history(CONVERSATION, before).subscribe();
    const request = http.expectOne((candidate) => candidate.url === '/api/chat/history');
    expect(request.request.method).toBe('GET');
    expect(request.request.params.get('conversationId')).toBe(CONVERSATION);
    expect(request.request.params.get('limit')).toBe('50');
    expect(request.request.params.get('before')).toBe(before);
    expect(request.request.urlWithParams).toContain('%2B05:30');
    expect(request.request.headers.get('X-Dadus-Session')).toBe(SESSION);
    request.flush({ conversationId: CONVERSATION, messages: [], hasMore: false });
  });

  it('omits the cursor when loading the latest history', () => {
    TestBed.inject(ChatApi).history(CONVERSATION).subscribe();
    const request = http.expectOne((candidate) => candidate.url === '/api/chat/history');
    expect(request.request.params.has('before')).toBe(false);
    request.flush({ conversationId: CONVERSATION, messages: [], hasMore: false });
  });

  it('retains an in-memory session when browser storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage is blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage is blocked', 'SecurityError');
    });
    const api = TestBed.inject(ChatApi);
    api.health().subscribe();
    const health = http.expectOne('/api/health');
    const session = health.request.headers.get('X-Dadus-Session');
    expect(session).toBeTruthy();
    health.flush({ status: 'ok', mode: 'demo', database: 'ready' });
    api.conversations().subscribe();
    const conversations = http.expectOne('/api/chat/conversations');
    expect(conversations.request.headers.get('X-Dadus-Session')).toBe(session);
    conversations.flush({ conversations: [] });
  });

  it('replaces an invalid saved session instead of forwarding arbitrary header text', () => {
    localStorage.setItem('dadus-session', 'not-a-guid');
    TestBed.inject(ChatApi).health().subscribe();
    const request = http.expectOne('/api/health');
    expect(request.request.headers.get('X-Dadus-Session')).not.toBe('not-a-guid');
    expect(localStorage.getItem('dadus-session')).toBe(
      request.request.headers.get('X-Dadus-Session'),
    );
    request.flush({ status: 'ok', mode: 'demo', database: 'ready' });
  });

  it('uses getRandomValues when randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: vi.fn((bytes: Uint8Array) => {
        bytes.fill(0x11);
        return bytes;
      }),
    });
    TestBed.inject(ChatApi).health().subscribe();
    const request = http.expectOne('/api/health');
    expect(request.request.headers.get('X-Dadus-Session')).toBe(
      '11111111-1111-4111-9111-111111111111',
    );
    request.flush({ status: 'ok', mode: 'demo', database: 'ready' });
  });
});
