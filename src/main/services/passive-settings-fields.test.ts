import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
import { readRuntimeModeForDisplay, getSettings as getRuntimeSettings } from './chat-runtime-settings';
import { readAgentAccessForDisplay } from './free-agent-settings';
import { readIdleSleepForDisplay, chatIdleSettings } from './chat-idle-settings';
import { readGraduatedFlagForDisplay, getStoredSettings as getStoredFlags, saveSettings as saveFlags, isGraduatedFeatureOn } from './experimental-settings';
import { resetAllSettingsStoresForTests } from './settings-store';
let root: string;
const files = ['experimental-settings.json', 'chat-runtime-settings.json', 'free-agent-settings.json', 'chat-idle-settings.json'];
const write = (name: string, value: unknown) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
const disk = () => Object.fromEntries(fs.readdirSync(root).map((name) => { const file = path.join(root, name), stat = fs.statSync(file); return [name, { bytes: fs.readFileSync(file).toString('base64'), ino: stat.ino, mtimeMs: stat.mtimeMs }]; }));
function temps() { for (const name of files) { const file = path.join(root, `.${name}.tmp-${process.pid + 100000}-1`); fs.writeFileSync(file, 'do not sweep'); const old = new Date(Date.now() - 3 * 86400000); fs.utimesSync(file, old, old); } }
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-settings-fields-')); vi.spyOn(app, 'getPath').mockReturnValue(root); resetAllSettingsStoresForTests(); });
afterEach(() => { resetAllSettingsStoresForTests(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
it.each(['missing', 'empty'])('projects verified %s defaults without cold initialization or recovery', (mode) => {
  if (mode === 'empty') for (const name of files) write(name, {}); temps(); const before = disk();
  expect(readRuntimeModeForDisplay('claude-code')).toMatchObject({ state: 'ok', value: { mode: 'chat' } });
  expect(readAgentAccessForDisplay({ freeAgentMode: true }, '/selected')).toMatchObject({ state: 'ok', value: 'full_access' });
  expect(readIdleSleepForDisplay(undefined)).toMatchObject({ state: 'ok', value: { minutes: 30, source: 'app' } });
  expect(disk()).toEqual(before);
});
it.each(['broken', 'array', 'null', 'large'])('does not turn cold %s settings into guessed runtime/access/idle defaults', (mode) => {
  for (const name of files) fs.writeFileSync(path.join(root, name), mode === 'broken' ? '{broken' : mode === 'array' ? '[]' : mode === 'null' ? 'null' : JSON.stringify({ large: 'x'.repeat(256 * 1024) }));
  temps(); const before = disk();
  expect.soft(readRuntimeModeForDisplay('claude-code').state).toBe('unavailable');
  expect.soft(readAgentAccessForDisplay({ freeAgentMode: true }, '/selected').state).toBe('unavailable');
  expect.soft(readIdleSleepForDisplay('inherit').state).toBe('unavailable'); expect.soft(disk()).toEqual(before);
});
it('keeps independent explicit agent choices available even with every global unreadable', () => {
  for (const name of files) fs.writeFileSync(path.join(root, name), '{broken'); temps(); const before = disk();
  expect(readRuntimeModeForDisplay('claude-code', 'terminal')).toMatchObject({ state: 'ok', value: { mode: 'terminal' }, inputs: [{ source: 'agent' }] });
  expect(readAgentAccessForDisplay({ freeAgentMode: true, access: 'full_access' }, '/selected')).toMatchObject({ state: 'ok', value: 'full_access' });
  expect(readAgentAccessForDisplay({ freeAgentMode: false, access: 'plan' }, '/selected')).toMatchObject({ state: 'ok', value: 'plan' });
  expect(readIdleSleepForDisplay('never')).toMatchObject({ state: 'ok', value: { minutes: 0, source: 'agent' } });
  expect(disk()).toEqual(before);
});
it('honors explicit host Chat off without consulting malformed runtime preferences', () => {
  write('experimental-settings.json', { chat: false }); fs.writeFileSync(path.join(root, 'chat-runtime-settings.json'), '{broken'); temps(); const before = disk();
  expect(readRuntimeModeForDisplay('claude-code', 'chat')).toMatchObject({ state: 'ok', value: { mode: 'terminal' } }); expect(disk()).toEqual(before);
});
it.each([null, false, 'wrong'])('refuses malformed relevant saved fields %s rather than applying absent-field defaults', (bad) => {
  write('chat-runtime-settings.json', { 'claude-code': { mode: bad } }); write('free-agent-settings.json', { defaultMode: bad }); write('chat-idle-settings.json', { idleTimeoutMinutes: bad });
  expect.soft(readRuntimeModeForDisplay('claude-code').state).toBe('unavailable');
  expect.soft(readAgentAccessForDisplay({ freeAgentMode: true }, '/selected').state).toBe('unavailable');
  expect.soft(readIdleSleepForDisplay(undefined).state).toBe('unavailable');
});
it('validates only the selected project access setting and never returns unrelated defaults or raw values', () => {
  write('free-agent-settings.json', { defaultMode: 'skip-all', projectOverrides: { '/selected': 'auto', '/PRIVATE_OTHER_PROJECT': 'PRIVATE_INVALID_OTHER_SETTING' } });
  const result = readAgentAccessForDisplay({ freeAgentMode: true }, '/selected'); expect(result).toMatchObject({ state: 'ok', value: 'auto' }); expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|projectOverrides|skip-all/);
  write('free-agent-settings.json', { defaultMode: 'skip-all', projectOverrides: { '/selected': null } }); expect(readAgentAccessForDisplay({ freeAgentMode: true }, '/selected').state).toBe('unavailable');
});
it('retains Copilot SDK compatibility while refusing unclassified drivers for a selected Chat preference', () => {
  write('chat-runtime-settings.json', { 'copilot-cli': { mode: 'chat', driver: 'copilot_acp' }, 'claude-code': { mode: 'chat', driver: 'unclassified' } });
  expect(readRuntimeModeForDisplay('copilot-cli')).toMatchObject({ state: 'ok', value: { mode: 'chat', driver: 'copilot_sdk' } });
  expect(readRuntimeModeForDisplay('claude-code').state).toBe('unavailable');
});
it('distinguishes established host cache from changed primary, and honors the flag unreadability gate separately', () => {
  write('experimental-settings.json', { chat: false }); getStoredFlags(); write('experimental-settings.json', { chat: true });
  expect(readGraduatedFlagForDisplay('chat')).toMatchObject({ state: 'ok', value: false, inputs: [{ source: 'host-cache' }] });
  fs.writeFileSync(path.join(root, 'experimental-settings.json'), '{broken'); expect(readGraduatedFlagForDisplay('chat')).toMatchObject({ state: 'unavailable', inputs: [{ source: 'primary' }] });
  write('experimental-settings.json', { chat: true }); resetAllSettingsStoresForTests();
  write('chat-runtime-settings.json', { 'claude-code': { mode: 'terminal' } }); getRuntimeSettings(); write('chat-runtime-settings.json', { 'claude-code': { mode: 'chat' } });
  expect(readRuntimeModeForDisplay('claude-code')).toMatchObject({ state: 'ok', value: { mode: 'terminal' } });
  write('chat-idle-settings.json', { idleTimeoutMinutes: 0 }); chatIdleSettings.getSettings(); write('chat-idle-settings.json', { idleTimeoutMinutes: 240 });
  expect(readIdleSleepForDisplay('inherit')).toMatchObject({ state: 'ok', value: { minutes: 0, source: 'app' }, inputs: [{ source: 'host-cache' }] });
});

it.each(['readable', 'unreadable'])('preserves the existing flag gate latch during an actual blocked %s save without display writes', async (initial) => {
  if (initial === 'readable') write('experimental-settings.json', { chat: true }); else fs.writeFileSync(path.join(root, 'experimental-settings.json'), '{broken');
  getStoredFlags();
  const open = fs.promises.open.bind(fs.promises); let release!: () => void, entered!: () => void; let blocked = false;
  const held = new Promise<void>((resolve) => { release = resolve; }); const started = new Promise<void>((resolve) => { entered = resolve; });
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    if (!blocked && String(args[0]).includes('.experimental-settings.json.tmp-')) { blocked = true; entered(); await held; }
    return open(...args);
  });
  const saving = saveFlags({ chat: false });
  try {
    await started;
    // The pending-write latch deliberately retains the pre-save readability
    // decision, while its accepted-memory value differs from committed disk.
    fs.writeFileSync(path.join(root, 'experimental-settings.json'), initial === 'readable' ? '{broken during held save' : '{"chat":true}');
    const before = disk(); const value = readGraduatedFlagForDisplay('chat');
    expect.soft(value).toMatchObject(initial === 'readable' ? { state: 'ok', value: false, inputs: [{ source: 'host-cache' }] } : { state: 'unavailable', inputs: [{ source: 'host-cache' }] });
    expect.soft(isGraduatedFeatureOn('chat')).toBe(false); expect.soft(disk()).toEqual(before);
  } finally { release(); await saving; }
  expect(readGraduatedFlagForDisplay('chat')).toMatchObject({ state: 'ok', value: false });
});

it.each(['chat-runtime-settings.json', 'free-agent-settings.json', 'chat-idle-settings.json'])('keeps unreadable %s independent from other valid global sources without recovery', (bad) => {
  for (const name of files) write(name, {}); fs.writeFileSync(path.join(root, bad), '{broken'); temps(); const before = disk();
  const runtime = readRuntimeModeForDisplay('claude-code'), access = readAgentAccessForDisplay({ freeAgentMode: true }, '/selected'), idle = readIdleSleepForDisplay(undefined);
  expect.soft(runtime.state).toBe(bad === 'chat-runtime-settings.json' ? 'unavailable' : 'ok');
  expect.soft(access.state).toBe(bad === 'free-agent-settings.json' ? 'unavailable' : 'ok');
  expect.soft(idle.state).toBe(bad === 'chat-idle-settings.json' ? 'unavailable' : 'ok'); expect.soft(disk()).toEqual(before);
});
