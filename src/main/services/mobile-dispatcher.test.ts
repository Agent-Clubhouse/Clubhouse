import { beforeEach, describe, expect, it, vi } from 'vitest';

const S = vi.hoisted(() => ({
  flagOn: true, enabled: false, newLayout: true,
  config: { id: 'durable_d', name: 'Dispatcher', color: 'indigo', createdAt: '2026-01-01' } as Record<string, unknown> | null,
}));

vi.mock('./dispatcher/dispatcher-service', () => {
  const state = () => ({ enabled: S.flagOn && S.enabled, flagOn: S.flagOn, agentId: (S.config?.id as string) ?? null,
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
import {
  activeDispatcher, dispatcherCapability, dispatcherChange, dispatcherFolderProject, isDisabledDispatcherId, setDispatcherEnabledFromPhone,
} from './mobile-dispatcher';

const allow = () => {};
async function refusal(promise: Promise<unknown>) {
  try { await promise; } catch (e) { return e as { code: string; statusCode: number }; }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  Object.assign(S, { flagOn: true, enabled: false, newLayout: true, config: { id: 'durable_d', name: 'Dispatcher', color: 'indigo', createdAt: '2026-01-01' } });
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

  it('is off with the flag off, whatever the setting says, and before it was ever created', () => {
    S.enabled = true;
    S.flagOn = false;
    expect(activeDispatcher('durable_d')).toBeNull();
    S.flagOn = true;
    S.config = null;
    expect(activeDispatcher()).toBeNull();
  });
});

describe('capability and change event', () => {
  it('reports the gate and the layout', () => {
    expect(dispatcherCapability()).toEqual({
      version: 1, enabled: false, flagOn: true, newLayout: true, projectId: '__dispatcher__',
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

  it('refuses turning it on with the flag off or on the classic layout, as Settings > Dispatcher does', async () => {
    S.flagOn = false;
    expect(await refusal(setDispatcherEnabledFromPhone(true, allow))).toMatchObject({ code: 'dispatcher_flag_off', statusCode: 409 });
    S.flagOn = true;
    S.newLayout = false;
    expect(await refusal(setDispatcherEnabledFromPhone(true, allow))).toMatchObject({ code: 'dispatcher_layout_off', statusCode: 409 });
    expect(dispatcher.setDispatcherEnabled).not.toHaveBeenCalled();
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
