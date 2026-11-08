import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnexDevice } from '../../../../shared/types';

const registered = vi.hoisted(() => new Map<string, { handler: (agentId: string, args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>; grant: unknown }>());
vi.mock('../tool-registry', () => ({
  registerGlobalTool: (name: string, _def: unknown, handler: never, options: { grant: unknown }) => { registered.set(name, { handler, grant: options.grant }); },
}));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));

import { deviceForAgent, registerDeviceTools, setDeviceToolHost, type DeviceToolHost } from './device-tools';

const device = (o: Partial<AnnexDevice>): AnnexDevice => ({
  fingerprint: 'aa:bb', alias: 'Studio', icon: 'computer', color: 'indigo', role: 'member', kind: 'desktop',
  state: 'connected', pairedAt: '', lastSeen: '', problem: null, address: '192.168.1.9:7432', typedHost: 'studio.ts.net', ...o,
});

let host: DeviceToolHost & { [K in keyof DeviceToolHost]: ReturnType<typeof vi.fn> };
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await registered.get(name)!.handler('dispatcher', args);
  return { text: result.content[0].text, isError: !!result.isError };
};

beforeEach(() => {
  registered.clear();
  registerDeviceTools();
  host = {
    list: vi.fn(() => [
      device({}),
      device({ fingerprint: 'cc:dd', alias: 'Phone', kind: 'phone', state: 'offline' }),
      device({ fingerprint: 'ee:ff', alias: 'Old Mac', role: 'satellite', kind: undefined, state: 'offline' }),
      device({ fingerprint: '11:22', alias: 'Pad', role: 'controller', kind: undefined }),
    ]),
    rename: vi.fn(async () => true),
    reconnect: vi.fn(),
    remove: vi.fn(() => true),
    openAddDevice: vi.fn(() => true),
  } as never;
  setDeviceToolHost(host);
});

describe('See devices and Manage devices (#3068)', () => {
  it('declares See devices for listing and Manage devices for every change', () => {
    expect(registered.get('list_devices')!.grant).toEqual({ actions: ['device.read'], target: 'app' });
    for (const name of ['rename_device', 'reconnect_device', 'remove_device', 'start_adding_device']) {
      expect(registered.get(name)!.grant).toEqual({ actions: ['device.manage'], target: 'app' });
    }
  });

  it('lists names and whether each is online, and nothing that reaches or pairs a device', async () => {
    const list = JSON.parse((await call('list_devices')).text);
    expect(list[0]).toEqual({ id: 'aa:bb', name: 'Studio', kind: 'desktop', online: true, state: 'connected', relation: 'network' });
    expect(list.map((d: { relation: string }) => d.relation)).toEqual(['network', 'network', 'controlled_from_here', 'controls_this_computer']);
    const text = JSON.stringify(list);
    for (const leak of ['192.168', 'studio.ts.net', 'address', 'typedHost', 'pin', 'certificate']) expect(text).not.toContain(leak);
    expect(Object.keys(deviceForAgent(device({})))).toEqual(['id', 'name', 'kind', 'online', 'state', 'relation']);
  });

  it('renames a device in the network only, with a name of 1 to 200 characters', async () => {
    expect(await call('rename_device', { id: 'AA:BB', name: ' Studio Pro ' })).toEqual({ text: 'Renamed it to Studio Pro.', isError: false });
    expect(host.rename).toHaveBeenCalledWith('aa:bb', 'Studio Pro');
    expect((await call('rename_device', { id: 'ee:ff', name: 'X' })).isError).toBe(true);
    expect((await call('rename_device', { id: 'aa:bb', name: 'x'.repeat(201) })).isError).toBe(true);
    expect((await call('rename_device', { id: 'nope', name: 'X' })).text).toContain('No device with that id');
    host.rename.mockResolvedValueOnce(false);
    expect((await call('rename_device', { id: 'aa:bb', name: 'Y' })).isError).toBe(true);
    expect(host.rename).toHaveBeenCalledTimes(2);
  });

  it('reconnects only a computer this one connects to, and never pairs one again', async () => {
    expect((await call('reconnect_device', { id: 'ee:ff' })).text).toBe('Trying to connect now.');
    expect(host.reconnect).toHaveBeenCalledWith('ee:ff');
    expect((await call('reconnect_device', { id: 'cc:dd' })).isError).toBe(true);
    expect((await call('reconnect_device', { id: '11:22' })).isError).toBe(true);
    host.list.mockReturnValue([device({ state: 'needs-pairing' })]);
    expect((await call('reconnect_device', { id: 'aa:bb' })).text).toContain('a person does in Settings');
    expect(host.reconnect).toHaveBeenCalledTimes(1);
  });

  it('removes a device', async () => {
    expect((await call('remove_device', { id: 'cc:dd' })).text).toBe('Removed Phone.');
    expect(host.remove).toHaveBeenCalledWith('cc:dd');
  });

  it('starts adding a device only by opening the page for a person: no tool finishes a pairing', async () => {
    const opened = await call('start_adding_device');
    expect(opened.isError).toBe(false);
    expect(host.openAddDevice).toHaveBeenCalled();
    // Nothing in the answer that pairs: no code, link or certificate.
    expect(opened.text).not.toMatch(/\d{6}|clubhousego:|pair\?|[0-9A-F]{2}(:[0-9A-F]{2}){7}/i);
    // And no device tool takes a code or a link to pair with.
    expect([...registered.keys()].sort()).toEqual(['list_devices', 'reconnect_device', 'remove_device', 'rename_device', 'start_adding_device']);
  });
});
