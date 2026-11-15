import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import nativeFs from 'fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'os';
import * as path from 'path';

const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.dir } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./settings-audit', () => ({ auditChanges: vi.fn(), projectAuditTarget: vi.fn() }));

import { backupUnreadableFile, createSettingsStore, replaceFile } from './settings-store';
import {
  createAgentTemplateDir, createSkillDir, projectSettingsMutationState,
  updateProjectAgentDefaults, writeDefaultMcps, writeLaunchWrapper, writeMcpCatalog,
  writeMcpConfigs, writeProjectAgentDefaults, writeWrapperCatalogSnapshot,
} from './agent-settings-service';

beforeEach(() => {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-settings-durability-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  fs.rmSync(state.dir, { recursive: true, force: true });
});

const file = () => path.join(state.dir, 'settings.json');
const projectFile = () => path.join(state.dir, '.clubhouse', 'settings.json');
const store = () => createSettingsStore('settings.json', { count: 0 });

describe('settings persistence on disk', () => {
  it('keeps the old file intact on a failure after the temp write and before rename', async () => {
    const old = '{"count":41,"legacy":"keep me"}';
    fs.writeFileSync(file(), old);
    let checks = 0;
    await expect(replaceFile(file(), '{"count":42}', undefined, {
      prepare: async () => {},
      check: () => {
        if (++checks === 2) {
          const temp = fs.readdirSync(state.dir).find((name) => name.startsWith('.settings.json.tmp-'))!;
          expect(fs.readFileSync(path.join(state.dir, temp), 'utf-8')).toBe('{"count":42}');
          throw new Error('simulated crash before rename');
        }
      },
    })).rejects.toThrow('simulated crash');
    expect(fs.readFileSync(file(), 'utf-8')).toBe(old);
    expect(fs.readdirSync(state.dir)).toEqual(['settings.json']);
  });

  it('uses atomic replace without options and cleans up a failed rename', async () => {
    fs.writeFileSync(file(), '{"count":41}');
    const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('rename failed'));
    await expect(store().save({ count: 42 })).rejects.toThrow('rename failed');
    expect(rename).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(file(), 'utf-8')).toBe('{"count":41}');
    expect(fs.readdirSync(state.dir)).toEqual(['settings.json']);
  });

  it('copies unreadable bytes before returning defaults, deduplicates launches, and preserves them on save', async () => {
    const broken = '{"count":42,"legacy":"recoverable"';
    fs.writeFileSync(file(), broken);
    expect(store().get()).toEqual({ count: 0 });
    expect(fs.readFileSync(`${file()}.unreadable`, 'utf-8')).toBe(broken);
    const nextLaunch = store();
    expect(nextLaunch.get()).toEqual({ count: 0 });
    expect(fs.readdirSync(state.dir)).toEqual(['settings.json', 'settings.json.unreadable']);
    await nextLaunch.save({ count: 1 });
    expect(fs.readFileSync(`${file()}.unreadable`, 'utf-8')).toBe(broken);
    expect(JSON.parse(fs.readFileSync(file(), 'utf-8'))).toEqual({ count: 1 });
  });

  it('preserves a different recovery copy even when save is called before get', async () => {
    fs.writeFileSync(file(), '{second broken');
    fs.writeFileSync(`${file()}.unreadable`, '{first broken');
    await store().save({ count: 1 });
    expect(fs.readFileSync(`${file()}.unreadable`, 'utf-8')).toBe('{first broken');
    expect(fs.readFileSync(`${file()}.unreadable.1`, 'utf-8')).toBe('{second broken');
    expect(fs.readdirSync(state.dir).some((name) => name.includes('.tmp-'))).toBe(false);
  });

  it('bounds recovery copies and refuses to overwrite an unpreserved file', async () => {
    fs.writeFileSync(file(), '{new broken');
    for (let i = 0; i < 100; i++) fs.writeFileSync(`${file()}.unreadable${i ? `.${i}` : ''}`, `{broken ${i}`);
    const settings = store();
    expect(settings.get()).toEqual({ count: 0 });
    await expect(settings.save({ count: 1 })).rejects.toThrow('Too many recovery copies');
    expect(fs.readFileSync(file(), 'utf-8')).toBe('{new broken');
    expect(fs.readdirSync(state.dir)).toHaveLength(101);
  });

  it('keeps legacy and unknown values readable and leaves no temp files after success', async () => {
    fs.writeFileSync(file(), '{"count":42,"legacy":{"arbitrary":true}}');
    const settings = store();
    expect(settings.get()).toEqual({ count: 42, legacy: { arbitrary: true } });
    await settings.update((current) => ({ ...current, count: 43 }));
    expect(JSON.parse(fs.readFileSync(file(), 'utf-8'))).toEqual({ count: 43, legacy: { arbitrary: true } });
    expect(fs.readdirSync(state.dir)).toEqual(['settings.json']);
  });
});

