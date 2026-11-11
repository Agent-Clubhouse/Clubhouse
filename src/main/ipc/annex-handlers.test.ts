import { settingsChanged } from '../telemetry/feature-events';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../telemetry/feature-events', () => ({ settingsChanged: vi.fn(), themeChanged: vi.fn(), popoutOpened: vi.fn(), blueprintTransfer: vi.fn(), recordToolsList: vi.fn() }));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('../services/preview-eligible', () => ({
  isPreviewEligible: vi.fn(() => true),
}));

vi.mock('../services/annex-settings', () => ({
  getSettings: vi.fn(() => ({ enableServer: false, enableClient: false, deviceName: 'My Mac' })),
  saveSettings: vi.fn(),
}));

vi.mock('../services/annex-server', () => ({
  start: vi.fn(),
  stop: vi.fn(),
  getStatus: vi.fn(() => ({ advertising: false, port: 0, pin: '', connectedCount: 0 })),
  regeneratePin: vi.fn(),
  broadcastThemeChanged: vi.fn(),
  disconnectPeer: vi.fn(),
  revokePeer: vi.fn(() => true),
  revokeAllPeers: vi.fn(),
}));

vi.mock('../services/annex-client', () => ({
  startClient: vi.fn(),
  stopClient: vi.fn(),
  scan: vi.fn(),
  connect: vi.fn(),
  forgetSatellite: vi.fn(),
}));

vi.mock('../services/annex-peers', () => ({
  listPeers: vi.fn(() => []),
  listPeersForDisplay: vi.fn(() => []),
  removePeer: vi.fn(() => true),
  removeAllPeers: vi.fn(),
  unlockPairing: vi.fn(),
}));

vi.mock('../services/annex-network-channel', () => ({ listMembers: vi.fn(() => [{ fingerprint: 'fp:sat', connected: true }]) }));
const membershipInit = vi.hoisted(() => ({ hooks: null as null | { connect: (fp: string) => void; endDevice: (fp: string) => void } }));
vi.mock('../services/annex-network-membership', () => ({
  initNetworkMembership: vi.fn((h: { connect: (fp: string) => void; endDevice: (fp: string) => void }) => { membershipInit.hooks = h; }),
  renameMember: vi.fn(() => true),
}));

vi.mock('../services/annex-devices', () => ({
  listDevices: vi.fn(() => [{ fingerprint: 'fp:phone', state: 'connected' }]),
  removeDevice: vi.fn(() => true),
}));

vi.mock('../services/annex-identity', () => ({
  deleteIdentity: vi.fn(),
}));

vi.mock('../services/annex-tls', () => ({
  deleteCert: vi.fn(),
}));

vi.mock('../services/log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('../util/ipc-broadcast', () => ({
  broadcastToAllWindows: vi.fn(),
}));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { registerAnnexHandlers, maybeStartAnnex, maybeStartAnnexClient } from './annex-handlers';
import * as annexSettings from '../services/annex-settings';
import * as annexServer from '../services/annex-server';
import * as annexClient from '../services/annex-client';
import * as annexPeers from '../services/annex-peers';
import * as annexIdentity from '../services/annex-identity';
import * as annexTls from '../services/annex-tls';
import * as annexDevices from '../services/annex-devices';
import { devicesChanged, resetDeviceSignalForTests } from '../services/annex-device-signal';
import { appLog } from '../services/log-service';
import { broadcastToAllWindows } from '../util/ipc-broadcast';

