import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('../services/annex-settings', () => ({
  getSettings: vi.fn(() => ({ enabled: false, deviceName: 'My Mac' })),
  saveSettings: vi.fn(),
}));

vi.mock('../services/annex-server', () => ({
  start: vi.fn(),
  stop: vi.fn(),
  getStatus: vi.fn(() => ({ advertising: false, port: 0, pin: '', connectedCount: 0 })),
  regeneratePin: vi.fn(),
  broadcastThemeChanged: vi.fn(),
}));

vi.mock('../services/log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('../util/ipc-broadcast', () => ({
  broadcastToAllWindows: vi.fn(),
}));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { registerAnnexHandlers, maybeStartAnnex } from './annex-handlers';
import * as annexSettings from '../services/annex-settings';
import * as annexServer from '../services/annex-server';

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
  });

  it('SAVE_SETTINGS stops server when disabling', async () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enabled: true, deviceName: 'Mac' });
    const handler = handlers.get(IPC.ANNEX.SAVE_SETTINGS)!;
    await handler({}, { enabled: false, deviceName: 'Mac' });
    expect(annexServer.stop).toHaveBeenCalled();
  });

  it('SAVE_SETTINGS does not start/stop when enabled state unchanged', async () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enabled: true, deviceName: 'Mac' });
    const handler = handlers.get(IPC.ANNEX.SAVE_SETTINGS)!;
    await handler({}, { enabled: true, deviceName: 'New Name' });
    expect(annexServer.start).not.toHaveBeenCalled();
    expect(annexServer.stop).not.toHaveBeenCalled();
  });

  it('GET_STATUS delegates to annexServer.getStatus', async () => {
    const handler = handlers.get(IPC.ANNEX.GET_STATUS)!;
    const result = await handler({});
    expect(annexServer.getStatus).toHaveBeenCalled();
    expect(result).toEqual({ advertising: false, port: 0, pin: '', connectedCount: 0 });
  });

  it('REGENERATE_PIN calls regeneratePin and returns new status', async () => {
    vi.mocked(annexServer.getStatus).mockReturnValue({
      advertising: true, port: 3000, pin: '1234', connectedCount: 0,
    });
    const handler = handlers.get(IPC.ANNEX.REGENERATE_PIN)!;
    const result = await handler({});
    expect(annexServer.regeneratePin).toHaveBeenCalled();
    expect(result).toEqual({ advertising: true, port: 3000, pin: '1234', connectedCount: 0 });
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
  });

  it('does not start server when settings.enabled is false', () => {
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enabled: false, deviceName: 'Mac' });
    maybeStartAnnex();
    expect(annexServer.start).not.toHaveBeenCalled();
  });
});
