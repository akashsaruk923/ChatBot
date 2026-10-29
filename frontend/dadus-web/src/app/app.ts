import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { AgentPicker } from './agent-picker';
import { VoiceService } from './voice.service';
import {
  AgentDefinition,
  AgentId,
  AgentTool,
  ChatApi,
  ChatMessage,
  ChatMode,
  ConversationSummary,
  ReplyLanguage,
} from './chat-api';

const COMPANION: AgentDefinition = {
  id: 'companion',
  name: 'Companion',
  description: 'A friendly companion for everyday questions and conversation.',
  tools: ['calculate', 'get_current_time'],
};
interface AgentRun {
  agentName: string;
  mode: ChatMode;
  tools: AgentTool[];
}

@Component({
  selector: 'app-root',
  imports: [DatePipe, FormsModule, AgentPicker],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  private readonly api = inject(ChatApi);
  private readonly destroyRef = inject(DestroyRef);
  readonly voice = inject(VoiceService);
  private readonly composer = viewChild<ElementRef<HTMLTextAreaElement>>('composer');
  private readonly messageEnd = viewChild<ElementRef<HTMLElement>>('messageEnd');
  private selectionVersion = 0;
  private pendingSequence = 0;
  private catalogVersion = 0;
  private conversationListVersion = 0;
  private healthVersion = 0;
  private voiceTurnVersion = 0;
  readonly agents = signal<AgentDefinition[]>([COMPANION]);
  readonly selectedAgentId = signal<AgentId>('companion');
  readonly loadingAgents = signal(false);
  readonly agentCatalogError = signal('');
  readonly lastRun = signal<AgentRun | null>(null);
  readonly draft = signal('');
  readonly messages = signal<ChatMessage[]>([]);
  readonly conversations = signal<ConversationSummary[]>([]);
  readonly conversationId = signal<string | null>(null);
  readonly mode = signal<ChatMode | null>(null);
  readonly connected = signal(false);
  readonly checkingConnection = signal(false);
  readonly connectionIssue = signal(
    'The API is not ready yet. Confirm the backend is running on port 5088 and check its terminal, then reconnect. Your draft will stay here.',
  );
  readonly connectionCode = signal('');
  readonly sending = signal(false);
  readonly loadingHistory = signal(false);
  readonly loadingOlder = signal(false);
  readonly hasMore = signal(false);
  readonly sidebarOpen = signal(false);
  readonly error = signal('');
  readonly historyError = signal('');
  readonly dictationNotice = signal('');
  readonly readingMessageId = signal<string | null>(null);
  readonly voiceChatActive = signal(false);
  readonly voiceChatFinishing = signal(false);
  readonly speechActive = computed(() => this.voice.speaking() || this.voice.preparingSpeech());
  readonly replyLanguage = computed<ReplyLanguage>(() => {
    if (this.voice.language() === 'en-IN') return 'en';
    if (this.voice.language() === 'hi-IN') return 'hi';
    return 'mr';
  });
  readonly canSend = computed(
    () =>
      !!this.draft().trim() &&
      this.draft().trim().length <= 4000 &&
      !this.sending() &&
      !this.loadingHistory() &&
      !this.voiceChatActive(),
  );
  readonly currentTitle = computed(
    () =>
      this.conversations().find((item) => item.id === this.conversationId())?.title ??
      'A fresh conversation',
  );

  constructor() {
    effect(() => {
      // Errors and the recording limit can end capture without a Finish action.
      if (this.voiceChatActive() && !this.voice.listening()) this.clearVoiceTurn();
    });
    this.destroyRef.onDestroy(() => this.stopVoice());
  }

  ngOnInit(): void {
    this.checkConnection();
  }

  checkConnection(): void {
    const version = ++this.healthVersion;
    this.checkingConnection.set(true);
    this.api
      .health()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (health) => {
          if (version !== this.healthVersion) return;
          this.connectionIssue.set('');
          this.connectionCode.set('');
          this.connected.set(true);
          this.mode.set(health.mode);
          this.checkingConnection.set(false);
        },
        error: (failure: HttpErrorResponse) => {
          if (version !== this.healthVersion) return;
          const issue = this.healthIssue(failure);
          this.connectionIssue.set(`${issue.message} Your draft will stay here.`);
          this.connectionCode.set(issue.code);
          this.connected.set(false);
          this.checkingConnection.set(false);
        },
      });
    this.refreshConversations();
    this.loadAgents();
  }

  loadAgents(): void {
    const version = ++this.catalogVersion;
    this.loadingAgents.set(true);
    this.api
      .agents()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => {
          if (version !== this.catalogVersion) return;
          const agents = result.agents.filter((agent) =>
            ['companion', 'planner', 'coding'].includes(agent.id),
          );
          if (!agents.some((agent) => agent.id === 'companion')) agents.unshift(COMPANION);
          this.agents.set(agents);
          if (!agents.some((agent) => agent.id === this.selectedAgentId()))
            this.selectedAgentId.set('companion');
          this.agentCatalogError.set('');
          this.loadingAgents.set(false);
        },
        error: () => {
          if (version !== this.catalogVersion) return;
          this.agents.set([COMPANION]);
          this.selectedAgentId.set('companion');
          this.agentCatalogError.set(
            'Agent choices could not be loaded. Companion is still available.',
          );
          this.loadingAgents.set(false);
        },
      });
  }

  selectAgent(id: string): void {
    if (this.sending()) return;
    const agent = this.agents().find((item) => item.id === id);
    if (agent) {
      this.stopVoice();
      this.selectedAgentId.set(agent.id);
    }
  }

  toolLabel(name: string): string {
    return (
      ({ calculate: 'Calculation', get_current_time: 'Current time' } as Record<string, string>)[
        name
      ] ?? name
    );
  }

  modeLabel(mode: ChatMode | null): string {
    if (mode === 'demo') return 'Demo';
    if (mode === 'gemini') return 'Gemini';
    if (mode === 'openai') return 'OpenAI';
    return 'AI provider';
  }

  welcomeTitle(): string {
    if (this.replyLanguage() === 'en') return 'What would you like to talk about?';
    if (this.replyLanguage() === 'hi') return 'आज क्या बात करें?';
    return 'आज काय बोलूया?';
  }

  welcomeSubtitle(): string {
    if (this.replyLanguage() === 'en') return 'Talk it through in Marathi, Hindi or English.';
    if (this.replyLanguage() === 'hi') return 'मराठी, हिन्दी या English में खुलकर बात करें.';
    return 'मराठी, हिन्दी किंवा Englishमध्ये मनमोकळं बोल.';
  }

  composerPlaceholder(): string {
    if (this.replyLanguage() === 'en') return 'Message DADUS';
    if (this.replyLanguage() === 'hi') return 'मन की बात कहें…';
    return 'मनातलं बोल…';
  }

  languageHelp(): string {
    if (this.replyLanguage() === 'en')
      return 'Language sets AI replies, microphone and speech. Spoken voices depend on your browser.';
    if (this.replyLanguage() === 'hi')
      return 'यह भाषा AI के जवाब, माइक और आवाज़ के लिए है। बोलने वाली आवाज़ आपके browser पर निर्भर है।';
    return 'ही भाषा AIची उत्तरं, माइक आणि आवाजासाठी आहे. आवाजाची उपलब्धता तुमच्या browserवर अवलंबून आहे.';
  }

  languageLabel(language: string): string {
    if (language === 'en-IN') return 'English';
    if (language === 'hi-IN') return 'हिन्दी';
    return 'मराठी';
  }

  private refreshConversations(): void {
    const version = ++this.conversationListVersion;
    this.api
      .conversations()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => {
          if (version !== this.conversationListVersion) return;
          this.conversations.set(result.conversations);
          this.historyError.set('');
        },
        error: () => {
          if (version !== this.conversationListVersion) return;
          this.historyError.set('Conversation history could not be loaded.');
        },
      });
  }

  newConversation(): void {
    if (this.sending()) return;
    this.stopVoice();
    this.selectionVersion++;
    this.conversationId.set(null);
    this.messages.set([]);
    this.lastRun.set(null);
    this.hasMore.set(false);
    this.loadingHistory.set(false);
    this.loadingOlder.set(false);
    this.error.set('');
    this.sidebarOpen.set(false);
    this.focusComposer();
  }

  selectConversation(conversation: ConversationSummary): void {
    if (this.sending()) return;
    this.stopVoice();
    const version = ++this.selectionVersion;
    this.conversationId.set(conversation.id);
    this.messages.set([]);
    this.lastRun.set(null);
    this.hasMore.set(false);
    this.loadingHistory.set(true);
    this.loadingOlder.set(false);
    this.error.set('');
    this.sidebarOpen.set(false);
    this.api
      .history(conversation.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => {
          if (version !== this.selectionVersion) return;
          this.messages.set(result.messages);
          this.hasMore.set(result.hasMore);
          this.loadingHistory.set(false);
          this.scrollToEnd();
        },
        error: (failure: HttpErrorResponse) => {
          if (version !== this.selectionVersion) return;
          this.loadingHistory.set(false);
          this.error.set(
            this.errorMessage(
              failure,
              'This conversation could not be loaded. Try selecting it again.',
            ),
          );
        },
      });
  }

  loadOlder(): void {
    const id = this.conversationId();
    const before = this.messages()[0]?.createdAt;
    if (!id || !before || this.loadingOlder() || this.sending()) return;
    this.stopVoice();
    const version = this.selectionVersion;
    this.loadingOlder.set(true);
    this.api
      .history(id, before)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => {
          if (version !== this.selectionVersion) return;
          this.messages.update((current) => [
            ...result.messages.filter((older) => !current.some((item) => item.id === older.id)),
            ...current,
          ]);
          this.hasMore.set(result.hasMore);
          this.loadingOlder.set(false);
        },
        error: (failure: HttpErrorResponse) => {
          if (version !== this.selectionVersion) return;
          this.loadingOlder.set(false);
          this.error.set(
            this.errorMessage(failure, 'Older messages could not be loaded. Please try again.'),
          );
        },
      });
  }

  usePrompt(prompt: string): void {
    if (this.sending() || this.loadingHistory()) return;
    this.stopVoice();
    this.draft.set(prompt);
    this.focusComposer();
  }

  onComposerKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (this.voiceChatActive()) this.finishVoiceChat();
      else this.sendMessage();
    }
  }

  sendMessage(): void {
    if (!this.canSend()) return;
    this.stopVoice();
    const message = this.draft().trim();
    const agentId = this.selectedAgentId();
    const language = this.replyLanguage();
    const pendingId = `pending-${++this.pendingSequence}`;
    this.messages.update((items) => [
      ...items,
      { id: pendingId, role: 'user', content: message, createdAt: new Date().toISOString() },
    ]);
    this.draft.set('');
    this.error.set('');
    this.lastRun.set(null);
    this.sending.set(true);
    this.scrollToEnd();
    this.api
      .send(message, this.conversationId(), agentId, language)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => {
          this.conversationId.set(result.conversationId);
          this.messages.update((items) => [...items, result.message]);
          this.mode.set(result.mode);
          const responseAgentId = result.agentId ?? agentId;
          const agentName =
            this.agents().find((agent) => agent.id === responseAgentId)?.name ??
            (
              {
                companion: 'Companion',
                planner: 'Planner',
                coding: 'Coding helper',
              } satisfies Record<AgentId, string>
            )[responseAgentId];
          this.lastRun.set({ agentName, mode: result.mode, tools: result.tools ?? [] });
          ++this.healthVersion;
          this.checkingConnection.set(false);
          this.connectionIssue.set('');
          this.connectionCode.set('');
          this.connected.set(true);
          this.sending.set(false);
          if (this.voice.readReplies()) {
            this.readingMessageId.set(result.message.id);
            this.voice.readReply(result.message.content);
          }
          this.refreshConversations();
          this.scrollToEnd();
          this.focusComposer();
        },
        error: (failure: HttpErrorResponse) => {
          this.messages.update((items) => items.filter((item) => item.id !== pendingId));
          this.draft.set(message);
          this.sending.set(false);
          this.error.set(
            this.errorMessage(
              failure,
              'Your message was not sent. Your draft is still here; please try again.',
            ),
          );
          this.focusComposer();
        },
      });
  }

  toggleDictation(): void {
    if (this.sending() || this.loadingHistory() || this.voiceChatActive()) return;
    this.dictationNotice.set('');
    if (this.voice.listening()) {
      this.voice.stopListening();
      return;
    }
    // A microphone action also opts into spoken replies; the checkbox can
    // still disable reading before or while waiting for the response.
    this.voice.setReadReplies(true);
    const version = this.selectionVersion;
    this.readingMessageId.set(null);
    this.voice.startListening((transcript) => {
      if (version !== this.selectionVersion || this.sending() || this.loadingHistory()) return;
      this.appendTranscript(transcript);
    });
  }

  toggleVoiceChat(): void {
    if (this.sending() || this.loadingHistory()) return;
    if (this.voiceChatActive()) {
      this.finishVoiceChat();
      return;
    }
    if (this.voice.listening()) {
      this.voice.stopListening();
      return;
    }
    this.startVoiceChat();
  }

  startVoiceChat(): void {
    if (this.sending() || this.loadingHistory() || this.voiceChatActive()) return;
    this.stopVoice();
    this.voice.setReadReplies(true);
    const version = ++this.voiceTurnVersion;
    const selection = this.selectionVersion;
    let heardSpeech = false;
    let truncated = false;
    this.voiceChatActive.set(true);
    this.voice.startListening(
      (transcript) => {
        if (
          version !== this.voiceTurnVersion ||
          selection !== this.selectionVersion ||
          this.sending()
        )
          return;
        if (transcript.trim()) heardSpeech = true;
        if (!this.appendTranscript(transcript)) truncated = true;
      },
      () => {
        if (version !== this.voiceTurnVersion || !this.voiceChatActive()) return;
        this.clearVoiceTurn();
        if (truncated)
          this.dictationNotice.set(
            'The 4,000-character limit was reached. Review the captured draft, then press Send.',
          );
        else if (heardSpeech && this.draft().trim()) this.sendMessage();
        else
          this.dictationNotice.set(
            'No speech was captured. Your draft is still here; click Mic to try again.',
          );
      },
      { autoFinishAfterSilenceMs: 1800 },
    );
  }

  finishVoiceChat(): void {
    if (!this.voiceChatActive() || this.voiceChatFinishing()) return;
    this.voiceChatFinishing.set(true);
    this.voice.stopListening();
  }

  cancelVoiceChat(): void {
    this.stopVoice();
    this.dictationNotice.set('Voice chat cancelled. Your captured words are still in the draft.');
  }

  private appendTranscript(transcript: string): boolean {
    const words = transcript.trim();
    if (!words) return true;
    const current = this.draft();
    const next = `${current}${current && !/\s$/.test(current) ? ' ' : ''}${words}`;
    let accepted = next.slice(0, 4000);
    if (/[\uD800-\uDBFF]$/.test(accepted)) accepted = accepted.slice(0, -1);
    this.draft.set(accepted);
    if (next.length > 4000)
      this.dictationNotice.set(
        'The 4,000-character limit was reached. Review your draft before sending.',
      );
    this.focusComposer();
    return next.length <= 4000;
  }

  changeVoiceLanguage(language: string): void {
    this.clearVoiceTurn();
    this.dictationNotice.set('');
    this.readingMessageId.set(null);
    this.voice.setLanguage(language);
  }

  changeSpeechVoice(value: string): void {
    this.stopVoice();
    this.voice.setSpeechVoice(value);
  }

  setReadReplies(enabled: boolean): void {
    this.voice.setReadReplies(enabled);
    if (!enabled) this.readingMessageId.set(null);
  }

  readMessage(message: ChatMessage): void {
    if (message.role !== 'assistant' || this.sending() || this.loadingHistory()) return;
    if (this.speechActive() && this.readingMessageId() === message.id) {
      this.stopReading();
      return;
    }
    this.readingMessageId.set(message.id);
    this.voice.speak(message.content);
  }

  testVoice(): void {
    this.clearVoiceTurn();
    this.readingMessageId.set(null);
    this.voice.testVoice();
  }

  stopReading(): void {
    this.voice.stopSpeaking();
    this.readingMessageId.set(null);
  }

  private stopVoice(): void {
    this.clearVoiceTurn();
    this.voice.stopAll();
    this.dictationNotice.set('');
    this.readingMessageId.set(null);
  }

  private clearVoiceTurn(): void {
    ++this.voiceTurnVersion;
    this.voiceChatActive.set(false);
    this.voiceChatFinishing.set(false);
  }

  private healthIssue(failure: HttpErrorResponse): { message: string; code: string } {
    if (failure.status === 0) {
      return {
        message:
          'Cannot reach the API on port 5088. Start the backend, confirm it is listening on port 5088, and check the frontend proxy, then reconnect.',
        code: '',
      };
    }
    const problem: unknown = failure.error;
    // Only recognized ProblemDetails codes select fixed recovery text. Never echo
    // response bodies, arbitrary details, stack traces, connection strings or keys.
    if (problem && typeof problem === 'object' && !Array.isArray(problem)) {
      const value = problem as Record<string, unknown>;
      if (
        value['status'] === failure.status &&
        typeof value['title'] === 'string' &&
        typeof value['detail'] === 'string'
      ) {
        switch (value['code']) {
          case 'database_unavailable':
            return {
              message:
                'The database is not ready. Start SQL Server, check the backend connection string, and run the database migrations, then reconnect.',
              code: 'database_unavailable',
            };
          case 'key_missing':
            return {
              message:
                'AI access is not configured. Configure the server API key for the selected provider, or use Development demo mode, restart the API, then reconnect.',
              code: 'key_missing',
            };
          case 'invalid_api_key_configuration':
            return {
              message:
                'The selected provider API key format is invalid. Re-enter only the key value in the backend settings, without a Bearer prefix or extra whitespace, restart the API, then reconnect.',
              code: 'invalid_api_key_configuration',
            };
          case 'demo_not_allowed':
            return {
              message:
                'Demo mode is available only in Development. Start the local API in Development, or configure Gemini or OpenAI for this environment, then reconnect.',
              code: 'demo_not_allowed',
            };
        }
      }
    }
    return {
      message:
        'The API is not ready yet. Confirm the backend is running on port 5088 and check its terminal, then reconnect.',
      code: '',
    };
  }

  private errorMessage(failure: HttpErrorResponse, fallback: string): string {
    if (failure.status === 429)
      return 'A little breather: too many messages were sent. Your draft is saved; try again in a minute.';
    if (failure.status === 0)
      return 'Cannot reach the API on port 5088. Start the backend, then reconnect and retry. Your draft is still here.';
    const problem: unknown = failure.error;
    if (problem && typeof problem === 'object' && !Array.isArray(problem)) {
      const value = problem as Record<string, unknown>;
      if (
        value['status'] === failure.status &&
        typeof value['title'] === 'string' &&
        typeof value['detail'] === 'string'
      ) {
        if (value['code'] === 'provider_service_unavailable') {
          const provider =
            this.mode() === 'gemini'
              ? 'Gemini'
              : this.mode() === 'openai'
                ? 'OpenAI'
                : 'AI provider';
          const status = value['providerStatus'];
          const statusLabel =
            typeof status === 'number' && Number.isInteger(status) && status >= 500 && status <= 599
              ? ` (HTTP ${status})`
              : '';
          return `${provider} returned a service error${statusLabel}. Please try again shortly. Your draft is still here.`;
        }
        if (
          this.mode() === 'gemini' &&
          (value['code'] === 'provider_quota_exceeded' || value['code'] === 'provider_rate_limited')
        ) {
          return 'Gemini free-tier quota or rate limit was reached. Check Google AI Studio limits and retry when the allowance resets. Your draft is still here.';
        }
        const guidance: Record<string, string> = {
          key_missing:
            'AI access is not configured. Set the API key in the backend for the selected provider, restart it, then reconnect. Your draft is still here.',
          invalid_api_key_configuration:
            'The selected provider API key format is invalid. Re-enter only the key value in the backend settings, without a Bearer prefix or extra whitespace, restart the API, then retry. Your draft is still here.',
          provider_authentication_failed:
            'The AI provider rejected the backend API key. Check or replace it in the backend settings, restart the API, then retry. Your draft is still here.',
          provider_access_denied:
            'The AI provider denied access. Check the API project and model permissions, then retry. Your draft is still here.',
          provider_quota_exceeded:
            'The AI provider quota is exhausted. Check available quota, API billing and project limits, then retry. Your draft is still here.',
          provider_rate_limited:
            'The AI provider is receiving too many requests. Wait a little, then retry. Your draft is still here.',
          provider_model_unavailable:
            'The configured AI model is unavailable to this project. Check the backend model setting and project access, then retry. Your draft is still here.',
          provider_unavailable:
            'The AI provider is unavailable. Check the backend internet connection and try again shortly. Your draft is still here.',
          provider_dns_failed:
            'The backend could not resolve the AI provider address. Check the backend DNS settings with your network administrator, then retry. Your draft is still here.',
          provider_connection_failed:
            'The backend could not connect to the AI provider. Check network access for the .NET backend with your network administrator, then retry. Your draft is still here.',
          provider_tls_failed:
            'The backend could not verify the AI provider TLS connection. Check the PC date, time and trusted certificates with your network administrator, then retry. Your draft is still here.',
          provider_proxy_failed:
            'The backend could not connect through its configured proxy. Check the backend proxy settings and authentication with your network administrator, then retry. Your draft is still here.',
          provider_timeout:
            'The AI provider took too long to reply. Please retry. Your draft is still here.',
          provider_failed:
            'The AI provider rejected the request. Check the backend API key, model access and provider quota, then retry. Your draft is still here.',
          invalid_provider_response:
            'The AI provider returned an unusable response. Please retry. Your draft is still here.',
          incomplete_provider_response:
            'The AI provider did not finish its reply. Please retry with a smaller request. Your draft is still here.',
          agent_limit_exceeded:
            'The agent reached its tool-use limit. Please try a smaller request. Your draft is still here.',
          database_unavailable:
            'Conversation storage is unavailable. Check SQL Server and run the database migrations before retrying. Your draft is still here.',
          demo_not_allowed:
            'Demo mode requires Development. Start the backend in Development or configure Gemini or OpenAI, then reconnect.',
          invalid_chat_mode:
            'The backend chat mode is invalid. Select Demo, Gemini or OpenAI, restart the API, then reconnect.',
          invalid_message: 'Enter a message between 1 and 4,000 characters.',
          invalid_agent: 'Choose one of the available agents, then retry.',
          invalid_language:
            'Choose English, हिन्दी or मराठी from Language, then retry. Your draft is still here.',
          invalid_request: 'The request could not be accepted. Check your message and try again.',
          invalid_conversation: 'Start a new conversation, then retry. Your draft is still here.',
          conversation_not_found:
            'This conversation is unavailable. Start a new conversation. Your draft is still here.',
        };
        if (typeof value['code'] === 'string' && Object.hasOwn(guidance, value['code']))
          return guidance[value['code']];
      }
    }
    if (failure.status === 502)
      return 'The request failed. Check the backend terminal on port 5088, then reconnect and retry. Your draft is still here.';
    return fallback;
  }
  private focusComposer(): void {
    setTimeout(() => this.composer()?.nativeElement.focus());
  }
  private scrollToEnd(): void {
    setTimeout(() =>
      this.messageEnd()?.nativeElement.scrollIntoView?.({ behavior: 'smooth', block: 'end' }),
    );
  }
}
