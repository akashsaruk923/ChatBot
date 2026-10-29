import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export type ChatMode = 'demo' | 'openai' | 'gemini';
export type AgentId = 'companion' | 'planner' | 'coding';
export type ReplyLanguage = 'auto' | 'en' | 'hi' | 'mr';

export interface AgentDefinition {
  id: AgentId;
  name: string;
  description: string;
  tools: string[];
}

export interface AgentTool {
  name: string;
  summary: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface Health {
  status: string;
  mode: ChatMode;
  database: string;
}

export interface ChatResult {
  conversationId: string;
  message: ChatMessage;
  mode: ChatMode;
  agentId?: AgentId;
  tools?: AgentTool[];
  language?: ReplyLanguage;
}

export interface HistoryResult {
  conversationId: string;
  messages: ChatMessage[];
  hasMore: boolean;
}

const SESSION_KEY = 'dadus-session';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function newSessionId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  // getRandomValues also works in browsers that lack randomUUID.
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function browserSessionId(): string {
  try {
    const saved = globalThis.localStorage.getItem(SESSION_KEY);
    if (saved && GUID.test(saved) && saved !== '00000000-0000-0000-0000-000000000000') {
      return saved;
    }
  } catch {
    // Private browser settings can deny storage. Keep the session in memory.
  }

  const session = newSessionId();
  try {
    globalThis.localStorage.setItem(SESSION_KEY, session);
  } catch {
    // Requests from this service still share the same session until reload.
  }
  return session;
}

@Injectable({ providedIn: 'root' })
export class ChatApi {
  private readonly http = inject(HttpClient);
  private readonly headers = new HttpHeaders({ 'X-Dadus-Session': browserSessionId() });

  health(): Observable<Health> {
    return this.http.get<Health>('/api/health', { headers: this.headers });
  }

  agents(): Observable<{ agents: AgentDefinition[] }> {
    return this.http.get<{ agents: AgentDefinition[] }>('/api/agents', { headers: this.headers });
  }

  conversations(): Observable<{ conversations: ConversationSummary[] }> {
    return this.http.get<{ conversations: ConversationSummary[] }>('/api/chat/conversations', {
      headers: this.headers,
    });
  }

  send(
    message: string,
    conversationId?: string | null,
    agentId: AgentId = 'companion',
    language: ReplyLanguage = 'auto',
  ): Observable<ChatResult> {
    return this.http.post<ChatResult>(
      '/api/chat/message',
      { conversationId: conversationId ?? null, message, agentId, language },
      { headers: this.headers },
    );
  }

  history(conversationId: string, before?: string): Observable<HistoryResult> {
    let params = new HttpParams().set('conversationId', conversationId).set('limit', '50');
    if (before) {
      params = params.set('before', before);
    }
    return this.http.get<HistoryResult>('/api/chat/history', { headers: this.headers, params });
  }
}
