import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log-service', () => ({ appLog: vi.fn() }));

import { registerBuiltinChatDrivers } from './builtin-chat-drivers';
import { appLog } from '../log-service';
import { CodexChatDriver } from '../../orchestrators/adapters/codex-chat-driver';
import { clearChatDrivers, listChatDrivers, resolveChatDriver } from './chat-drivers';

describe('registerBuiltinChatDrivers', () => {
  afterEach(() => clearChatDrivers());

  it('registers both Claude drivers, with the Agent SDK as the claude-code default', () => {
    registerBuiltinChatDrivers();
    expect(listChatDrivers().map((d) => `${d.provider}:${d.id}`)).toEqual([
      'claude-code:claude_agent_sdk',
      'claude-code:claude_stream_json',
      'codex-cli:codex_app_server',
      'copilot-cli:copilot_acp',
    ]);
    expect(resolveChatDriver('claude-code')?.id).toBe('claude_agent_sdk');
    expect(resolveChatDriver('claude-code', 'claude_stream_json')?.id).toBe('claude_stream_json');
  });

  it('registers the Codex app-server driver for codex-cli, logging under core:chat:codex', () => {
    registerBuiltinChatDrivers();
    const codex = resolveChatDriver('codex-cli');
    expect(codex).toBeInstanceOf(CodexChatDriver);
    expect(codex?.id).toBe('codex_app_server');
    expect(resolveChatDriver('codex-cli', 'codex_app_server')).toBe(codex);

    // The driver's logger is wired to appLog under its own namespace.
    const onLog = (codex as unknown as { deps: { onLog: (l: 'warn', m: string, meta?: Record<string, unknown>) => void } }).deps.onLog;
    onLog('warn', 'Ignoring extraArgs', { dropped: ['--full-auto'] });
    onLog('warn', 'no meta');
    expect(appLog).toHaveBeenCalledWith('core:chat:codex', 'warn', 'Ignoring extraArgs', { meta: { dropped: ['--full-auto'] } });
    expect(appLog).toHaveBeenCalledWith('core:chat:codex', 'warn', 'no meta', undefined);
  });

  it('registers copilot_acp for the Copilot CLI', () => {
    registerBuiltinChatDrivers();
    expect(resolveChatDriver('copilot-cli')?.id).toBe('copilot_acp');
    // No Copilot SDK driver registered yet, so asking for it falls back to ACP.
    expect(resolveChatDriver('copilot-cli', 'copilot_sdk')?.id).toBe('copilot_acp');
  });

  it('unregisters what it registered', () => {
    const unregister = registerBuiltinChatDrivers();
    unregister();
    expect(listChatDrivers()).toEqual([]);
  });
});