describe('project settings persistence on disk', () => {
  it('keeps a good backup and quarantines corrupt live bytes when a recovered update fails before commit', async () => {
    fs.mkdirSync(path.dirname(projectFile()));
    const good = '{"defaults":{},"quickOverrides":{},"defaultMcps":["keep"],"legacy":true}';
    const broken = '{"defaultMcps":["recoverable"';
    fs.writeFileSync(`${projectFile()}.bak`, good);
    fs.writeFileSync(projectFile(), broken);
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('crash before commit'));
    await expect(writeMcpConfigs(state.dir, { server: { url: 'local' } })).rejects.toThrow('crash before commit');
    expect(fs.readFileSync(projectFile(), 'utf-8')).toBe(broken);
    expect(fs.readFileSync(`${projectFile()}.bak`, 'utf-8')).toBe(good);
    expect(fs.readFileSync(`${projectFile()}.unreadable`, 'utf-8')).toBe(broken);
    await writeMcpConfigs(state.dir, { server: { url: 'local' } });
    expect(JSON.parse(fs.readFileSync(projectFile(), 'utf-8'))).toMatchObject({
      defaultMcps: ['keep'], legacy: true, mcpConfigs: { server: { url: 'local' } },
    });
    expect(fs.readFileSync(`${projectFile()}.bak`, 'utf-8')).toBe(good);
    expect(fs.readdirSync(path.dirname(projectFile()))).toEqual(['settings.json', 'settings.json.bak', 'settings.json.unreadable']);
  });

  it('shares both the queue and mutation witnesses through a project symlink', async () => {
    const alias = path.join(state.dir, 'alias');
    fs.symlinkSync(state.dir, alias, 'junction');
    const first = writeDefaultMcps(state.dir, ['server']);
    expect(projectSettingsMutationState(alias)).toEqual(projectSettingsMutationState(state.dir));
    expect(projectSettingsMutationState(alias).pending).toBe(true);
    await Promise.all([first, writeMcpConfigs(alias, { server: { url: 'local' } })]);
    expect(JSON.parse(fs.readFileSync(projectFile(), 'utf-8'))).toMatchObject({ defaultMcps: ['server'], mcpConfigs: { server: { url: 'local' } } });
    expect(projectSettingsMutationState(alias)).toEqual(projectSettingsMutationState(state.dir));
    expect(projectSettingsMutationState(alias).pending).toBe(false);
  });

  it('shares case aliases on case-insensitive volumes', async ({ skip }) => {
    const project = path.join(state.dir, 'MixedCase');
    const alias = path.join(state.dir, 'mixedcase');
    fs.mkdirSync(project);
    if (!fs.existsSync(alias)) { skip(); return; }
    const first = writeDefaultMcps(project, ['server']);
    expect(projectSettingsMutationState(alias)).toEqual(projectSettingsMutationState(project));
    expect(projectSettingsMutationState(alias).pending).toBe(true);
    await Promise.all([first, writeMcpConfigs(alias, { server: { url: 'local' } })]);
    expect(JSON.parse(fs.readFileSync(path.join(project, '.clubhouse', 'settings.json'), 'utf-8'))).toMatchObject({ defaultMcps: ['server'], mcpConfigs: { server: { url: 'local' } } });
  });

  it('does not combine distinct directories on case-sensitive volumes', async ({ skip }) => {
    const project = path.join(state.dir, 'MixedCase');
    const other = path.join(state.dir, 'mixedcase');
    fs.mkdirSync(project);
    if (fs.existsSync(other)) { skip(); return; }
    fs.mkdirSync(other);
    const first = writeDefaultMcps(project, ['server']);
    expect(projectSettingsMutationState(project).pending).toBe(true);
    expect(projectSettingsMutationState(other).pending).toBe(false);
    await first;
    expect(fs.existsSync(path.join(other, '.clubhouse'))).toBe(false);
  });

  it('serializes all writers, preserves legacy values, and backs up the previous file', async () => {
    fs.mkdirSync(path.dirname(projectFile()));
    const legacy = { defaults: { old: true }, quickOverrides: { old: 'value' }, futureKey: [1, 2] };
    fs.writeFileSync(projectFile(), JSON.stringify(legacy));
    const catalog = [{ id: 'server', name: 'Server', description: 'A server' }];
    const snapshot = { lastSeenCatalog: catalog, lastSeenAt: '2026-11-14' };
    const wrapper = { binary: 'wrapper', separator: '--', orchestratorMap: {} };
    const writes = [
      writeProjectAgentDefaults(state.dir, { instructions: 'saved instructions' }),
      updateProjectAgentDefaults(state.dir, (current) => ({ ...current, buildCommand: 'build' })),
      writeLaunchWrapper(state.dir, wrapper),
      writeMcpCatalog(state.dir, catalog),
      writeDefaultMcps(state.dir, ['server']),
      writeWrapperCatalogSnapshot(state.dir, snapshot),
      writeMcpConfigs(state.dir, { server: { url: 'local' } }),
      createSkillDir(path.join(state.dir, '.clubhouse', 'source-skills'), 'skill', true),
      createAgentTemplateDir(path.join(state.dir, '.clubhouse', 'source-agents'), 'agent', true),
    ];
    expect(projectSettingsMutationState(state.dir).pending).toBe(true);
    await Promise.all(writes);
    expect(projectSettingsMutationState(state.dir).pending).toBe(false);
    const saved = JSON.parse(fs.readFileSync(projectFile(), 'utf-8'));
    expect(saved).toEqual({
      ...legacy, agentDefaults: { instructions: 'saved instructions', buildCommand: 'build' },
      launchWrapper: wrapper, mcpCatalog: catalog, defaultMcps: ['server'],
      wrapperCatalogSnapshot: snapshot, mcpConfigs: { server: { url: 'local' } },
      defaultSkillsPath: 'source-skills', defaultAgentsPath: 'source-agents',
    });
    expect(JSON.parse(fs.readFileSync(`${projectFile()}.bak`, 'utf-8'))).toMatchObject(legacy);
    expect(fs.readdirSync(path.dirname(projectFile())).some((name) => name.includes('.tmp-'))).toBe(false);
  });

  it('creates a byte-for-byte backup and keeps it and the old file on rename failure', async () => {
    await writeDefaultMcps(state.dir, ['old']);
    const old = fs.readFileSync(projectFile(), 'utf-8');
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('rename failed'));
    await expect(writeDefaultMcps(state.dir, ['new'])).rejects.toThrow('rename failed');
    expect(fs.readFileSync(projectFile(), 'utf-8')).toBe(old);
    expect(fs.readFileSync(`${projectFile()}.bak`, 'utf-8')).toBe(old);
    expect(fs.readdirSync(path.dirname(projectFile()))).toEqual(['settings.json', 'settings.json.bak']);
    // A rejected transaction must not poison the shared queue.
    await writeMcpConfigs(state.dir, { server: { url: 'local' } });
    expect(JSON.parse(fs.readFileSync(projectFile(), 'utf-8'))).toMatchObject({ defaultMcps: ['old'], mcpConfigs: { server: { url: 'local' } } });
  });
});


