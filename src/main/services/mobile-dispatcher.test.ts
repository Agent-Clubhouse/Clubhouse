import { beforeEach, describe, expect, it, vi } from 'vitest';

const S = vi.hoisted(() => ({
  flagOn: true, enabled: false, newLayout: true, running: false, classicUnsaved: false,
  config: { id: 'durable_d', name: 'Dispatcher', color: 'indigo', createdAt: '2026-01-01' } as Record<string, unknown> | null,
}));

vi.mock('./dispatcher/dispatcher-service', () => {
  const state = () => ({ enabled: S.flagOn && S.enabled, flagOn: S.flagOn, savedOn: S.enabled, mcpOff: !S.flagOn, classic: !S.newLayout, running: S.running,
    offReason: S.flagOn && S.enabled ? null : S.enabled ? 'mcp_off' : S.classicUnsaved ? 'classic_layout' : 'switch_off', agentId: (S.config?.id as string) ?? null,
    path: S.config ? '/base/dispatcher' : null, config: S.config });
  return {
    DISPATCHER_NAME: 'Dispatcher',
    getDispatcherPath: () => '/base/dispatcher',
    isDispatcherAgentId: (id?: string) => !!id && id === S.config?.id,
    isDispatcherEnabled: () => S.flagOn && S.enabled,
    getDispatcherState: state,
    setDispatcherEnabled: vi.fn(async (on: boolean) => { S.enabled = on; return state(); }),
  };
});
vi.mock('../window-chrome', () => ({ newChromeEnabled: () => S.newLayout }));

import * as dispatcher from './dispatcher/dispatcher-service';
import { MobileControlError } from './mobile-control';
import { MCP_REQUIRED_MESSAGE } from '../../shared/orchestration-policy';
import {
  activeDispatcher, assertDispatcherCommand, dispatcherCapability, dispatcherChange, dispatcherCommandsWhileOff, dispatcherFolderProject, dispatcherNothingPending,
  dispatcherOffFields, dispatcherShellProject, isDisabledDispatcherId, setDispatcherEnabledFromPhone,
} from './mobile-dispatcher';

const allow = () => {};
async function refusal(promise: Promise<unknown>) {
  try { await promise; } catch (e) { return e as { code: string; statusCode: number }; }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  Object.assign(S, { flagOn: true, enabled: false, newLayout: true, running: false, classicUnsaved: false, config: { id: 'durable_d', name: 'Dispatcher', color: 'indigo', createdAt: '2026-01-01' } });
  vi.mocked(dispatcher.setDispatcherEnabled).mockClear();
});

describe('resolving the Dispatcher for phones', () => {
  it('resolves its id with its folder as the __dispatcher__ project only while it is on', () => {
    expect(activeDispatcher('durable_d')).toBeNull();
    expect(isDisabledDispatcherId('durable_d')).toBe(true);
    expect(dispatcherFolderProject('__dispatcher__')).toBeUndefined();
    S.enabled = true;
    expect(activeDispatcher('durable_d')).toEqual({
      config: S.config, project: { id: '__dispatcher__', name: 'Dispatcher', path: '/base/dispatcher' },
    });
    expect(activeDispatcher()).not.toBeNull();
    expect(activeDispatcher('durable_other')).toBeNull();
    expect(isDisabledDispatcherId('durable_d')).toBe(false);
    expect(isDisabledDispatcherId('durable_other')).toBe(false);
    expect(dispatcherFolderProject('__dispatcher__')).toMatchObject({ path: '/base/dispatcher' });
    expect(dispatcherFolderProject('proj_app')).toBeUndefined();
  });

  it('answers nothing switched off, whatever MCP says, or before it was ever created', () => {
    S.enabled = false;
    S.flagOn = false;
    expect(activeDispatcher('durable_d')).toBeNull();
    S.enabled = true;
    S.flagOn = true;
    S.config = null;
    expect(activeDispatcher()).toBeNull();
  });
});