describe('annex-handlers', () => {
  let handlers: Map<string, (...args: any[]) => any>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();
    vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: any) => {
      handlers.set(channel, handler);
    });
    registerAnnexHandlers();
  });

  it('registers all annex IPC handlers', () => {
    expect(handlers.has(IPC.ANNEX.GET_SETTINGS)).toBe(true);
    expect(handlers.has(IPC.ANNEX.SAVE_SETTINGS)).toBe(true);
    expect(handlers.has(IPC.ANNEX.GET_STATUS)).toBe(true);
    expect(handlers.has(IPC.ANNEX.REGENERATE_PIN)).toBe(true);
    expect(handlers.has(IPC.ANNEX.PURGE_SERVER_CONFIG)).toBe(true);
  });

  it('GET_SETTINGS delegates to annexSettings.getSettings', async () => {
    const handler = handlers.get(IPC.ANNEX.GET_SETTINGS)!;
    const result = await handler({});
    expect(annexSettings.getSettings).toHaveBeenCalled();
    expect(result).toEqual({ enableServer: false, enableClient: false, deviceName: 'My Mac' });
  });

  it('SAVE_SETTINGS reports clubhouse.settings.changed with key annex', async () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enableServer: false, enableClient: false, deviceName: 'Mac' });
    await handlers.get(IPC.ANNEX.SAVE_SETTINGS)!({}, { enableServer: false, enableClient: false, deviceName: 'Mac' });
    expect(settingsChanged).toHaveBeenCalledWith('annex');
  });

  it('SAVE_SETTINGS starts server when enabling enableServer', async () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enableServer: false, enableClient: false, deviceName: 'Mac' });
    const handler = handlers.get(IPC.ANNEX.SAVE_SETTINGS)!;
    await handler({}, { enableServer: true, enableClient: false, deviceName: 'Mac' });
    expect(annexServer.start).toHaveBeenCalled();
    expect(appLog).toHaveBeenCalledWith('core:annex', 'info', expect.stringContaining('started'));
  });

  it('SAVE_SETTINGS stops server when disabling enableServer', async () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enableServer: true, enableClient: false, deviceName: 'Mac' });
    const handler = handlers.get(IPC.ANNEX.SAVE_SETTINGS)!;
    await handler({}, { enableServer: false, enableClient: false, deviceName: 'Mac' });
    expect(annexServer.stop).toHaveBeenCalled();
    expect(appLog).toHaveBeenCalledWith('core:annex', 'info', expect.stringContaining('stopped'));
  });

  it('SAVE_SETTINGS starts client when enabling enableClient', async () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enableServer: false, enableClient: false, deviceName: 'Mac' });
    const handler = handlers.get(IPC.ANNEX.SAVE_SETTINGS)!;
    await handler({}, { enableServer: false, enableClient: true, deviceName: 'Mac' });
    expect(annexClient.startClient).toHaveBeenCalled();
  });

  it('SAVE_SETTINGS stops client when disabling enableClient', async () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enableServer: false, enableClient: true, deviceName: 'Mac' });
    const handler = handlers.get(IPC.ANNEX.SAVE_SETTINGS)!;
    await handler({}, { enableServer: false, enableClient: false, deviceName: 'Mac' });
    expect(annexClient.stopClient).toHaveBeenCalled();
  });

  it('SAVE_SETTINGS does not start/stop when neither toggle changes', async () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enableServer: true, enableClient: true, deviceName: 'Mac' });
    const handler = handlers.get(IPC.ANNEX.SAVE_SETTINGS)!;
    await handler({}, { enableServer: true, enableClient: true, deviceName: 'New Name' });
    expect(annexServer.start).not.toHaveBeenCalled();
    expect(annexServer.stop).not.toHaveBeenCalled();
    expect(annexClient.startClient).not.toHaveBeenCalled();
    expect(annexClient.stopClient).not.toHaveBeenCalled();
  });

  it('SAVE_SETTINGS can enable server without client', async () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enableServer: false, enableClient: false, deviceName: 'Mac' });
    const handler = handlers.get(IPC.ANNEX.SAVE_SETTINGS)!;
    await handler({}, { enableServer: true, enableClient: false, deviceName: 'Mac' });
    expect(annexServer.start).toHaveBeenCalled();
    expect(annexClient.startClient).not.toHaveBeenCalled();
  });

  it.each([true, false])('SAVE_SETTINGS restarts the listener and refreshes discovery when loopback becomes %s, keeping pairings', async (loopbackOnly) => {
    const previous = { enableServer: true, enableClient: true, deviceName: 'Mac', loopbackOnly: !loopbackOnly };
    vi.mocked(annexSettings.getSettings).mockReturnValue(previous);
    await handlers.get(IPC.ANNEX.SAVE_SETTINGS)!({}, { ...previous, loopbackOnly });
    expect(annexSettings.saveSettings).toHaveBeenCalledWith({ ...previous, loopbackOnly });
    expect(annexServer.stop).toHaveBeenCalledExactlyOnceWith();
    expect(annexServer.start).toHaveBeenCalledExactlyOnceWith();
    expect(vi.mocked(annexServer.stop).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(annexServer.start).mock.invocationCallOrder[0]);
    expect(annexClient.scan).toHaveBeenCalledExactlyOnceWith();
    expect(annexClient.stopClient).not.toHaveBeenCalled();
    expect(annexPeers.removeAllPeers).not.toHaveBeenCalled();
    expect(annexPeers.removePeer).not.toHaveBeenCalled();
  });

  it('SAVE_SETTINGS does not start Annex just because loopback mode changes while off', async () => {
    const previous = { enableServer: false, enableClient: false, deviceName: 'Mac' };
    vi.mocked(annexSettings.getSettings).mockReturnValue(previous);
    await handlers.get(IPC.ANNEX.SAVE_SETTINGS)!({}, { ...previous, loopbackOnly: true });
    expect(annexServer.start).not.toHaveBeenCalled();
    expect(annexServer.stop).not.toHaveBeenCalled();
    expect(annexClient.scan).not.toHaveBeenCalled();
    expect(annexClient.startClient).not.toHaveBeenCalled();
  });

  it('SAVE_SETTINGS can enable client without server', async () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enableServer: false, enableClient: false, deviceName: 'Mac' });
    const handler = handlers.get(IPC.ANNEX.SAVE_SETTINGS)!;
    await handler({}, { enableServer: false, enableClient: true, deviceName: 'Mac' });
    expect(annexClient.startClient).toHaveBeenCalled();
    expect(annexServer.start).not.toHaveBeenCalled();
  });

  it('SAVE_SETTINGS can disable server while keeping client running', async () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enableServer: true, enableClient: true, deviceName: 'Mac' });
    const handler = handlers.get(IPC.ANNEX.SAVE_SETTINGS)!;
    await handler({}, { enableServer: false, enableClient: true, deviceName: 'Mac' });
    expect(annexServer.stop).toHaveBeenCalled();
    expect(annexClient.stopClient).not.toHaveBeenCalled();
  });

  it('SAVE_SETTINGS logs error when server start fails', async () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enableServer: false, enableClient: false, deviceName: 'Mac' });
    vi.mocked(annexServer.start).mockImplementationOnce(() => { throw new Error('port in use'); });
    const handler = handlers.get(IPC.ANNEX.SAVE_SETTINGS)!;
    await handler({}, { enableServer: true, enableClient: false, deviceName: 'Mac' });
    expect(appLog).toHaveBeenCalledWith('core:annex', 'error', expect.any(String), expect.objectContaining({
      meta: expect.objectContaining({ error: 'port in use' }),
    }));
  });

  it('SAVE_SETTINGS broadcasts status change after save', async () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enableServer: false, enableClient: false, deviceName: 'Mac' });
    const handler = handlers.get(IPC.ANNEX.SAVE_SETTINGS)!;
    await handler({}, { enableServer: false, enableClient: false, deviceName: 'Mac' });
    expect(broadcastToAllWindows).toHaveBeenCalledWith(IPC.ANNEX.STATUS_CHANGED, expect.anything());
  });

  it('GET_STATUS delegates to annexServer.getStatus', async () => {
    const handler = handlers.get(IPC.ANNEX.GET_STATUS)!;
    const result = await handler({});
    expect(annexServer.getStatus).toHaveBeenCalled();
    expect(result).toEqual({ advertising: false, port: 0, pin: '', connectedCount: 0 });
  });

  it('REGENERATE_PIN calls regeneratePin, broadcasts, and returns new status', async () => {
    vi.mocked(annexServer.getStatus).mockReturnValue({
      advertising: true, port: 3000, pin: '1234', connectedCount: 0,
    });
    const handler = handlers.get(IPC.ANNEX.REGENERATE_PIN)!;
    const result = await handler({});
    expect(annexServer.regeneratePin).toHaveBeenCalled();
    expect(broadcastToAllWindows).toHaveBeenCalledWith(IPC.ANNEX.STATUS_CHANGED, expect.anything());
    expect(result).toEqual({ advertising: true, port: 3000, pin: '1234', connectedCount: 0 });
  });

  // --- Input validation ---

  it('rejects non-object settings for SAVE_SETTINGS', () => {
    const handler = handlers.get(IPC.ANNEX.SAVE_SETTINGS)!;
    expect(() => handler({}, 'not-object')).toThrow('must be an object');
  });

  it('rejects null for SAVE_SETTINGS', () => {
    const handler = handlers.get(IPC.ANNEX.SAVE_SETTINGS)!;
    expect(() => handler({}, null)).toThrow('must be an object');
  });

  // --- PURGE_SERVER_CONFIG ---

  it('REMOVE_PEER revokes the pairing (closing its connections) and broadcasts the list', () => {
    const handler = handlers.get(IPC.ANNEX.REMOVE_PEER)!;
    expect(handler({}, 'fp:phone')).toBe(true);
    expect(annexServer.revokePeer).toHaveBeenCalledWith('fp:phone');
    expect(annexPeers.removePeer).not.toHaveBeenCalled();
    expect(broadcastToAllWindows).toHaveBeenCalledWith(IPC.ANNEX.PEERS_CHANGED, []);
  });

  it('LIST_DEVICES answers with the one device list', () => {
    expect(handlers.get(IPC.ANNEX.LIST_DEVICES)!({})).toEqual([{ fingerprint: 'fp:phone', state: 'connected' }]);
  });

  it('starts Annex Network membership with hooks that connect to, and end, a device (#3061)', () => {
    membershipInit.hooks!.connect('fp:new');
    expect(annexClient.connect).toHaveBeenCalledWith('fp:new');
    membershipInit.hooks!.endDevice('fp:gone');
    expect(annexClient.forgetSatellite).toHaveBeenCalledWith('fp:gone');
    expect(annexServer.revokePeer).toHaveBeenCalledWith('fp:gone');
    // Revoked first, so a removed phone is told while it's still known.
    expect(vi.mocked(annexServer.revokePeer).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(annexClient.forgetSatellite).mock.invocationCallOrder[0]);
    expect(broadcastToAllWindows).toHaveBeenCalledWith(IPC.ANNEX.PEERS_CHANGED, []);
  });

  it('RENAME_DEVICE renames a network member everywhere (#3067)', async () => {
    const membershipMod = await import('../services/annex-network-membership');
    expect(handlers.get(IPC.ANNEX.RENAME_DEVICE)!({}, 'fp:m', 'Studio')).toBe(true);
    expect(membershipMod.renameMember).toHaveBeenCalledWith('fp:m', 'Studio');
  });

  it('LIST_NETWORK_MEMBERS answers with who this machine has heard from', () => {
    expect(handlers.get(IPC.ANNEX.LIST_NETWORK_MEMBERS)!({})).toEqual([{ fingerprint: 'fp:sat', connected: true }]);
  });

  it('REMOVE_DEVICE removes the device whichever way it is paired, and broadcasts the peers', () => {
    expect(handlers.get(IPC.ANNEX.REMOVE_DEVICE)!({}, 'fp:sat')).toBe(true);
    expect(annexDevices.removeDevice).toHaveBeenCalledWith('fp:sat');
    expect(broadcastToAllWindows).toHaveBeenCalledWith(IPC.ANNEX.PEERS_CHANGED, []);
  });

  it('broadcasts the device list when it changes', () => {
    vi.useFakeTimers();
    try {
      resetDeviceSignalForTests();
      registerAnnexHandlers();
      devicesChanged();
      vi.advanceTimersByTime(60);
      expect(broadcastToAllWindows).toHaveBeenCalledWith(IPC.ANNEX.DEVICES_CHANGED, [{ fingerprint: 'fp:phone', state: 'connected' }]);
    } finally {
      vi.useRealTimers();
      resetDeviceSignalForTests();
    }
  });

  it('REMOVE_ALL_PEERS revokes every pairing', () => {
    handlers.get(IPC.ANNEX.REMOVE_ALL_PEERS)!({});
    expect(annexServer.revokeAllPeers).toHaveBeenCalled();
  });

  it('LIST_PEERS marks entries that need pairing again', () => {
    vi.mocked(annexPeers.listPeersForDisplay).mockReturnValueOnce([{ fingerprint: 'fp:old', needsPairing: true }] as never);
    expect(handlers.get(IPC.ANNEX.LIST_PEERS)!({})).toEqual([{ fingerprint: 'fp:old', needsPairing: true }]);
  });

  it('PURGE_SERVER_CONFIG stops server, deletes identity/tls/peers, and resets settings', async () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({
      enableServer: true,
      enableClient: true,
      deviceName: 'My Mac',
      alias: 'My Mac',
      icon: 'laptop',
      color: 'blue',
      autoReconnect: true,
    });

    const handler = handlers.get(IPC.ANNEX.PURGE_SERVER_CONFIG)!;
    await handler({});

    expect(annexServer.stop).toHaveBeenCalled();
    expect(annexClient.stopClient).toHaveBeenCalled();
    expect(annexIdentity.deleteIdentity).toHaveBeenCalled();
    expect(annexTls.deleteCert).toHaveBeenCalled();
    expect(annexPeers.removeAllPeers).toHaveBeenCalled();
    expect(annexSettings.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ enableServer: false, enableClient: false }),
    );
    expect(broadcastToAllWindows).toHaveBeenCalledWith(IPC.ANNEX.STATUS_CHANGED, expect.anything());
    expect(broadcastToAllWindows).toHaveBeenCalledWith(IPC.ANNEX.PEERS_CHANGED, expect.anything());
    expect(appLog).toHaveBeenCalledWith('core:annex', 'info', expect.stringContaining('purged'));
  });
});

