import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-orch-settings-'));

vi.mock('electron', () => ({
  app: { getPath: () => userData },
}));

import { ensurePresetCellGenerations, getCopilotAuto, getGlobalHelperCap, getPresetCellGeneration, getPresets, getPresetsRevision, getSettings, saveAutoHelpers, saveCopilotAuto, savePresets, saveSettings } from './orchestration-settings';
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

  it('allows Copilot by default, persists its opt-out and revision, and preserves it when other settings change', async () => {
    expect(getCopilotAuto()).toBe(true);
    fs.writeFileSync(file, JSON.stringify({ globalHelperCap: 5, autoHelpers: true }));
    resetAllSettingsStoresForTests();
    expect(getCopilotAuto()).toBe(true);
    await saveCopilotAuto(false);
    expect(getPresetsRevision()).toBe(1);
    await saveSettings({ globalHelperCap: 8, copilotAuto: true });
    await savePresets({});
    resetAllSettingsStoresForTests();
    expect(getCopilotAuto()).toBe(false);
    expect(getSettings().autoHelpers).toBe(true);
    expect(getPresetsRevision()).toBe(2);
    await saveCopilotAuto(true);
    resetAllSettingsStoresForTests();
    expect(getCopilotAuto()).toBe(true);
  });
});

describe('helper presets (#2671)', () => {
  const presets = { 'codex-cli': { easy: { model: 'gpt-6.1-terra', effort: 'low' } } };

  it('starts with none, at revision zero', () => {
    expect(getPresets()).toEqual({});
    expect(getPresetsRevision()).toBe(0);
  });

  describe('Auto calibration cell generations', () => {
    it('initializes bounded cell identities durably without changing mappings or the public revision', async () => {
      expect(getPresetCellGeneration('copilot-cli', 'hard')).toBeUndefined();
      await ensurePresetCellGenerations();
      const generation = getPresetCellGeneration('copilot-cli', 'hard');
      expect(generation).toMatch(/^[a-f0-9-]{36}$/);
      expect(getPresets()).toEqual({});
      expect(getPresetsRevision()).toBe(0);
      resetAllSettingsStoresForTests();
      expect(getPresetCellGeneration('copilot-cli', 'hard')).toBe(generation);
    });

    it('invalidates only changed effective cells and bounds that follow them, including changing back', async () => {
      await ensurePresetCellGenerations();
      const easy = getPresetCellGeneration('copilot-cli', 'easy');
      const minimum = getPresetCellGeneration('copilot-cli', 'minimum');
      const medium = getPresetCellGeneration('copilot-cli', 'medium');
      const other = getPresetCellGeneration('codex-cli', 'easy');
      await savePresets({ 'copilot-cli': { easy: { model: 'gpt-6.1-sol', effort: 'low' } } });
      const changed = getPresetCellGeneration('copilot-cli', 'easy');
      expect(changed).not.toBe(easy);
      expect(getPresetCellGeneration('copilot-cli', 'minimum')).not.toBe(minimum);
      expect(getPresetCellGeneration('copilot-cli', 'medium')).toBe(medium);
      expect(getPresetCellGeneration('codex-cli', 'easy')).toBe(other);
      await savePresets({});
      expect(getPresetCellGeneration('copilot-cli', 'easy')).not.toBe(easy);
      expect(getPresetCellGeneration('copilot-cli', 'easy')).not.toBe(changed);
      resetAllSettingsStoresForTests();
      expect(getPresetCellGeneration('copilot-cli', 'medium')).toBe(medium);
      expect(getPresetCellGeneration('codex-cli', 'easy')).toBe(other);
    });

    it('partitions same-model effort changes while unrelated switches and explicit bounds preserve their cohorts', async () => {
      const before = { 'copilot-cli': {
        hard: { model: 'gpt-6.1-sol', effort: 'high' },
        maximum: { model: 'gpt-6.1-sol', effort: 'max' },
      } };
      await savePresets(before);
      const hard = getPresetCellGeneration('copilot-cli', 'hard');
      const maximum = getPresetCellGeneration('copilot-cli', 'maximum');
      await saveAutoHelpers(true);
      await saveCopilotAuto(false);
      await saveSettings({ globalHelperCap: 8 });
      expect(getPresetCellGeneration('copilot-cli', 'hard')).toBe(hard);
      await savePresets({ 'copilot-cli': { ...before['copilot-cli'], hard: { model: 'gpt-6.1-sol', effort: 'xhigh' } } });
      expect(getPresetCellGeneration('copilot-cli', 'hard')).not.toBe(hard);
      expect(getPresetCellGeneration('copilot-cli', 'maximum')).toBe(maximum);
    });

    it('replaces missing or malformed metadata without importing arbitrary fields or requalifying legacy cohorts', async () => {
      await ensurePresetCellGenerations();
      const valid = getPresetCellGeneration('copilot-cli', 'easy');
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      raw.helperPresetCellGenerations['copilot-cli'].hard = '/arbitrary/private/path';
      raw.helperPresetCellGenerations['other-provider'] = { hard: 'secret' };
      fs.writeFileSync(file, JSON.stringify(raw));
      resetAllSettingsStoresForTests();
      expect(getPresetCellGeneration('copilot-cli', 'hard')).toBeUndefined();
      await ensurePresetCellGenerations();
      expect(getPresetCellGeneration('copilot-cli', 'easy')).toBe(valid);
      expect(getPresetCellGeneration('copilot-cli', 'hard')).toMatch(/^[a-f0-9-]{36}$/);
      expect(JSON.stringify(getSettings().helperPresetCellGenerations)).not.toMatch(/arbitrary|secret|other-provider/);
    });

    it('does not publish a changed cell or generation after an atomic disk replacement fails', async () => {
      await ensurePresetCellGenerations();
      const generation = getPresetCellGeneration('copilot-cli', 'hard');
      const previous = fs.readFileSync(file, 'utf8');
      const failure = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('synthetic disk failure'));
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await expect(savePresets({ 'copilot-cli': { hard: { model: 'gpt-6.1-sol', effort: 'high' } } }))
          .rejects.toThrow('synthetic disk failure');
        expect(getPresetCellGeneration('copilot-cli', 'hard')).toBe(generation);
        expect(getPresets()).toEqual({});
        expect(getPresetsRevision()).toBe(0);
        expect(fs.readFileSync(file, 'utf8')).toBe(previous);
        expect(logged).toHaveBeenCalled();
      } finally {
        failure.mockRestore();
        logged.mockRestore();
      }
    });
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

  it('reads a file from before minimum and maximum unchanged, and keeps them once saved (#3044)', async () => {
    const before = { 'claude-code': { easy: { model: 'sonnet', effort: 'low' } }, 'codex-cli': { hard: { model: 'gpt-6.1-terra', effort: null } } };
    fs.writeFileSync(file, JSON.stringify({ globalHelperCap: 5, helperPresets: before, helperPresetsRevision: 4 }));
    resetAllSettingsStoresForTests();
    expect(getPresets()).toEqual(before);
    expect(getPresetsRevision()).toBe(4);
    await savePresets({ ...before, 'claude-code': { ...before['claude-code'], minimum: { model: 'haiku', effort: null }, maximum: { model: 'opus', effort: 'max' } } });
    resetAllSettingsStoresForTests();
    expect(getPresets()['claude-code']).toEqual({ easy: { model: 'sonnet', effort: 'low' }, minimum: { model: 'haiku', effort: null }, maximum: { model: 'opus', effort: 'max' } });
    expect(getPresets()['codex-cli']).toEqual(before['codex-cli']);
  });
});