describe('with Clubhouse MCP off', () => {
  const view = (config: unknown) => ({ view: config });

  it('running: its routes answer, its shell does not, and every payload says so', () => {
    Object.assign(S, { enabled: true, flagOn: false, running: true });
    expect(activeDispatcher('durable_d')).toMatchObject({ config: { id: 'durable_d' } });
    expect(isDisabledDispatcherId('durable_d')).toBe(false);
    expect(dispatcherFolderProject('__dispatcher__')).toMatchObject({ path: '/base/dispatcher' });
    expect(dispatcherShellProject('__dispatcher__')).toBeUndefined();
    expect(dispatcherChange()).toEqual({ enabled: false, flagOn: false, agentId: null });
    expect(dispatcherOffFields(dispatcher.getDispatcherState(), view)).toEqual({
      offReason: 'mcp_off', running: true, status: 'running', detail: 'MCP off; session running',
      commandsWhileOff: ['agent.stop', 'chat.interrupt', 'chat.permission', 'chat.queue.remove', 'chat.question', 'chat.send', 'dispatcher.setEnabled'],
      agent: { view: S.config },
    });
  });

  it('stopped: history still reads, and only setEnabled is left', () => {
    Object.assign(S, { enabled: true, flagOn: false, running: false });
    expect(activeDispatcher('durable_d')).toMatchObject({ config: { id: 'durable_d' } });
    expect(isDisabledDispatcherId('durable_d')).toBe(false);
    expect(dispatcherOffFields(dispatcher.getDispatcherState(), view)).toEqual({
      offReason: 'mcp_off', running: false, status: 'sleeping', detail: 'MCP off', commandsWhileOff: ['dispatcher.setEnabled'], agent: { view: S.config },
    });
  });

  it('its status is what the agent says, so the two can\'t differ', () => {
    Object.assign(S, { enabled: true, flagOn: false, running: true });
    expect(dispatcherOffFields(dispatcher.getDispatcherState(), () => ({ status: 'sleeping' }))).toMatchObject({ running: true, status: 'sleeping' });
    S.config = null;
    expect(dispatcherOffFields(dispatcher.getDispatcherState(), view)).toMatchObject({ status: 'running', agent: null });
  });

  it('adds nothing while it is on', () => {
    Object.assign(S, { enabled: true, flagOn: true });
    expect(dispatcherOffFields(dispatcher.getDispatcherState(), view)).toEqual({});
    expect(dispatcherCommandsWhileOff(dispatcher.getDispatcherState())).toEqual([]);
  });
});

describe('the one list of commands', () => {
  const EVERY_COMMAND = ['agent.start', 'agent.stop', 'agent.update', 'chat.send', 'chat.interrupt', 'chat.permission', 'chat.question', 'chat.queue.remove', 'chat.setModel', 'chat.setLevel'];
  const STATES: Array<[name: string, state: Partial<typeof S>, reason: string, code: string]> = [
    ['mcp_off running', { enabled: true, flagOn: false, running: true }, 'mcp_off', 'mcp_off'],
    ['mcp_off stopped', { enabled: true, flagOn: false, running: false }, 'mcp_off', 'mcp_off'],
    ['switched_off', { enabled: false, flagOn: true }, 'switched_off', 'dispatcher_off'],
    ['switched_off with MCP off too', { enabled: false, flagOn: false }, 'switched_off', 'dispatcher_off'],
    ['classic_layout', { enabled: false, flagOn: true, newLayout: false, classicUnsaved: true }, 'classic_layout', 'dispatcher_off'],
  ];

  it.each(STATES)('%s: what is advertised is exactly what is accepted', (_name, state, reason, code) => {
    Object.assign(S, state);
    const current = dispatcher.getDispatcherState();
    const { commandsWhileOff, offReason } = dispatcherOffFields(current, (c) => c) as { commandsWhileOff: string[]; offReason: string };
    expect(offReason).toBe(reason);
    const accepted = EVERY_COMMAND.filter((type) => {
      try {
        assertDispatcherCommand(type, 'durable_d');
        return true;
      } catch (err) {
        expect((err as { code: string; statusCode: number }).code).toBe(code);
        expect((err as { statusCode: number }).statusCode).toBe(409);
        return false;
      }
    });
    expect(accepted.sort()).toEqual(commandsWhileOff.filter((c) => c !== 'dispatcher.setEnabled').sort());
    expect(commandsWhileOff).toContain('dispatcher.setEnabled');
  });

  it('leaves other agents alone', () => {
    Object.assign(S, { enabled: true, flagOn: false });
    expect(() => assertDispatcherCommand('agent.start', 'durable_other')).not.toThrow();
  });

  it('turns a pending-only command with nothing pending into mcp_off, with MCP off only', () => {
    const missing = new MobileControlError('pending_request_not_found');
    Object.assign(S, { enabled: true, flagOn: false, running: true });
    expect(dispatcherNothingPending('durable_d', missing)).toMatchObject({ code: 'mcp_off', statusCode: 409 });
    expect(dispatcherNothingPending('durable_other', missing)).toBeNull();
    expect(dispatcherNothingPending('durable_d', new MobileControlError('session_mismatch'))).toBeNull();
    Object.assign(S, { enabled: true, flagOn: true });
    expect(dispatcherNothingPending('durable_d', missing)).toBeNull();
  });
});

