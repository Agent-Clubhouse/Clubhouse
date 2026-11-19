import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
import { resetAllSettingsStoresForTests } from './settings-store';
import { withSettingsSurface } from './settings-audit';
import { getSettings, readGlobalHelperCapForDisplay, readAutoHelpersForDisplay, readCopilotAutoForDisplay, saveSettings, saveAutoHelpers, saveCopilotAuto } from './orchestration-settings';
let root: string;
const filename = 'orchestration-settings.json';
const put = (value: unknown) => fs.writeFileSync(path.join(root, filename), JSON.stringify(value));
const disk = () => Object.fromEntries(fs.readdirSync(root).sort().map((name) => { const file = path.join(root, name), stat = fs.statSync(file); return [name, { bytes: fs.readFileSync(file).toString('base64'), ino: stat.ino, mtimeMs: stat.mtimeMs }]; }));
const agedTemp = () => { const file = path.join(root, `.${filename}.tmp-${process.pid + 100000}-1`); fs.writeFileSync(file, 'keep aged metadata temp'); const old = new Date(Date.now() - 3 * 86400000); fs.utimesSync(file, old, old); };
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-orchestration-display-'))); vi.spyOn(app, 'getPath').mockReturnValue(root); resetAllSettingsStoresForTests(); });
afterEach(() => { resetAllSettingsStoresForTests(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
it.each(['missing', 'empty'])('reads verified %s scalar defaults without initialization/recovery or temp sweeping', (kind) => {
  if (kind === 'empty') put({}); agedTemp(); const before = disk();
  expect.soft(readGlobalHelperCapForDisplay()).toMatchObject({ state: 'ok', value: 20 }); expect.soft(readAutoHelpersForDisplay()).toMatchObject({ state: 'ok', value: false }); expect.soft(readCopilotAutoForDisplay()).toMatchObject({ state: 'ok', value: true });
  expect.soft(disk()).toEqual(before);
});
it.each(['syntax', 'array', 'null', 'oversized'])('keeps cold %s settings unknown and does not read backup or sweep temps', (kind) => {
  fs.writeFileSync(path.join(root, filename), kind === 'syntax' ? '{broken' : kind === 'array' ? '[]' : kind === 'null' ? 'null' : JSON.stringify({ padding: 'x'.repeat(256 * 1024) }));
  fs.writeFileSync(path.join(root, filename + '.bak'), '{"globalHelperCap":99,"autoHelpers":true}'); agedTemp(); const before = disk();
  expect.soft(readGlobalHelperCapForDisplay().state).toBe('unavailable'); expect.soft(readAutoHelpersForDisplay().state).toBe('unavailable'); expect.soft(readCopilotAutoForDisplay().state).toBe('unavailable'); expect.soft(disk()).toEqual(before);
});
it('validates fields independently, preserving explicit false and keeping presets/private/unrelated values out', () => {
  put({ globalHelperCap: 7, autoHelpers: false, copilotAuto: false, helperPresets: { PRIVATE_MODEL: 'PRIVATE_PRESET' }, unrelated: 'PRIVATE_OTHER' });
  const values = [readGlobalHelperCapForDisplay(), readAutoHelpersForDisplay(), readCopilotAutoForDisplay()];
  expect(values).toMatchObject([{ state: 'ok', value: 7 }, { state: 'ok', value: false }, { state: 'ok', value: false }]); expect(JSON.stringify(values)).not.toMatch(/PRIVATE_|helperPresets|unrelated/);
  put({ globalHelperCap: 0, autoHelpers: false, copilotAuto: 'wrong' });
  expect(readGlobalHelperCapForDisplay().state).toBe('unavailable'); expect(readAutoHelpersForDisplay()).toMatchObject({ state: 'ok', value: false }); expect(readCopilotAutoForDisplay().state).toBe('unavailable');
});
it('retains selected evidence receipts through later primary changes and distinguishes warm cache from new disk', () => {
  put({ globalHelperCap: 7 }); const receipts: Array<{ current(): boolean }> = [];
  expect(readGlobalHelperCapForDisplay({ receipts })).toMatchObject({ state: 'ok', value: 7, inputs: [{ source: 'primary' }] }); expect(receipts[0].current()).toBe(true);
  put({ globalHelperCap: 9 }); expect(receipts[0].current()).toBe(false);
  getSettings(); put({ globalHelperCap: 11 });
  expect(readGlobalHelperCapForDisplay()).toMatchObject({ state: 'ok', value: 9, inputs: [{ source: 'host-cache' }] });
});
it.each(['raise-cap', 'lower-cap', 'enable-auto', 'disable-auto', 'disable-copilot'] as const)('observes published restrictions during a real held %s save, without display writes', async (change) => {
  put({ globalHelperCap: 20, autoHelpers: change === 'disable-auto', copilotAuto: true }); getSettings();
  const open = fs.promises.open.bind(fs.promises); let entered!: () => void, release!: () => void, blocked = false;
  const started = new Promise<void>((resolve) => { entered = resolve; }), held = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => { if (!blocked && String(args[0]).includes('.orchestration-settings.json.tmp-')) { blocked = true; entered(); await held; } return open(...args); });
  const saving = withSettingsSurface('ui', undefined, () => change === 'raise-cap' || change === 'lower-cap' ? saveSettings({ globalHelperCap: change === 'raise-cap' ? 40 : 5 }) : change === 'disable-copilot' ? saveCopilotAuto(false) : saveAutoHelpers(change === 'enable-auto'));
  try {
    await started; const before = disk(), cap = readGlobalHelperCapForDisplay(), auto = readAutoHelpersForDisplay(), copilot = readCopilotAutoForDisplay();
    expect.soft(cap).toMatchObject({ state: 'ok', value: change === 'lower-cap' ? 5 : 20, inputs: [{ source: 'host-cache' }] });
    expect.soft(auto).toMatchObject({ state: 'ok', value: false }); expect.soft(copilot).toMatchObject({ state: 'ok', value: change !== 'disable-copilot' });
    expect.soft(cap.inputs[0].field).toContain('Published helper policy'); expect.soft(disk()).toEqual(before);
  } finally { release(); await saving; }
  expect(readGlobalHelperCapForDisplay()).toMatchObject({ state: 'ok', value: change === 'raise-cap' ? 40 : change === 'lower-cap' ? 5 : 20 });
  expect(readAutoHelpersForDisplay()).toMatchObject({ state: 'ok', value: change === 'enable-auto' });
});
