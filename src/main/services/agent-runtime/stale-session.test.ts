import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetDurableConfig = vi.fn();
const mockUpdateSessionId = vi.fn(async () => {});
vi.mock('../agent-config', () => ({
  getDurableConfig: (...args: unknown[]) => mockGetDurableConfig(...args),
  updateSessionId: (...args: unknown[]) => mockUpdateSessionId(...args),
}));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
const mockBroadcast = vi.fn();
vi.mock('../../util/ipc-broadcast', () => ({
  broadcastToAllWindows: (...args: unknown[]) => mockBroadcast(...args),
}));

import { clearStaleResume, isSessionNotFound } from './stale-session';
import { IPC } from '../../../shared/ipc-channels';

describe('isSessionNotFound', () => {
  it.each([
    ['Codex app-server', 'RPC error: no rollout found for thread id 562a723b-0000-4000-8000-000000000000'],
    ['Codex TUI', 'Error: No saved session found with ID 562a723b-0000-4000-8000-000000000000.'],
    ['Claude Code', 'No conversation found with session ID: 1e339cf2-0000-4000-8000-000000000000'],
    ['generic', 'Error: session 88618d97 not found'],
    ['generic, long form', 'The conversation you asked for does not exist'],
    ['with escape codes', '\x1b[31mNo conversation\x1b[0m found with session ID: x'],
  ])('matches %s', (_label, text) => {
    expect(isSessionNotFound(text)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['undefined', undefined],
    ['other errors', 'RPC request \'session/load\' timed out after 30000ms'],
    ['login errors', 'Error: not logged in. Please run copilot login'],
    ['file not found', 'Error: file not found: src/index.ts'],
  ])('ignores %s', (_label, text) => {
    expect(isSessionNotFound(text)).toBe(false);
  });
});

describe('clearStaleResume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears the resume id and tells the user when it still points at the failed session', async () => {
    mockGetDurableConfig.mockResolvedValue({ id: 'a1', lastSessionId: 'dead' });
    await expect(clearStaleResume('/p', 'a1', 'dead', 'not_found')).resolves.toBe(true);
    expect(mockUpdateSessionId).toHaveBeenCalledWith('/p', 'a1', null);
    expect(mockBroadcast).toHaveBeenCalledWith(IPC.CHAT.RUNTIME_NOTICE, 'a1', expect.objectContaining({
      level: 'warn', code: 'resume_session_missing', message: expect.stringContaining('starts a new session'),
    }));
  });

  it('uses a different notice when the CLI quit without saying why', async () => {
    mockGetDurableConfig.mockResolvedValue({ id: 'a1', lastSessionId: 'dead' });
    await clearStaleResume('/p', 'a1', 'dead', 'exited_early');
    expect(mockBroadcast).toHaveBeenCalledWith(IPC.CHAT.RUNTIME_NOTICE, 'a1', expect.objectContaining({
      code: 'resume_failed', message: expect.stringContaining('Sessions'),
    }));
  });

  it('leaves a newer resume id alone', async () => {
    mockGetDurableConfig.mockResolvedValue({ id: 'a1', lastSessionId: 'newer' });
    await expect(clearStaleResume('/p', 'a1', 'dead', 'not_found')).resolves.toBe(false);
    expect(mockUpdateSessionId).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('does nothing for an unknown agent', async () => {
    mockGetDurableConfig.mockResolvedValue(null);
    await expect(clearStaleResume('/p', 'a1', 'dead', 'not_found')).resolves.toBe(false);
    expect(mockUpdateSessionId).not.toHaveBeenCalled();
  });
});
