import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { app, ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { PluginManifest } from '../../shared/plugin-types';
import { registerPluginHandlers } from './plugin-handlers';
import * as registry from '../services/plugin-manifest-registry';

vi.mock('../services/log-service', () => ({ appLog: vi.fn() }));

type Handler = (...args: unknown[]) => unknown;
let home: string;
let handlers: Map<string, Handler>;
const originalSafeMode = process.env.CLUBHOUSE_SAFE_MODE;
const originalPluginsDir = process.env.CLUBHOUSE_PLUGINS_DIR;

function manifest(id: string, permissions: PluginManifest['permissions'] = ['storage', 'files']): PluginManifest {
  return { id, name: 'Fixture', version: '1.0.0', scope: 'project', engine: { api: 0.9 }, permissions, contributes: { help: {} } };
}

async function writeManifest(value: unknown, directory = 'fixture') {
  const dir = path.join(home, 'plugins', directory);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(value));
}

async function boot(externalEnabled: boolean, safeMode = false) {
  const kv = path.join(home, '.clubhouse', 'plugin-data', '_system', 'kv');
  await fs.mkdir(kv, { recursive: true });
  await fs.writeFile(path.join(kv, 'external-plugins-enabled.json'), JSON.stringify(externalEnabled));
  await fs.writeFile(path.join(kv, 'private.json'), '"private-value"');
  if (safeMode) process.env.CLUBHOUSE_SAFE_MODE = '1';
  else delete process.env.CLUBHOUSE_SAFE_MODE;
  registerPluginHandlers();
  // This also waits for the handler's real startup discovery promise.
  await invoke(IPC.PLUGIN.STORAGE_READ, { pluginId: '_system', scope: 'global', key: 'app-enabled' });
}

function invoke(channel: string, ...args: unknown[]) {
  return handlers.get(channel)!({}, ...args);
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-plugin-identity-'));
  process.env.CLUBHOUSE_PLUGINS_DIR = path.join(home, 'plugins');
  vi.spyOn(app, 'getPath').mockReturnValue(home);
  handlers = new Map();
  vi.spyOn(ipcMain, 'handle').mockImplementation((channel, handler) => { handlers.set(channel, handler as Handler); });
});

afterEach(async () => {
  registry.clear();
  if (originalSafeMode === undefined) delete process.env.CLUBHOUSE_SAFE_MODE;
  else process.env.CLUBHOUSE_SAFE_MODE = originalSafeMode;
  if (originalPluginsDir === undefined) delete process.env.CLUBHOUSE_PLUGINS_DIR;
  else process.env.CLUBHOUSE_PLUGINS_DIR = originalPluginsDir;
  await fs.rm(home, { recursive: true, force: true });
});

