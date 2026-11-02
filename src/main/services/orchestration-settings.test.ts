import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-orch-settings-'));

vi.mock('electron', () => ({
  app: { getPath: () => userData },
}));

import { getGlobalHelperCap, getPresets, getPresetsRevision, getSettings, savePresets, saveSettings } from './orchestration-settings';
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

describe('helper presets (#2671)', () => {
  const presets = { 'codex-cli': { easy: { model: 'gpt-6.1-terra', effort: 'low' } } };

  it('starts with none, at revision zero', () => {
    expect(getPresets()).toEqual({});
    expect(getPresetsRevision()).toBe(0);
  });

  it('moves the revision on each write, and keeps them on disk', async () => {
    await savePresets(presets);
    expect(getPresets()).toEqual(presets);
    expect(getPresetsRevision()).toBe(1);
    await savePresets({});
    expect(getPresetsRevision()).toBe(2);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).helperPresetsRevision).toBe(2);
  });

  it('saving the cap leaves them alone', async () => {
    await savePresets(presets);
    await saveSettings({ globalHelperCap: 7 });
    expect(getGlobalHelperCap()).toBe(7);
    expect(getPresets()).toEqual(presets);
    expect(getPresetsRevision()).toBe(1);
  });

  it('a save from the page with only the cap can\'t write them', async () => {
    await savePresets(presets);
    await saveSettings({ globalHelperCap: 7, helperPresets: {}, helperPresetsRevision: 99 });
    expect(getPresets()).toEqual(presets);
    expect(getPresetsRevision()).toBe(1);
  });

  it('drops malformed stored values', () => {
    fs.writeFileSync(file, JSON.stringify({ globalHelperCap: 5, helperPresets: { 'codex-cli': { easy: { model: 'a b' }, hard: { model: 'ok', effort: 'high' } } }, helperPresetsRevision: -1 }));
    resetAllSettingsStoresForTests();
    expect(getPresets()).toEqual({ 'codex-cli': { hard: { model: 'ok', effort: 'high' } } });
    expect(getPresetsRevision()).toBe(0);
  });
});
