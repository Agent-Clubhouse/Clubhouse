import { describe, it, expect, vi, beforeEach } from 'vitest';

const flags = vi.hoisted(() => ({ value: {} as Record<string, boolean> }));
vi.mock('./experimental-settings', () => ({
  getSettings: () => flags.value,
  isGraduatedFeatureOn: (key: string) => (flags.value as Record<string, boolean>)[key] !== false,
}));
const preview = vi.hoisted(() => ({ value: true }));
vi.mock('./preview-eligible', () => ({ isPreviewEligible: () => preview.value }));
const stored = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('./settings-store', () => ({
  peekStoredSettingsSync: () => 'missing',
  createSettingsStore: () => ({ get: () => stored.value, save: async (v: Record<string, unknown>) => { stored.value = v; } }),
}));

import { resolveRuntimeMode, isChatEnabled, isCopilotSdkEnabled } from './chat-runtime-settings';

beforeEach(() => { flags.value = {}; stored.value = {}; preview.value = true; });

describe('chat runtime settings', () => {
  it('uses the terminal for everything, overrides included, while the flag is saved off', () => {
    flags.value = { chat: false };
    stored.value = { 'claude-code': { mode: 'chat' } };
    expect(isChatEnabled()).toBe(false);
    expect(resolveRuntimeMode('claude-code', 'chat')).toEqual({ mode: 'terminal' });
  });

  it.each([[true], [false]])('is the same in every build (preview-eligible: %s)', (eligible) => {
    preview.value = eligible;
    expect(isChatEnabled()).toBe(true);
    expect(resolveRuntimeMode('codex-cli')).toEqual({ mode: 'chat' });
    flags.value = { chat: false };
    expect(isChatEnabled()).toBe(false);
    expect(resolveRuntimeMode('codex-cli')).toEqual({ mode: 'terminal' });
  });

  it('defaults providers to chat with the flag missing or saved on', () => {
    expect(resolveRuntimeMode('codex-cli')).toEqual({ mode: 'chat' });
    flags.value = { chat: true };
    expect(resolveRuntimeMode('codex-cli')).toEqual({ mode: 'chat' });
  });

  it('lets a saved agent override and provider choice win over the default', () => {
    stored.value = { 'claude-code': { mode: 'terminal' } };
    expect(resolveRuntimeMode('claude-code')).toEqual({ mode: 'terminal' });
    expect(resolveRuntimeMode('claude-code', 'chat')).toEqual({ mode: 'chat' });
    stored.value = {};
    expect(resolveRuntimeMode('claude-code', 'terminal')).toEqual({ mode: 'terminal' });
  });

  it('honours the provider setting, its driver and a per-agent override', () => {
    flags.value = { chat: true };
    stored.value = { 'claude-code': { mode: 'terminal', driver: 'claude_stream_json' } };
    expect(resolveRuntimeMode('claude-code')).toEqual({ mode: 'terminal', driver: 'claude_stream_json' });
    expect(resolveRuntimeMode('claude-code', 'chat')).toEqual({ mode: 'chat', driver: 'claude_stream_json' });
  });

  describe('SDK standard and explicit legacy ACP', () => {
    it.each([true, false])('defaults to SDK in preview=%s regardless of old flags and preferences', (eligible) => {
      preview.value = eligible;
      for (const oldFlag of [undefined, false, true]) {
        for (const driver of [undefined, 'copilot_acp', 'copilot_sdk']) {
          flags.value = oldFlag === undefined ? {} : { copilotSdk: oldFlag };
          stored.value = { 'copilot-cli': { mode: 'chat', driver } };
          const original = structuredClone(stored.value);
          expect(isCopilotSdkEnabled()).toBe(true);
          expect(resolveRuntimeMode('copilot-cli')).toEqual({ mode: 'chat', driver: 'copilot_sdk' });
          expect(stored.value).toEqual(original);
        }
      }
    });

    it('only the new legacy flag opts in, preserving unrelated preferences and per-agent mode', () => {
      stored.value = { 'copilot-cli': { mode: 'terminal', driver: 'copilot_sdk' }, 'claude-code': { mode: 'chat', driver: 'claude_stream_json' } };
      const original = structuredClone(stored.value);
      for (const enabled of [true, false, true]) {
        flags.value = { copilotLegacyAcp: enabled, copilotSdk: false };
        expect(resolveRuntimeMode('copilot-cli', 'chat')).toEqual({ mode: 'chat', driver: enabled ? 'copilot_acp' : 'copilot_sdk' });
        expect(resolveRuntimeMode('copilot-cli').mode).toBe('terminal');
        expect(resolveRuntimeMode('claude-code')).toEqual({ mode: 'chat', driver: 'claude_stream_json' });
        expect(stored.value).toEqual(original);
      }
    });

    it('keeps the legacy experimental flag gated and honors Chat off', () => {
      flags.value = { chat: false, copilotLegacyAcp: true };
      expect(resolveRuntimeMode('copilot-cli')).toEqual({ mode: 'terminal' });
      flags.value.chat = true;
      preview.value = false;
      expect(resolveRuntimeMode('copilot-cli')).toEqual({ mode: 'chat', driver: 'copilot_sdk' });
    });
  });
});
