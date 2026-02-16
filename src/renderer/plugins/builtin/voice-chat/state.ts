/**
 * Shared module-level state for the voice chat plugin.
 *
 * SidebarPanel (AgentPicker) and MainPanel (VoiceSession) are rendered in
 * separate React trees, so we use a lightweight pub/sub to coordinate.
 */

import type { VoiceTranscriptEntry, VoiceStatus } from '../../../../shared/voice-types';
import type { AgentInfo } from '../../../../shared/plugin-types';

export const voiceState = {
  selectedAgent: null as AgentInfo | null,
  status: 'idle' as VoiceStatus,
  transcript: [] as VoiceTranscriptEntry[],
  modelsReady: false,
  sessionActive: false,
  listeners: new Set<() => void>(),

  setSelectedAgent(agent: AgentInfo | null): void {
    this.selectedAgent = agent;
    this.notify();
  },

  setStatus(status: VoiceStatus): void {
    this.status = status;
    this.notify();
  },

  setModelsReady(ready: boolean): void {
    this.modelsReady = ready;
    this.notify();
  },

  setSessionActive(active: boolean): void {
    this.sessionActive = active;
    this.notify();
  },

  addTranscriptEntry(entry: VoiceTranscriptEntry): void {
    this.transcript = [...this.transcript, entry];
    this.notify();
  },

  appendToLastAssistant(text: string): void {
    if (this.transcript.length > 0) {
      const last = this.transcript[this.transcript.length - 1];
      if (last.role === 'assistant') {
        this.transcript = [
          ...this.transcript.slice(0, -1),
          { ...last, text: last.text + text },
        ];
        this.notify();
      }
    }
  },

  clearTranscript(): void {
    this.transcript = [];
    this.notify();
  },

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  },

  notify(): void {
    for (const fn of this.listeners) {
      fn();
    }
  },

  reset(): void {
    this.selectedAgent = null;
    this.status = 'idle';
    this.transcript = [];
    this.modelsReady = false;
    this.sessionActive = false;
    this.listeners.clear();
  },
};
