import { afterEach, describe, expect, it } from 'vitest';
import { registerBuiltinChatDrivers } from './builtin-chat-drivers';
import { clearChatDrivers, listChatDrivers, resolveChatDriver } from './chat-drivers';

describe('registerBuiltinChatDrivers', () => {
  afterEach(() => clearChatDrivers());

  it('registers both Claude drivers, with the Agent SDK as the claude-code default', () => {
    registerBuiltinChatDrivers();
    expect(listChatDrivers().map((d) => `${d.provider}:${d.id}`)).toEqual([
      'claude-code:claude_agent_sdk',
      'claude-code:claude_stream_json',
    ]);
    expect(resolveChatDriver('claude-code')?.id).toBe('claude_agent_sdk');
    expect(resolveChatDriver('claude-code', 'claude_stream_json')?.id).toBe('claude_stream_json');
    expect(resolveChatDriver('codex-cli')).toBeUndefined();
  });

  it('unregisters what it registered', () => {
    const unregister = registerBuiltinChatDrivers();
    unregister();
    expect(listChatDrivers()).toEqual([]);
  });
});