describe('durable recovery copies and conservative temp cleanup', () => {
  it('flushes recovery bytes and the supported directory before replacing the source', async () => {
    fs.writeFileSync(file(), '{broken');
    const sync = fs.fsyncSync;
    const flushed: string[] = [];
    const flush = vi.spyOn(nativeFs, 'fsyncSync').mockImplementation((fd) => {
      flushed.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file');
      sync(fd);
    });
    syncBuiltinESMExports();
    const rename = vi.spyOn(fs.promises, 'rename');
    const settings = store();
    expect(settings.get()).toEqual({ count: 0 });
    expect(flushed[0]).toBe('file');
    if (process.platform !== 'win32') expect(flushed).toContain('directory');
    await settings.save({ count: 1 });
    expect(flush.mock.invocationCallOrder.at(-1)).toBeLessThan(rename.mock.invocationCallOrder[0]);
  });

  it.each(['file', ...(process.platform === 'win32' ? [] : ['directory'])])('refuses overwrite after a %s fsync failure, and retries the existing copy', async (kind) => {
    fs.writeFileSync(file(), '{broken');
    const sync = fs.fsyncSync;
    const flush = vi.spyOn(nativeFs, 'fsyncSync').mockImplementation((fd) => {
      const type = fs.fstatSync(fd).isDirectory() ? 'directory' : 'file';
      if (type === kind) throw Object.assign(new Error('sync failed'), { code: 'EIO' });
      sync(fd);
    });
    syncBuiltinESMExports();
    const settings = store();
    expect(settings.get()).toEqual({ count: 0 });
    await expect(settings.save({ count: 1 })).rejects.toThrow('sync failed');
    expect(fs.readFileSync(file(), 'utf-8')).toBe('{broken');
    flush.mockRestore();
    syncBuiltinESMExports();
    await settings.save({ count: 1 });
    expect(fs.readdirSync(state.dir)).toEqual(['settings.json', 'settings.json.unreadable']);
  });

  it('cleans only old regular files with exact generated names, preserving manual recovery files', () => {
    const retained = [
      'settings.json.tmp-manual-recovery', 'settings.json.tmp-notes',
      '.settings.json.tmp-999999-1-notes', '.settings.json.tmp-0-1',
      '.settings.json.tmp-999999-2', `.settings.json.tmp-${process.pid}-1`,
    ];
    const stale = ['.settings.json.tmp-999999-1', 'settings.json.tmp-999999-1'];
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    for (const name of [...retained, ...stale]) {
      const target = path.join(state.dir, name);
      fs.writeFileSync(target, 'recoverable bytes');
      if (name !== '.settings.json.tmp-999999-2') fs.utimesSync(target, old, old);
    }
    const directory = path.join(state.dir, '.settings.json.tmp-999999-3');
    fs.mkdirSync(directory);
    fs.utimesSync(directory, old, old);
    const link = path.join(state.dir, '.settings.json.tmp-999999-4');
    fs.symlinkSync(directory, link, 'junction');
    store().get();
    for (const name of retained) expect(fs.readFileSync(path.join(state.dir, name), 'utf-8')).toBe('recoverable bytes');
    for (const name of stale) expect(fs.existsSync(path.join(state.dir, name))).toBe(false);
    expect(fs.lstatSync(directory).isDirectory()).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('accepts filesystems that explicitly do not support directory fsync', () => {
    fs.writeFileSync(file(), '{broken');
    const sync = fs.fsyncSync;
    vi.spyOn(nativeFs, 'fsyncSync').mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('unsupported'), { code: 'EINVAL' });
      sync(fd);
    });
    syncBuiltinESMExports();
    expect(() => backupUnreadableFile(file())).not.toThrow();
    expect(fs.readFileSync(`${file()}.unreadable`, 'utf-8')).toBe('{broken');
  });
});
