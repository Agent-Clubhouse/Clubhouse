import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import * as experimental from '../experimental-settings';
import { resetAllSettingsStoresForTests } from '../settings-store';
import { newChromeEnabled, peekNewChromeEnabledForDisplay, resetNewChromeCacheForTests } from '../../window-chrome';
import { dispatcherEnablement, getSettings, readDispatcherEnablementForDisplay } from './dispatcher-settings';
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
let root: string;
const put = (name: string, raw: unknown) => fs.writeFileSync(path.join(root, name), JSON.stringify(raw));
const dispatcher = (raw: unknown) => put('dispatcher-settings.json', raw);
const flags = (raw: unknown) => put('experimental-settings.json', raw);
const disk = () => Object.fromEntries(fs.readdirSync(root).sort().map((name) => { const f = path.join(root, name), s = fs.statSync(f); return [name, { bytes: fs.readFileSync(f).toString('base64'), ino: s.ino, mtimeMs: s.mtimeMs }]; }));
const temp = (name: string) => { const f = path.join(root, `.${name}.tmp-${process.pid + 100000}-1`); fs.writeFileSync(f, 'keep cold temp'); const old = new Date(Date.now() - 3 * 86400000); fs.utimesSync(f, old, old); };
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-dispatcher-enablement-display-')));
  vi.spyOn(app, 'getPath').mockReturnValue(root); resetAllSettingsStoresForTests(); resetNewChromeCacheForTests();
});
afterEach(() => { resetAllSettingsStoresForTests(); resetNewChromeCacheForTests(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
it('does not initialize the layout or sweep cold settings when no session layout has been established', () => {
  flags({}); temp('dispatcher-settings.json'); temp('experimental-settings.json');
  const ordinary = vi.spyOn(experimental, 'getSettings'), before = disk();
  expect(peekNewChromeEnabledForDisplay()).toBeUndefined();
  expect.soft(readDispatcherEnablementForDisplay()).toMatchObject({ enabled: { state: 'unavailable' }, reason: { state: 'unavailable' } });
  expect.soft(ordinary).not.toHaveBeenCalled(); expect.soft(peekNewChromeEnabledForDisplay()).toBeUndefined(); expect.soft(disk()).toEqual(before);
});
it.each([false, true])('keeps explicit saved switch=%s independent of unreadable flags and a missing layout cache', (enabled) => {
  dispatcher({ enabled, personality: { PRIVATE_PROMPT: 'PRIVATE_TEXT' }, models: { PRIVATE_MODEL: 'PRIVATE_SETTINGS' } });
  fs.writeFileSync(path.join(root, 'experimental-settings.json'), '{broken'); temp('experimental-settings.json'); const before = disk();
  const flag = vi.spyOn(experimental, 'readGraduatedFlagForDisplay');
  const result = readDispatcherEnablementForDisplay();
  expect(result).toMatchObject({ enabled: { state: 'ok', value: enabled }, reason: { state: 'ok', value: enabled ? null : 'switch_off' } });
  expect(flag).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|personality|models/); expect(disk()).toEqual(before);
});
it.each(['syntax', 'array', 'null', 'field', 'oversized'])('keeps %s saved switch evidence unknown without recovery or defaults', (kind) => {
  if (kind === 'syntax') fs.writeFileSync(path.join(root, 'dispatcher-settings.json'), '{broken');
  else dispatcher(kind === 'array' ? [] : kind === 'null' ? null : kind === 'field' ? { enabled: 'false' } : { enabled: true, padding: 'x'.repeat(256 * 1024) });
  fs.writeFileSync(path.join(root, 'dispatcher-settings.json.bak'), '{"enabled":true}'); temp('dispatcher-settings.json');
  if (kind === 'field') { flags({}); expect(newChromeEnabled()).toBe(true); }
  const before = disk(), result = readDispatcherEnablementForDisplay();
  expect.soft(result.enabled.state).toBe('unavailable'); expect.soft(result.reason.state).toBe('unavailable'); expect.soft(disk()).toEqual(before);
  expect(peekNewChromeEnabledForDisplay()).toBe(kind === 'field' ? true : undefined);
});
it('preserves an established current layout when a later saved preference chooses the next layout', () => {
  flags({ newChrome: true }); expect(newChromeEnabled()).toBe(true); flags({ newChrome: false }); resetAllSettingsStoresForTests();
  const before = disk(); expect(readDispatcherEnablementForDisplay()).toMatchObject({ enabled: { state: 'ok', value: true }, reason: { state: 'ok', value: null } });
  expect(peekNewChromeEnabledForDisplay()).toBe(true); expect(disk()).toEqual(before);
});
it('does not promote a later saved new layout into an established classic session', () => {
  flags({ newChrome: false }); expect(newChromeEnabled()).toBe(false); flags({ newChrome: true }); resetAllSettingsStoresForTests();
  const before = disk(); expect(readDispatcherEnablementForDisplay()).toMatchObject({ enabled: { state: 'ok', value: false }, reason: { state: 'ok', value: 'classic_layout' } }); expect(disk()).toEqual(before);
});
it('keeps a verified classic-session off value independent of an unknown precise off reason', () => {
  flags({ newChrome: false }); expect(newChromeEnabled()).toBe(false); fs.writeFileSync(path.join(root, 'experimental-settings.json'), '{broken'); resetAllSettingsStoresForTests();
  const before = disk(); expect(readDispatcherEnablementForDisplay()).toMatchObject({ enabled: { state: 'ok', value: false }, reason: { state: 'unavailable' } }); expect(disk()).toEqual(before);
});
it('honors a verified retired flag restriction without needing to initialize the layout', () => {
  flags({ dispatcher: false }); const before = disk();
  expect(readDispatcherEnablementForDisplay()).toMatchObject({ enabled: { state: 'ok', value: false }, reason: { state: 'ok', value: 'experimental_off' } });
  expect(peekNewChromeEnabledForDisplay()).toBeUndefined(); expect(disk()).toEqual(before);
});
it('retains private selected switch receipts, ignoring unrelated preferences and rechecking relevant changes', () => {
  dispatcher({ enabled: true, personality: { text: 'PRIVATE_OTHER' } }); const receipts: Array<{ current(): boolean }> = [];
  const result = readDispatcherEnablementForDisplay({ receipts }); expect(receipts).toHaveLength(1); expect(receipts[0].current()).toBe(true); expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|receipts|current/);
  dispatcher({ enabled: true, personality: { text: 'PRIVATE_CHANGED' } }); expect(receipts[0].current()).toBe(true);
  dispatcher({ enabled: false }); const before = disk(); expect(receipts[0].current()).toBe(false); expect(disk()).toEqual(before);
});
it('invalidates a missing-layout observation once the ordinary lifecycle establishes it', () => {
  flags({}); const receipts: Array<{ current(): boolean }> = [];
  expect(readDispatcherEnablementForDisplay({ receipts }).enabled.state).toBe('unavailable'); expect(receipts[0].current()).toBe(true);
  expect(newChromeEnabled()).toBe(true); expect(receipts[0].current()).toBe(false);
});
it('labels warm host preferences as cache evidence without adopting later disk values', () => {
  dispatcher({ enabled: false }); getSettings(); dispatcher({ enabled: true }); const before = disk();
  expect(readDispatcherEnablementForDisplay()).toMatchObject({ enabled: { state: 'ok', value: false, inputs: [{ source: 'host-cache' }] } }); expect(disk()).toEqual(before);
});
it.each([
  [undefined, true, true], [undefined, false, true], [false, true, true], [true, false, false], [undefined, true, false],
] as const)('matches established local enablement for saved=%s retiredFlag=%s sessionLayout=%s', (saved, flag, layout) => {
  dispatcher(saved === undefined ? {} : { enabled: saved }); flags({ dispatcher: flag, newChrome: layout });
  expect(newChromeEnabled()).toBe(layout);
  const ordinary = dispatcherEnablement(), before = disk(), result = readDispatcherEnablementForDisplay();
  expect(result).toMatchObject({ enabled: { state: 'ok', value: ordinary.enabled }, reason: { state: 'ok', value: ordinary.reason } });
  expect(disk()).toEqual(before);
});
