import { describe, it, expect, vi, beforeEach } from 'vitest';

const flags = vi.hoisted(() => ({ value: {} as Record<string, boolean> }));
vi.mock('./experimental-settings', () => ({ getSettings: () => flags.value }));
const preview = vi.hoisted(() => ({ value: true }));
vi.mock('./preview-eligible', () => ({ isPreviewEligible: () => preview.value }));
const stored = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('./settings-store', () => ({
  createSettingsStore: () => ({ get: () => stored.value, save: async (v: Record<string, unknown>) => { stored.value = v; } }),
}));

import { resolveRuntimeMode, isChatEnabled } from './chat-runtime-settings';

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
});
