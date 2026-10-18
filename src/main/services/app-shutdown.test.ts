import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const events: string[] = [];
const mocks = vi.hoisted(() => ({
  killAll: vi.fn(),
  stopAllHeadless: vi.fn(),
  stopAllChat: vi.fn(),
  flushTranscripts: vi.fn(),
  checkpointsIdle: vi.fn(),
  flushConfigs: vi.fn(),
  flushGroups: vi.fn(),
  flushBulletins: vi.fn(),
  restoreAll: vi.fn(),
}));

vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('../telemetry/lifecycle', () => ({ shutdownStarted: vi.fn(), shutdownStep: vi.fn(), shutdownCompleted: vi.fn() }));
vi.mock('./pty-manager', () => ({ killAll: () => mocks.killAll() }));
vi.mock('./headless-manager', () => ({ stopAll: () => mocks.stopAllHeadless() }));
vi.mock('./agent-runtime/chat-spawn', () => ({ stopAllChatAgents: () => mocks.stopAllChat() }));
vi.mock('./agent-runtime/chat-transcript', () => ({ flushAllTranscripts: () => mocks.flushTranscripts() }));
vi.mock('./agent-runtime/checkpoint-tracker', () => ({ whenCheckpointsIdle: () => mocks.checkpointsIdle() }));
vi.mock('./agent-config', () => ({ flushAllAgentConfigs: () => mocks.flushConfigs() }));
vi.mock('./group-project-registry', () => ({ groupProjectRegistry: { flush: () => mocks.flushGroups() } }));
vi.mock('./group-project-bulletin', () => ({ flushAllBulletinBoards: () => mocks.flushBulletins() }));
vi.mock('./config-pipeline', () => ({ restoreAll: () => mocks.restoreAll() }));

import { cancelAppShutdown, runAppShutdown, setShutdownBegin } from './app-shutdown';
import { launchesOpen } from './launch-gate';
import { clearSessionCaptures, trackSessionCapture } from './session-capture-barrier';

const step = (name: string, ms = 0) => async () => {
  if (ms) await new Promise((r) => setTimeout(r, ms));
  events.push(name);
};

beforeEach(() => {
  events.length = 0;
  mocks.killAll.mockImplementation(step('pty-stopped'));
  mocks.stopAllHeadless.mockImplementation(step('headless-stopped'));
  // Ending a chat session starts its native-id write, as chat-spawn's cleanup does.
  mocks.stopAllChat.mockImplementation(async () => {
    events.push('chat-stopped');
    trackSessionCapture('chat-agent', new Promise<void>((r) => setTimeout(r, 20)).then(() => { events.push('chat-session-saved'); }));
  });
  mocks.flushTranscripts.mockImplementation(step('transcripts-flushed'));
  mocks.checkpointsIdle.mockImplementation(step('checkpoints-idle'));
  mocks.flushConfigs.mockImplementation(step('configs-flushed'));
  mocks.flushGroups.mockImplementation(step('groups-flushed'));
  mocks.flushBulletins.mockImplementation(step('bulletins-flushed'));
  mocks.restoreAll.mockImplementation(step('config-restored', 10));
});

afterEach(() => {
  cancelAppShutdown();
  clearSessionCaptures();
  setShutdownBegin(() => undefined);
});

describe('app shutdown (#2053)', () => {
  it('stops terminals, chat and headless, saves session ids before the flush, then awaits the restore', async () => {
    await runAppShutdown('update');
    expect(events.slice(0, 3).sort()).toEqual(['chat-stopped', 'headless-stopped', 'pty-stopped']);
    expect(events.slice(3)).toEqual([
      'chat-session-saved',
      'transcripts-flushed',
      'checkpoints-idle',
      'configs-flushed',
      'groups-flushed',
      'bulletins-flushed',
      'config-restored',
    ]);
  });

  it('closes launches for the whole run and keeps them closed for the exit', async () => {
    let openDuringStop: boolean | undefined;
    mocks.killAll.mockImplementation(async () => { openDuringStop = launchesOpen(); });
    await runAppShutdown('quit');
    expect(openDuringStop).toBe(false);
    expect(launchesOpen()).toBe(false);
    cancelAppShutdown();
    expect(launchesOpen()).toBe(true);
  });

  it('stops timers and servers on quit only', async () => {
    const begin = vi.fn();
    setShutdownBegin(begin);
    await runAppShutdown('update');
    expect(begin).not.toHaveBeenCalled();
    cancelAppShutdown();
    await runAppShutdown('quit');
    expect(begin).toHaveBeenCalledOnce();
  });

  it('an update restart and a quit share one run', async () => {
    await Promise.all([runAppShutdown('update'), runAppShutdown('quit')]);
    expect(mocks.killAll).toHaveBeenCalledOnce();
    expect(mocks.restoreAll).toHaveBeenCalledOnce();
  });

  it('still restores config when a runtime stop fails', async () => {
    mocks.stopAllChat.mockRejectedValue(new Error('driver close failed'));
    await runAppShutdown('quit');
    expect(events.at(-1)).toBe('config-restored');
  });
});