describe('real disk discovery/refresh to plugin data IPC', () => {
  it.each(['safe mode', 'external support off'])('discovery and refresh cannot re-register a plugin excluded by %s', async (gate) => {
    await writeManifest(manifest('fixture'));
    await boot(gate !== 'external support off', gate === 'safe mode');
    expect(await invoke(IPC.PLUGIN.DISCOVER_COMMUNITY)).toHaveLength(1);
    expect(registry.getManifest('fixture')).toBeUndefined();
    expect(await invoke(IPC.PLUGIN.REFRESH_MANIFEST_FROM_DISK, 'fixture')).toBeNull();
    expect(registry.getManifest('fixture')).toBeUndefined();
    await expect(invoke(IPC.PLUGIN.STORAGE_READ, { pluginId: 'fixture', scope: 'global', key: 'private' })).rejects.toThrow('Plugin data access refused');
    await expect(invoke(IPC.PLUGIN.FILE_READ, { pluginId: 'fixture', scope: 'global', relativePath: 'kv/private.json' })).rejects.toThrow('Plugin data access refused');
  });

  it('uses the persisted external switch when enabling and disabling support without a restart', async () => {
    await writeManifest(manifest('fixture'));
    await boot(false);
    await invoke(IPC.PLUGIN.STORAGE_WRITE, { pluginId: '_system', scope: 'global', key: 'external-plugins-enabled', value: true });
    await invoke(IPC.PLUGIN.REFRESH_MANIFEST_FROM_DISK, 'fixture');
    await invoke(IPC.PLUGIN.STORAGE_WRITE, { pluginId: 'fixture', scope: 'global', key: 'saved', value: 'retained' });
    await invoke(IPC.PLUGIN.STORAGE_WRITE, { pluginId: '_system', scope: 'global', key: 'external-plugins-enabled', value: false });
    await invoke(IPC.PLUGIN.DISCOVER_COMMUNITY);
    await expect(invoke(IPC.PLUGIN.STORAGE_READ, { pluginId: 'fixture', scope: 'global', key: 'saved' })).rejects.toThrow('Plugin data access refused');
    expect(await invoke(IPC.PLUGIN.REFRESH_MANIFEST_FROM_DISK, 'fixture')).toBeNull();
  });

  it.each(['_system', '_agentconfig:owner', '_agentconfig', '_agentconfigevil'])('discovery/refresh refuse a manifest claiming reserved ID %s', async (id) => {
    await writeManifest(manifest(id));
    await boot(true);
    await invoke(IPC.PLUGIN.DISCOVER_COMMUNITY);
    expect(registry.getManifest(id)).toBeUndefined();
    expect(await invoke(IPC.PLUGIN.REFRESH_MANIFEST_FROM_DISK, id)).toBeNull();
    expect(registry.getManifest(id)).toBeUndefined();
    await expect(invoke(IPC.PLUGIN.FILE_READ, { pluginId: id, scope: 'global', relativePath: 'kv/private.json' })).rejects.toThrow('Plugin data access refused');
    expect(await fs.readFile(path.join(home, '.clubhouse', 'plugin-data', '_system', 'kv', 'private.json'), 'utf-8')).toBe('"private-value"');
  });

  it('does not leave an invalid manifest from ordinary discovery in the registry', async () => {
    await writeManifest({ id: 'fixture', permissions: ['storage', 'files'] });
    await boot(true);
    await invoke(IPC.PLUGIN.DISCOVER_COMMUNITY);
    expect(registry.getManifest('fixture')).toBeUndefined();
    expect(await invoke(IPC.PLUGIN.REFRESH_MANIFEST_FROM_DISK, 'fixture')).toBeNull();
    await expect(invoke(IPC.PLUGIN.STORAGE_READ, { pluginId: 'fixture', scope: 'global', key: 'private' })).rejects.toThrow('Plugin data access refused');
  });

  it('refresh replaces permissions from real disk and invalid refresh removes a prior entry', async () => {
    await writeManifest(manifest('fixture'));
    await boot(true);
    await invoke(IPC.PLUGIN.STORAGE_WRITE, { pluginId: 'fixture', scope: 'global', key: 'saved', value: 'retained' });
    expect(await invoke(IPC.PLUGIN.FILE_READ, { pluginId: 'fixture', scope: 'global', relativePath: 'kv/saved.json' })).toBe('"retained"');
    await writeManifest(manifest('fixture', ['storage']));
    await invoke(IPC.PLUGIN.REFRESH_MANIFEST_FROM_DISK, 'fixture');
    await expect(invoke(IPC.PLUGIN.FILE_READ, { pluginId: 'fixture', scope: 'global', relativePath: 'kv/saved.json' })).rejects.toThrow('Plugin data access refused');
    await writeManifest({ id: 'fixture', permissions: ['storage', 'files'] });
    await invoke(IPC.PLUGIN.REFRESH_MANIFEST_FROM_DISK, 'fixture');
    expect(registry.getManifest('fixture')).toBeUndefined();
    await expect(invoke(IPC.PLUGIN.STORAGE_READ, { pluginId: 'fixture', scope: 'global', key: 'saved' })).rejects.toThrow('Plugin data access refused');
    expect(await fs.readFile(path.join(home, '.clubhouse', 'plugin-data', 'fixture', 'kv', 'saved.json'), 'utf-8')).toBe('"retained"');
  });

  it.each(['settings-x/../private', 'settings-x\\..\\private', 'project-enabled-x/../private'])('refuses host KV path alias %s for reads and writes', async (key) => {
    await boot(false);
    await expect(invoke(IPC.PLUGIN.STORAGE_READ, { pluginId: '_system', scope: 'global', key })).rejects.toThrow('Plugin data access refused');
    await expect(invoke(IPC.PLUGIN.STORAGE_WRITE, { pluginId: '_system', scope: 'global', key, value: 'overwrite' })).rejects.toThrow('Plugin data access refused');
    expect(await fs.readFile(path.join(home, '.clubhouse', 'plugin-data', '_system', 'kv', 'private.json'), 'utf-8')).toBe('"private-value"');
  });
});
