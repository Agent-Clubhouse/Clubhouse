import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUpdateDurableConfig = vi.fn(async () => {});
vi.mock('../agent-config', () => ({ updateDurableConfig: (...a: unknown[]) => mockUpdateDurableConfig(...a) }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
const mockBroadcast = vi.fn();
vi.mock('../../util/ipc-broadcast', () => ({ broadcastToAllWindows: (...a: unknown[]) => mockBroadcast(...a) }));
vi.mock('../clubhouse-mcp/binding-manager', () => ({ bindingManager: { getBindingsForAgent: (id: string) => mockBindings(id) } }));
vi.mock('../group-project-registry', () => ({ groupProjectRegistry: { getSync: (id: string) => mockProjects[id] ?? null } }));
const mockBindings = vi.fn((_id: string): Array<{ targetKind: string; targetId: string }> => []);
const mockProjects: Record<string, { metadata: Record<string, unknown> }> = {};

import { chatSleepInfo, noteKillRequest, recordSleep, sleepInfoForExit, takeKillRequest } from './sleep-reason';
import { waitsOnPollingGroupProject } from './idle-policy';
import { IPC } from '../../../shared/ipc-channels';

const AT = new Date('2026-10-18T03:01:06.000Z');

describe('sleep reasons (#2104)', () => {
  beforeEach(() => { vi.clearAllMocks(); takeKillRequest('a1'); });

  it('keeps one pending kill request per agent until taken', () => {
    noteKillRequest('a1', { trigger: 'agent_tool', by: 'Clubhouse-PM' });
    expect(takeKillRequest('a1')).toEqual({ trigger: 'agent_tool', by: 'Clubhouse-PM' });
    expect(takeKillRequest('a1')).toBeUndefined();
  });

  it('labels an exit by who asked for it, or by the exit code', () => {
    expect(sleepInfoForExit({ trigger: 'user' }, 0, AT)).toEqual({ reason: 'user', at: AT.toISOString() });
    expect(sleepInfoForExit({ trigger: 'agent_tool', by: 'Clubhouse-PM' }, 1, AT)).toEqual({ reason: 'agent', at: AT.toISOString(), by: 'Clubhouse-PM' });
    expect(sleepInfoForExit(undefined, 0, AT)).toEqual({ reason: 'exited', at: AT.toISOString() });
    expect(sleepInfoForExit(undefined, 137, AT)).toEqual({ reason: 'crashed', at: AT.toISOString(), exitCode: 137 });
  });

  it('maps chat session end reasons', () => {
    expect(chatSleepInfo('idle_timeout', 0, undefined, 30 * 60_000, AT)).toEqual({ reason: 'idle', at: AT.toISOString(), idleMinutes: 30 });
    expect(chatSleepInfo('stopped', 0, { trigger: 'agent_tool', by: 'PM' }, undefined, AT)).toMatchObject({ reason: 'agent', by: 'PM' });
    // A stop nobody asked for (quitting, an interrupt falling back to stop) records nothing, as for the terminal.
    expect(chatSleepInfo('stopped', 0, undefined, undefined, AT)).toBeUndefined();
    expect(chatSleepInfo('process_exit', 0, undefined, undefined, AT)).toMatchObject({ reason: 'exited' });
    expect(chatSleepInfo('process_exit', 1, undefined, undefined, AT)).toMatchObject({ reason: 'crashed', exitCode: 1 });
    expect(chatSleepInfo('fallback', 0, undefined, undefined, AT)).toBeUndefined();
  });

  it('saves the reason on the durable config and tells the renderer', async () => {
    const info = { reason: 'idle' as const, at: AT.toISOString(), idleMinutes: 30 };
    await recordSleep('/p', 'a1', info);
    expect(mockUpdateDurableConfig).toHaveBeenCalledWith('/p', 'a1', { lastSleep: info });
    expect(mockBroadcast).toHaveBeenCalledWith(IPC.AGENT.AGENT_SLEEP_REASON, 'a1', info);
  });

  it('does not throw when saving fails', async () => {
    mockUpdateDurableConfig.mockRejectedValueOnce(new Error('disk full'));
    await expect(recordSleep('/p', 'a1', { reason: 'user', at: AT.toISOString() })).resolves.toBeUndefined();
  });
});

describe('waitsOnPollingGroupProject (#2104)', () => {
  it('is true only for an agent bound to a group project with polling on', () => {
    mockProjects.gp1 = { metadata: { pollingEnabled: true } };
    mockProjects.gp2 = { metadata: { pollingEnabled: false } };
    mockBindings.mockReturnValueOnce([{ targetKind: 'group-project', targetId: 'gp1' }]);
    expect(waitsOnPollingGroupProject('a1')).toBe(true);
    mockBindings.mockReturnValueOnce([{ targetKind: 'group-project', targetId: 'gp2' }, { targetKind: 'agent', targetId: 'gp1' }]);
    expect(waitsOnPollingGroupProject('a1')).toBe(false);
    mockBindings.mockReturnValueOnce([{ targetKind: 'group-project', targetId: 'unknown' }]);
    expect(waitsOnPollingGroupProject('a1')).toBe(false);
    expect(waitsOnPollingGroupProject('a1')).toBe(false);
  });
});
