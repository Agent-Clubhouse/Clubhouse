import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-orch-settings-'));

vi.mock('electron', () => ({
  app: { getPath: () => userData },
}));

import { getGlobalHelperCap, getSettings, saveSettings } from './orchestration-settings';
import { resetAllSettingsStoresForTests } from './settings-store';

const file = path.join(userData, 'orchestration-settings.json');

beforeEach(() => {
  resetAllSettingsStoresForTests();
  fs.rmSync(file, { force: true });
});

afterAll(() => {
  resetAllSettingsStoresForTests();
  fs.rmSync(userData, { recursive: true, force: true });
});

describe('orchestration settings', () => {
  it('defaults the global helper cap to 20', () => {
    expect(getSettings()).toEqual({ globalHelperCap: 20 });
    expect(getGlobalHelperCap()).toBe(20);
  });

  it('saves a valid cap', async () => {
    await saveSettings({ globalHelperCap: 8 });
    expect(getGlobalHelperCap()).toBe(8);
    resetAllSettingsStoresForTests();
    expect(getGlobalHelperCap()).toBe(8);
  });

  it('rejects an invalid cap without saving', async () => {
    await expect(saveSettings({ globalHelperCap: 0 })).rejects.toThrow(/globalHelperCap/);
    await expect(saveSettings({ globalHelperCap: 1.5 })).rejects.toThrow(/globalHelperCap/);
    expect(getGlobalHelperCap()).toBe(20);
  });

  it('falls back to the default for a bad value on disk', () => {
    fs.writeFileSync(file, JSON.stringify({ globalHelperCap: 'lots' }));
    expect(getGlobalHelperCap()).toBe(20);
  });
});
