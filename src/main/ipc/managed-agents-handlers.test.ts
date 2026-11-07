import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A window can't claim to be the Dispatcher: the part and template handlers drop `actor` (#2900, D90). */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  service: {
    createPart: vi.fn(async (input: unknown) => input),
    updatePart: vi.fn(async (input: unknown) => input),
    saveTemplate: vi.fn(async (input: unknown) => input),
  },
}));

vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => { h.handlers.set(channel, fn); } } }));
vi.mock('../services/managed-agents', () => ({
  managedAgents: () => h.service, dismissMigrationNotice: vi.fn(), restartManagedAgent: vi.fn(), statusFor: vi.fn(), isAgentWorking: vi.fn(),
}));
vi.mock('../services/managed-agents/agents', () => ({ applyManagedSettings: vi.fn(), convertToManaged: vi.fn(), createManagedAgent: vi.fn(), previewConvert: vi.fn() }));
vi.mock('../services/managed-agents/auto-migrate', () => ({ withSwitchLock: vi.fn() }));
vi.mock('../services/managed-agents/delivery', () => ({ previewManagedSetup: vi.fn() }));
vi.mock('../services/agent-config', () => ({}));
vi.mock('../services/agent-system', () => ({ resolveOrchestrator: vi.fn() }));
vi.mock('../services/log-service', () => ({ appLog: vi.fn() }));
vi.mock('../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

import { IPC } from '../../shared/ipc-channels';
import { registerManagedAgentsHandlers, withoutActor } from './managed-agents-handlers';

beforeEach(() => {
  h.handlers.clear();
  for (const fn of Object.values(h.service)) fn.mockClear();
  registerManagedAgentsHandlers();
});

const call = (channel: string, ...args: unknown[]) => h.handlers.get(channel)!({}, ...args);

describe('the window never sets who made a change', () => {
  it('drops actor from a part create and update, and a template save', async () => {
    await call(IPC.MANAGED.CREATE_PART, { name: 'X', content: { kind: 'block', content: 'x' }, actor: 'Dispatcher' });
    expect(h.service.createPart).toHaveBeenCalledWith({ name: 'X', content: { kind: 'block', content: 'x' } });
    await call(IPC.MANAGED.UPDATE_PART, { id: 'p', expectedRevision: 1, expectedName: 'X', name: 'Y', actor: 'Dispatcher' });
    expect(h.service.updatePart).toHaveBeenCalledWith({ id: 'p', expectedRevision: 1, expectedName: 'X', name: 'Y' });
    await call(IPC.MANAGED.SAVE_TEMPLATE, { name: 'T', description: '', setup: { blocks: [], skills: [], mcps: [] }, settings: {}, actor: 'Dispatcher' });
    expect(h.service.saveTemplate).toHaveBeenCalledWith({ name: 'T', description: '', setup: { blocks: [], skills: [], mcps: [] }, settings: {} });
  });

  it('withoutActor leaves everything else as it was', () => {
    expect(withoutActor({ a: 1, actor: 'x' })).toEqual({ a: 1 });
    expect(withoutActor({ a: 1 })).toEqual({ a: 1 });
  });
});
