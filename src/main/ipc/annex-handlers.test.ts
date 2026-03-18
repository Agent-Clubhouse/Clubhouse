import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('../services/annex-settings', () => ({
  getSettings: vi.fn(() => ({ enabled: false, deviceName: 'My Mac' })),
  saveSettings: vi.fn(),
}));

vi.mock('../services/experimental-settings', () => ({
  getSettings: vi.fn(() => ({ annex: true })),
}));

vi.mock('../services/annex-server', () => ({
  start: vi.fn(),
  stop: vi.fn(),
  getStatus: vi.fn(() => ({ advertising: false, port: 0, pin: '', connectedCount: 0 })),
  regeneratePin: vi.fn(),
  broadcastThemeChanged: vi.fn(),
  disconnectPeer: vi.fn(),
}));

vi.mock('../services/annex-client', () => ({
  startClient: vi.fn(),
  stopClient: vi.fn(),
}));

vi.mock('../services/annex-peers', () => ({
  listPeers: vi.fn(() => []),
  removePeer: vi.fn(() => true),
  removeAllPeers: vi.fn(),
  unlockPairing: vi.fn(),
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
import * as experimentalSettings from '../services/experimental-settings';
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
  });

  it('GET_SETTINGS delegates to annexSettings.getSettings', async () => {
    const handler = handlers.get(IPC.ANNEX.GET_SETTINGS)!;
    const result = await handler({});
    expect(annexSettings.getSettings).toHaveBeenCalled();
    expect(result).toEqual({ enabled: false, deviceName: 'My Mac' });
  });

  it('SAVE_SETTINGS starts server when enabling', async () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enabled: false, deviceName: 'Mac' });
    const handler = handlers.get(IPC.ANNEX.SAVE_SETTINGS)!;
    await handler({}, { enabled: true, deviceName: 'Mac' });
    expect(annexServer.start).toHaveBeenCalled();
    expect(appLog).toHaveBeenCalledWith('core:annex', 'info', expect.stringContaining('started'));
  });

  it('SAVE_SETTINGS stops server when disabling', async () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enabled: true, deviceName: 'Mac' });
    const handler = handlers.get(IPC.ANNEX.SAVE_SETTINGS)!;
    await handler({}, { enabled: false, deviceName: 'Mac' });
    expect(annexServer.stop).toHaveBeenCalled();
    expect(appLog).toHaveBeenCalledWith('core:annex', 'info', expect.stringContaining('stopped'));
  });

  it('SAVE_SETTINGS starts client when enabling', async () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enabled: false, deviceName: 'Mac' });
    const handler = handlers.get(IPC.ANNEX.SAVE_SETTINGS)!;
    await handler({}, { enabled: true, deviceName: 'Mac' });
    expect(annexClient.startClient).toHaveBeenCalled();
  });

  it('SAVE_SETTINGS stops client when disabling', async () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enabled: true, deviceName: 'Mac' });
    const handler = handlers.get(IPC.ANNEX.SAVE_SETTINGS)!;
    await handler({}, { enabled: false, deviceName: 'Mac' });
    expect(annexClient.stopClient).toHaveBeenCalled();
  });

  it('SAVE_SETTINGS does not start/stop when enabled state unchanged', async () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enabled: true, deviceName: 'Mac' });
    const handler = handlers.get(IPC.ANNEX.SAVE_SETTINGS)!;
    await handler({}, { enabled: true, deviceName: 'New Name' });
    expect(annexServer.start).not.toHaveBeenCalled();
    expect(annexServer.stop).not.toHaveBeenCalled();
    expect(annexClient.startClient).not.toHaveBeenCalled();
    expect(annexClient.stopClient).not.toHaveBeenCalled();
  });

  it('SAVE_SETTINGS logs error when server start fails', async () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enabled: false, deviceName: 'Mac' });
    vi.mocked(annexServer.start).mockImplementationOnce(() => { throw new Error('port in use'); });
    const handler = handlers.get(IPC.ANNEX.SAVE_SETTINGS)!;
    await handler({}, { enabled: true, deviceName: 'Mac' });
    expect(appLog).toHaveBeenCalledWith('core:annex', 'error', expect.any(String), expect.objectContaining({
      meta: expect.objectContaining({ error: 'port in use' }),
    }));
  });

  it('SAVE_SETTINGS broadcasts status change after save', async () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enabled: false, deviceName: 'Mac' });
    const handler = handlers.get(IPC.ANNEX.SAVE_SETTINGS)!;
    await handler({}, { enabled: false, deviceName: 'Mac' });
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
});

describe('maybeStartAnnex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts server when settings.enabled is true', () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enabled: true, deviceName: 'Mac' });
    maybeStartAnnex();
    expect(annexServer.start).toHaveBeenCalled();
    expect(appLog).toHaveBeenCalledWith('core:annex', 'info', expect.stringContaining('auto-started'));
  });

  it('does not start server when settings.enabled is false', () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enabled: false, deviceName: 'Mac' });
    maybeStartAnnex();
    expect(annexServer.start).not.toHaveBeenCalled();
  });

  it('does not start server when experimental annex flag is off', () => {
    vi.mocked(experimentalSettings.getSettings).mockReturnValue({});
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enabled: true, deviceName: 'Mac' });
    maybeStartAnnex();
    expect(annexServer.start).not.toHaveBeenCalled();
  });

  it('logs error when auto-start fails', () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enabled: true, deviceName: 'Mac' });
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

  it('starts client when experimental annex flag is on', () => {
    vi.mocked(experimentalSettings.getSettings).mockReturnValue({ annex: true });
    maybeStartAnnexClient();
    expect(annexClient.startClient).toHaveBeenCalled();
    expect(appLog).toHaveBeenCalledWith('core:annex', 'info', expect.stringContaining('client auto-started'));
  });

  it('does not start client when experimental annex flag is off', () => {
    vi.mocked(experimentalSettings.getSettings).mockReturnValue({});
    maybeStartAnnexClient();
    expect(annexClient.startClient).not.toHaveBeenCalled();
  });

  it('logs error when client start fails', () => {
    vi.mocked(experimentalSettings.getSettings).mockReturnValue({ annex: true });
    vi.mocked(annexClient.startClient).mockImplementationOnce(() => { throw new Error('bonjour failed'); });
    maybeStartAnnexClient();
    expect(appLog).toHaveBeenCalledWith('core:annex', 'error', expect.any(String), expect.objectContaining({
      meta: expect.objectContaining({ error: 'bonjour failed' }),
    }));
  });
});
