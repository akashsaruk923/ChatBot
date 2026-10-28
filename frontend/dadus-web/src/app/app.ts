import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { AgentPicker } from './agent-picker';
import {
  AgentDefinition,
  AgentId,
  AgentTool,
  ChatApi,
  ChatMessage,
  ChatMode,
  ConversationSummary,
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
  private readonly composer = viewChild<ElementRef<HTMLTextAreaElement>>('composer');
  private readonly messageEnd = viewChild<ElementRef<HTMLElement>>('messageEnd');
  private selectionVersion = 0;
  private pendingSequence = 0;
  private catalogVersion = 0;
  private conversationListVersion = 0;
  private healthVersion = 0;
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
  readonly canSend = computed(
    () =>
      !!this.draft().trim() &&
      this.draft().trim().length <= 4000 &&
      !this.sending() &&
      !this.loadingHistory(),
  );
  readonly currentTitle = computed(
    () =>
      this.conversations().find((item) => item.id === this.conversationId())?.title ??
      'A fresh conversation',
  );

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
    if (agent) this.selectedAgentId.set(agent.id);
  }

  toolLabel(name: string): string {
    return (
      ({ calculate: 'Calculation', get_current_time: 'Current time' } as Record<string, string>)[
        name
      ] ?? name
    );
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
    this.draft.set(prompt);
    this.focusComposer();
  }

  onComposerKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  sendMessage(): void {
    if (!this.canSend()) return;
    const message = this.draft().trim();
    const agentId = this.selectedAgentId();
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
      .send(message, this.conversationId(), agentId)
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
                'OpenAI access is not configured. Configure the server API key, or use Development demo mode, restart the API, then reconnect.',
              code: 'key_missing',
            };
          case 'demo_not_allowed':
            return {
              message:
                'Demo mode is available only in Development. Start the local API in Development, or configure OpenAI for this environment, then reconnect.',
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
    // API ProblemDetails contains user-safe text; Angular interpolation escapes it.
    return typeof failure.error?.detail === 'string' ? failure.error.detail : fallback;
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
