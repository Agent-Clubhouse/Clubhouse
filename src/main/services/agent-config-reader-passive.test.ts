import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';

vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('../telemetry/persist', () => ({ persist: { recovery: vi.fn(), timed: async (_kind: string, work: () => Promise<void>) => work() } }));
// The identity inventories are modeled; Dispatcher/settings-store below are real.
vi.mock('./project-store', () => ({ peekProjectsChecked: async () => ({ readable: true, projects: [{ id: 'p', path: '/selected', name: 'Selected project' }] }) }));
vi.mock('./agent-config', async (original) => ({ ...await original<typeof import('./agent-config')>(), peekDurableConfigsChecked: async () => ({ readable: true, agents: [{ id: 'selected', name: 'Selected', color: '', createdAt: '' }] }) }));
import { resolveAgentConfigTarget } from './agent-config-reader';
import { resetAllSettingsStoresForTests } from './settings-store';
import { resetNewChromeCacheForTests } from '../window-chrome';
let root: string;
async function disk() {
  return Object.fromEntries(await Promise.all((await fs.readdir(root)).map(async (name) => {
    const file = path.join(root, name); const stat = await fs.stat(file);
    return [name, { bytes: (await fs.readFile(file)).toString('base64'), ino: stat.ino, mtimeMs: stat.mtimeMs }];
  })));
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-passive-role-'));
  vi.spyOn(app, 'getPath').mockReturnValue(root); resetAllSettingsStoresForTests(); resetNewChromeCacheForTests();
});
afterEach(async () => { resetAllSettingsStoresForTests(); resetNewChromeCacheForTests(); vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
it.each(['dispatcher-settings.json', 'experimental-settings.json', 'free-agent-settings.json'])('strict selected identity does not read/recover unrelated cold %s', async (filename) => {
  for (const name of ['dispatcher-settings.json', 'experimental-settings.json', 'free-agent-settings.json']) {
    await fs.writeFile(path.join(root, name), name === filename ? 'broken selected global file' : '{}');
    const temp = path.join(root, `.${name}.tmp-${process.pid + 100000}-1`);
    await fs.writeFile(temp, 'stale temp content'); const old = new Date(Date.now() - 3 * 86400000); await fs.utimes(temp, old, old);
  }
  const before = await disk();
  expect(await resolveAgentConfigTarget('selected', undefined, { strict: true })).toMatchObject({ agent: { id: 'selected' }, project: { id: 'p' } });
  expect.soft(await disk()).toEqual(before);
});
