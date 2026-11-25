import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./services/plugin-storage', () => ({
  getGlobalPluginDataDir: () => path.join(os.tmpdir(), 'unused-plugin-data'),
}));

import { BROWSER_FILE_SETTING_KEY, isBrowserFileAccessAllowed } from './browser-file-access';

describe('isBrowserFileAccessAllowed (#3869)', () => {
  let kvDir: string;

  beforeEach(() => {
    kvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-file-access-'));
  });

  afterEach(() => {
    fs.rmSync(kvDir, { recursive: true, force: true });
  });

  const write = (name: string, value: unknown) => {
    fs.writeFileSync(path.join(kvDir, name), typeof value === 'string' ? value : JSON.stringify(value));
  };

  it('is off when nothing is saved', () => {
    expect(isBrowserFileAccessAllowed(kvDir)).toBe(false);
  });

  it('is off when the folder is missing', () => {
    expect(isBrowserFileAccessAllowed(path.join(kvDir, 'missing'))).toBe(false);
  });

  it('matches the Browser manifest setting key', () => {
    expect(BROWSER_FILE_SETTING_KEY).toBe('allowFileProtocol');
  });

  it('is off when every scope has the setting off', () => {
    write('settings-app-browser.json', { allowFileProtocol: false, allowLocalhost: true });
    write('settings-proj_1774211954139_ouxws1-browser.json', {});
    expect(isBrowserFileAccessAllowed(kvDir)).toBe(false);
  });

  it('is on when the app scope turns it on', () => {
    write('settings-app-browser.json', { allowFileProtocol: true });
    expect(isBrowserFileAccessAllowed(kvDir)).toBe(true);
  });

  it('is on when a project scope turns it on', () => {
    write('settings-app-browser.json', { allowFileProtocol: false });
    write('settings-proj_1774211954139_ouxws1-browser.json', { allowFileProtocol: true });
    expect(isBrowserFileAccessAllowed(kvDir)).toBe(true);
  });

  it('only accepts a real true', () => {
    write('settings-app-browser.json', { allowFileProtocol: 'true' });
    expect(isBrowserFileAccessAllowed(kvDir)).toBe(false);
  });

  it("ignores other plugins whose ids end in -browser, and backups", () => {
    write('settings-app-my-browser.json', { allowFileProtocol: true });
    write('settings-proj_1_a-x-browser.json', { allowFileProtocol: true });
    write('settings-app-browser.json.bak', { allowFileProtocol: true });
    expect(isBrowserFileAccessAllowed(kvDir)).toBe(false);
  });

  it('treats a corrupt file as off', () => {
    write('settings-app-browser.json', '{not json');
    expect(isBrowserFileAccessAllowed(kvDir)).toBe(false);
  });

  it('ignores the retired allowLocalFileWebviews key', () => {
    write('security-settings.json', { allowLocalFileWebviews: true });
    write('settings-app-browser.json', { allowLocalFileWebviews: true });
    expect(isBrowserFileAccessAllowed(kvDir)).toBe(false);
  });
});
