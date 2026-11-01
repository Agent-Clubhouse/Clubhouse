import { describe, it, expect, vi, beforeEach } from 'vitest';

const flags = vi.hoisted(() => ({ value: {} as Record<string, boolean> }));
vi.mock('./experimental-settings', () => ({ getSettings: () => flags.value }));
const preview = vi.hoisted(() => ({ value: true }));
vi.mock('./preview-eligible', () => ({ isPreviewEligible: () => preview.value }));
const stored = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('./settings-store', () => ({
  createSettingsStore: () => ({ get: () => stored.value, save: async (v: Record<string, unknown>) => { stored.value = v; } }),
}));

import { resolveRuntimeMode, isChatEnabled, isCopilotSdkEnabled } from './chat-runtime-settings';

beforeEach(() => { flags.value = {}; stored.value = {}; preview.value = true; });

describe('chat runtime settings', () => {
  it('uses the terminal for everything while the flag is off', () => {
    stored.value = { 'claude-code': { mode: 'chat' } };
    expect(isChatEnabled()).toBe(false);
    expect(resolveRuntimeMode('claude-code', 'chat')).toEqual({ mode: 'terminal' });
  });

  it('ignores the flag outside beta builds', () => {
    flags.value = { chat: true };
    preview.value = false;
    expect(isChatEnabled()).toBe(false);
    expect(resolveRuntimeMode('codex-cli')).toEqual({ mode: 'terminal' });
  });

  it('defaults providers to chat once the flag is on', () => {
    flags.value = { chat: true };
    expect(resolveRuntimeMode('codex-cli')).toEqual({ mode: 'chat' });
  });

  it('honours the provider setting, its driver and a per-agent override', () => {
    flags.value = { chat: true };
    stored.value = { 'claude-code': { mode: 'terminal', driver: 'claude_stream_json' } };
    expect(resolveRuntimeMode('claude-code')).toEqual({ mode: 'terminal', driver: 'claude_stream_json' });
    expect(resolveRuntimeMode('claude-code', 'chat')).toEqual({ mode: 'chat', driver: 'claude_stream_json' });
  });

  describe('the Copilot SDK flag', () => {
    const saved = { 'copilot-cli': { mode: 'chat', driver: 'copilot_sdk' } };

    it('is off by default, and on its own does not choose the driver', () => {
      flags.value = { chat: true };
      expect(isCopilotSdkEnabled()).toBe(false);
      flags.value = { chat: true, copilotSdk: true };
      expect(isCopilotSdkEnabled()).toBe(true);
      expect(resolveRuntimeMode('copilot-cli')).toEqual({ mode: 'chat' });
    });

    it('with the flag off, ignores a saved choice without changing it', () => {
      flags.value = { chat: true };
      stored.value = saved;
      expect(resolveRuntimeMode('copilot-cli')).toEqual({ mode: 'chat' });
      expect(stored.value).toEqual(saved);
    });

    it('with the flag on again, the saved choice applies', () => {
      flags.value = { chat: true, copilotSdk: true };
      stored.value = saved;
      expect(resolveRuntimeMode('copilot-cli')).toEqual({ mode: 'chat', driver: 'copilot_sdk' });
    });

    it('leaves other drivers alone with the flag off', () => {
      flags.value = { chat: true };
      stored.value = { 'copilot-cli': { mode: 'chat', driver: 'copilot_acp' }, 'claude-code': { mode: 'chat', driver: 'claude_stream_json' } };
      expect(resolveRuntimeMode('copilot-cli')).toEqual({ mode: 'chat', driver: 'copilot_acp' });
      expect(resolveRuntimeMode('claude-code')).toEqual({ mode: 'chat', driver: 'claude_stream_json' });
    });

    it('needs Chat, and counts only in beta builds', () => {
      flags.value = { copilotSdk: true };
      stored.value = saved;
      expect(resolveRuntimeMode('copilot-cli')).toEqual({ mode: 'terminal' });
      flags.value = { chat: true, copilotSdk: true };
      preview.value = false;
      expect(isCopilotSdkEnabled()).toBe(false);
    });
  });
});
