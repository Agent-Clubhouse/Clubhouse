import type { PluginContext, PluginAPI, PluginModule } from '../../../../shared/plugin-types';
import { voiceState } from './state';
import { AgentPicker } from './components/AgentPicker';
import { VoiceSession } from './components/VoiceSession';

let activeApi: PluginAPI | null = null;

export function activate(_ctx: PluginContext, api: PluginAPI): void {
  activeApi = api;
}

export function deactivate(): void {
  if (voiceState.sessionActive && activeApi) {
    activeApi.voice.endSession();
  }
  activeApi = null;
  voiceState.reset();
}

export const SidebarPanel = AgentPicker;
export const MainPanel = VoiceSession;

// Compile-time type assertion
const _: PluginModule = { activate, deactivate, MainPanel, SidebarPanel };
void _;