describe('maybeStartAnnex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts server when settings.enableServer is true', () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enableServer: true, enableClient: false, deviceName: 'Mac' });
    maybeStartAnnex();
    expect(annexServer.start).toHaveBeenCalled();
    expect(appLog).toHaveBeenCalledWith('core:annex', 'info', expect.stringContaining('auto-started'));
  });

  it('does not start server when settings.enableServer is false', () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enableServer: false, enableClient: false, deviceName: 'Mac' });
    maybeStartAnnex();
    expect(annexServer.start).not.toHaveBeenCalled();
  });

  it('logs error when auto-start fails', () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enableServer: true, enableClient: false, deviceName: 'Mac' });
    vi.mocked(annexServer.start).mockImplementationOnce(() => { throw new Error('bind failed'); });
    maybeStartAnnex();
    expect(appLog).toHaveBeenCalledWith('core:annex', 'error', expect.any(String), expect.objectContaining({
      meta: expect.objectContaining({ error: 'bind failed' }),
    }));
  });
});

describe('maybeStartAnnexClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts client when enableClient is true', () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enableServer: false, enableClient: true, deviceName: 'Mac' });
    maybeStartAnnexClient();
    expect(annexClient.startClient).toHaveBeenCalled();
    expect(appLog).toHaveBeenCalledWith('core:annex', 'info', expect.stringContaining('client auto-started'));
  });

  it('does not start client when enableClient is false', () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enableServer: false, enableClient: false, deviceName: 'Mac' });
    maybeStartAnnexClient();
    expect(annexClient.startClient).not.toHaveBeenCalled();
  });

  it('logs error when client start fails', () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enableServer: false, enableClient: true, deviceName: 'Mac' });
    vi.mocked(annexClient.startClient).mockImplementationOnce(() => { throw new Error('bonjour failed'); });
    maybeStartAnnexClient();
    expect(appLog).toHaveBeenCalledWith('core:annex', 'error', expect.any(String), expect.objectContaining({
      meta: expect.objectContaining({ error: 'bonjour failed' }),
    }));
  });
});