describe('capability and change event', () => {
  it('reports the gate and the layout', () => {
    S.enabled = true;
    expect(dispatcherCapability()).toEqual({
      version: 1, enabled: true, flagOn: true, newLayout: true, projectId: '__dispatcher__',
      snapshotField: 'dispatcher', event: 'dispatcher:changed', commands: ['dispatcher.setEnabled'],
    });
  });

  it('sends the agent id only while it is on', () => {
    expect(dispatcherChange()).toEqual({ enabled: false, flagOn: true, agentId: null });
    S.enabled = true;
    expect(dispatcherChange()).toEqual({ enabled: true, flagOn: true, agentId: 'durable_d' });
  });
});

describe('dispatcher.setEnabled', () => {
  it('turns it on and off', async () => {
    expect(await setDispatcherEnabledFromPhone(true, allow)).toEqual({ enabled: true, flagOn: true, agentId: 'durable_d' });
    expect(await setDispatcherEnabledFromPhone(false, allow)).toEqual({ enabled: false, flagOn: true, agentId: null });
    expect(dispatcher.setDispatcherEnabled).toHaveBeenCalledTimes(2);
  });

  it('refuses turning it on without MCP or on the classic layout, as Settings > Dispatcher does', async () => {
    S.flagOn = false;
    // Switched off as well: the existing path and code, with today's words.
    expect(await refusal(setDispatcherEnabledFromPhone(true, allow))).toMatchObject({ code: 'dispatcher_flag_off', statusCode: 409, detail: MCP_REQUIRED_MESSAGE });
    // Saved on, and off only for want of MCP.
    S.enabled = true;
    expect(await refusal(setDispatcherEnabledFromPhone(true, allow))).toMatchObject({ code: 'mcp_off', statusCode: 409 });
    S.enabled = false;
    S.flagOn = true;
    S.newLayout = false;
    expect(await refusal(setDispatcherEnabledFromPhone(true, allow))).toMatchObject({
      code: 'dispatcher_layout_off', statusCode: 409, detail: 'The Dispatcher needs the new layout. Turn off Classic layout in Settings > Display & UI on the desktop, then restart Clubhouse.',
    });
    expect(dispatcher.setDispatcherEnabled).not.toHaveBeenCalled();
  });

  it('still turns off a saved-on Dispatcher while MCP is off, which stops it', async () => {
    S.enabled = true;
    S.flagOn = false;
    expect(await setDispatcherEnabledFromPhone(false, allow)).toMatchObject({ enabled: false, agentId: null });
    expect(dispatcher.setDispatcherEnabled).toHaveBeenCalledWith(false);
  });

  it('lets one that is still on be turned off on the classic layout, and leaves one that is on alone', async () => {
    S.enabled = true;
    S.newLayout = false;
    expect(await setDispatcherEnabledFromPhone(true, allow)).toMatchObject({ enabled: true });
    expect(dispatcher.setDispatcherEnabled).not.toHaveBeenCalled();
    expect(await setDispatcherEnabledFromPhone(false, allow)).toMatchObject({ enabled: false });
  });

  it('rechecks authorization before changing anything', async () => {
    const revoked = () => { throw new Error('authorization_revoked'); };
    await expect(setDispatcherEnabledFromPhone(true, revoked)).rejects.toThrow('authorization_revoked');
    expect(dispatcher.setDispatcherEnabled).not.toHaveBeenCalled();
  });
});
