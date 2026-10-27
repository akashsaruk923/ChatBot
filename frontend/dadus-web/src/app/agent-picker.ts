import { Component, computed, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AgentDefinition, AgentId } from './chat-api';

@Component({
  selector: 'dadus-agent-picker',
  imports: [FormsModule],
  templateUrl: './agent-picker.html',
  styleUrl: './agent-picker.css',
})
export class AgentPicker {
  readonly agents = input.required<AgentDefinition[]>();
  readonly selectedId = input<AgentId>('companion');
  readonly busy = input(false);
  readonly loading = input(false);
  readonly notice = input('');
  readonly agentChange = output<string>();
  readonly catalogRetry = output<void>();
  readonly promptSelected = output<string>();
  readonly selectedAgent = computed(() =>
    this.agents().find((agent) => agent.id === this.selectedId()),
  );
}
