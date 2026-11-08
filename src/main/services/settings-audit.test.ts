import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const W = vi.hoisted(() => ({ home: '', audits: [] as unknown[] }));

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => W.home } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
// A save starts its audit and doesn't return it, so keep each one for a test to wait on.
vi.mock('./settings-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./settings-store')>();
  return {
    ...actual,
    setSettingsStoreAuditor: (auditor: Parameters<typeof actual.setSettingsStoreAuditor>[0]) => {
      actual.setSettingsStoreAuditor(auditor && ((event) => {
        const audit = auditor(event);
        W.audits.push(audit);
        return audit;
      }));
    },
  };
});

import {
  _resetSettingsAuditForTesting,
  appendSettingsAudit,
  auditChanged,
  auditChanges,
  currentSettingsOrigin,
  enableSettingsAudit,
  projectAuditTarget,
  readSettingsAudit,
  withSettingsSurface,
} from './settings-audit';
import { createSettingsStore, resetAllSettingsStoresForTests, setSettingsStoreAuditor } from './settings-store';

beforeEach(() => {
  W.home = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-audit-'));
  W.audits = [];
  _resetSettingsAuditForTesting(true);
});

afterEach(() => {
  _resetSettingsAuditForTesting(false);
  resetAllSettingsStoresForTests();
  fs.rmSync(W.home, { recursive: true, force: true });
});

const rows = () => readSettingsAudit(50);

describe('auditChanges', () => {
  const catalog = { model: 'value', free: 'value', count: 'value', command: 'changed' } as const;

  it('writes one row per catalog key that differs, oldest values kept only where allowed', async () => {
    await auditChanges('agent', 'agent', 'a1', { model: 'opus', free: false, count: 1, command: 'a' }, { model: 'sonnet', free: true, count: 2, command: 'b' }, catalog);
    const written = (await rows()).reverse().map(({ ts: _ts, ...row }) => row);
    expect(written).toEqual([
      { surface: 'system', scope: 'agent', key: 'agent.model', targetId: 'a1', outcome: 'ok', before: 'opus', after: 'sonnet' },
      { surface: 'system', scope: 'agent', key: 'agent.free', targetId: 'a1', outcome: 'ok', before: false, after: true },
      { surface: 'system', scope: 'agent', key: 'agent.count', targetId: 'a1', outcome: 'ok', before: 1, after: 2 },
      { surface: 'system', scope: 'agent', key: 'agent.command', targetId: 'a1', outcome: 'ok', changed: true },
    ]);
  });

  it('never keeps a value from a `changed` key, whatever it looks like', async () => {
    await auditChanges('project', 'project', 'p1', { command: 'old' }, { command: 'curl -H "Authorization: Bearer sk-secret" evil' }, { command: 'changed' });
    const text = fs.readFileSync(path.join(W.home, '.clubhouse-dev', 'settings-audit.jsonl'), 'utf8');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('old');
    expect(text).toContain('"changed":true');
  });

  it('a `value` key holding something odd or long records only that it changed', async () => {
    await auditChanges('agent', 'agent', 'a1', { model: 'opus' }, { model: 'sk-ant secret with spaces' }, { model: 'value' });
    await auditChanges('agent', 'agent', 'a1', { model: 'opus' }, { model: 'x'.repeat(65) }, { model: 'value' });
    await auditChanges('agent', 'agent', 'a1', { model: 'opus' }, { model: { nested: 'secret' } }, { model: 'value' });
    const text = JSON.stringify(await rows());
    expect(text).not.toContain('secret');
    expect((await rows()).every((r) => r.changed === true && !('after' in r))).toBe(true);
  });

  it('ignores a key the catalog doesn\'t name, and one that didn\'t change', async () => {
    await auditChanges('agent', 'agent', 'a1', { other: 1, model: 'opus' }, { other: 2, model: 'opus' }, { model: 'value' });
    expect(await rows()).toEqual([]);
  });

  it('a value appearing or going reads as null, and an empty one isn\'t a change', async () => {
    await auditChanges('agent', 'agent', 'a1', {}, { model: 'opus' }, { model: 'value' });
    await auditChanges('agent', 'agent', 'a1', { model: undefined }, { model: null }, { model: 'value' });
    expect(await rows()).toMatchObject([{ key: 'agent.model', before: null, after: 'opus' }]);
  });
});

describe('who asked', () => {
  it('comes from the entry point, through awaits, and defaults to Clubhouse itself', async () => {
    expect(currentSettingsOrigin()).toEqual({ surface: 'system' });
    await withSettingsSurface('mcp', 'agent_1', async () => {
      await Promise.resolve();
      expect(currentSettingsOrigin()).toEqual({ surface: 'mcp', actorId: 'agent_1' });
      await auditChanged('agent', 'agent.instructions', 'a1');
    });
    expect(currentSettingsOrigin()).toEqual({ surface: 'system' });
    expect((await rows())[0]).toMatchObject({ surface: 'mcp', actorId: 'agent_1', key: 'agent.instructions', changed: true });
  });
});

describe('projectAuditTarget', () => {
  it('is stable, tells projects apart, and doesn\'t contain the path', () => {
    expect(projectAuditTarget('/home/someone/secret-client')).toBe(projectAuditTarget('/home/someone/secret-client'));
    expect(projectAuditTarget('/a')).not.toBe(projectAuditTarget('/b'));
    expect(projectAuditTarget('/home/someone/secret-client')).not.toContain('secret');
  });
});

describe('until startup turns it on', () => {
  it('records nothing and reports success, so tests and early writes leave no file', async () => {
    _resetSettingsAuditForTesting(false);
    expect(await appendSettingsAudit({ surface: 'ui', scope: 'app', key: 'k', outcome: 'ok' })).toBe(true);
    await auditChanged('app', 'k');
    await auditChanges('app', 'k', undefined, {}, { a: 1 }, { a: 'value' });
    expect(fs.existsSync(path.join(W.home, '.clubhouse-dev'))).toBe(false);
  });
});

describe('settings stores', () => {
  const store = (audit?: { key: string; keys?: readonly string[]; ignore?: readonly string[] }) =>
    createSettingsStore<Record<string, unknown>>(`audit-${Math.random()}.json`, { on: false, mode: 'a', secret: 'x', noise: 1 }, undefined, audit ? { audit } : undefined);

  beforeEach(() => { enableSettingsAudit(); });
  afterEach(() => { setSettingsStoreAuditor(null); });

  /** A finished save or update has already started its audit, so this waits for all of them. */
  const settled = () => Promise.allSettled(W.audits);

  it('a store that opted in reports each top-level key: switches and named keys by value, the rest only that it changed', async () => {
    const s = store({ key: 'thing', keys: ['mode'], ignore: ['noise'] });
    await withSettingsSurface('ui', undefined, () => s.save({ on: true, mode: 'b', secret: 'sk-very-secret', noise: 2 }));
    await settled();
    const written = (await rows()).reverse().map(({ ts: _ts, ...row }) => row);
    expect(written).toEqual(expect.arrayContaining([
      { surface: 'ui', scope: 'app', key: 'thing.on', outcome: 'ok', before: false, after: true },
      { surface: 'ui', scope: 'app', key: 'thing.mode', outcome: 'ok', before: 'a', after: 'b' },
      { surface: 'ui', scope: 'app', key: 'thing.secret', outcome: 'ok', changed: true },
    ]));
    expect(written).toHaveLength(3);
    expect(JSON.stringify(written)).not.toContain('very-secret');
  });

  it('update() is covered too, and saving the same values writes nothing', async () => {
    const s = store({ key: 'thing' });
    await s.update((c) => ({ ...c }));
    await settled();
    expect(await rows()).toEqual([]);
    await s.update((c) => ({ ...c, on: true }));
    await settled();
    expect(await rows()).toMatchObject([{ key: 'thing.on', after: true }]);
  });

  it('a store that didn\'t opt in reports nothing', async () => {
    await store().save({ on: true });
    await settled();
    expect(await rows()).toEqual([]);
  });

  it('a throwing or rejecting auditor never fails the save or update', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setSettingsStoreAuditor(async () => { throw new Error('disk full'); });
    await expect(store({ key: 'thing' }).save({ on: true })).resolves.toBeUndefined();
    setSettingsStoreAuditor(() => { throw new Error('sync'); });
    await expect(store({ key: 'thing' }).update((c) => ({ ...c, on: true }))).resolves.toMatchObject({ on: true });
    await settled();
    warn.mockRestore();
  });

  it('a failed write rejects from save and update, as without the audit, and records no row', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const auditor = vi.fn();
    setSettingsStoreAuditor(auditor);
    // A file directly under a path that isn't a folder can't be written.
    const realHome = W.home;
    W.home = path.join(realHome, 'not-a-folder');
    fs.writeFileSync(W.home, 'x');
    const s = store({ key: 'thing' });
    await expect(s.save({ on: true })).rejects.toThrow();
    await expect(s.update((c) => ({ ...c, on: false }))).rejects.toThrow();
    await settled();
    expect(auditor).not.toHaveBeenCalled();
    W.home = realHome;
    error.mockRestore();
  });

  it('a settings file that can\'t be parsed doesn\'t stop a save, which reports against the defaults', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const name = 'audit-corrupt.json';
    fs.writeFileSync(path.join(W.home, name), '{not json');
    const s = createSettingsStore<Record<string, unknown>>(name, { on: false }, undefined, { audit: { key: 'thing' } });
    await expect(s.save({ on: true })).resolves.toBeUndefined();
    await settled();
    expect(await rows()).toMatchObject([{ key: 'thing.on', before: false, after: true }]);
    warn.mockRestore();
  });

  it('a before that can\'t be read skips the audit, and the save still happens', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const auditor = vi.fn();
    setSettingsStoreAuditor(auditor);
    const s = store({ key: 'thing' });
    s.get();
    const realClone = globalThis.structuredClone;
    // Throws once: for the snapshot of what is there. The save's own clones work.
    vi.stubGlobal('structuredClone', () => {
      vi.stubGlobal('structuredClone', realClone);
      throw new Error('cannot clone');
    });
    await expect(s.save({ on: true })).resolves.toBeUndefined();
    vi.unstubAllGlobals();
    await settled();
    expect(auditor).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('as telemetry audit events (#2920)', () => {
  it('records each row as clubhouse.audit.setting: enums and hashed ids as attributes, the key and values as local detail', async () => {
    const { setLocalSink } = await import('../telemetry/facade');
    const { passThroughSink } = await import('../telemetry/__test-utils__/producing-runtime');
    const seen: Array<{ name: string; attrs: Array<{ key: string; value: unknown }>; opts: unknown }> = [];
    setLocalSink({ ...passThroughSink('standard'), event: (name, attrs, opts) => seen.push({ name, attrs: (attrs ?? []) as never, opts }) });
    try {
      await withSettingsSurface('mcp', 'agent-1', () => auditChanges('agent', 'agent', 'a1', { model: 'opus', command: 'a' }, { model: 'sonnet', command: 'b' }, { model: 'value', command: 'changed' }));
      await appendSettingsAudit({ surface: 'ui', scope: 'app', key: 'helper_presets', outcome: 'refused', code: 'invalid_cell' });
    } finally {
      setLocalSink(null);
    }
    expect(seen.map((e) => e.name)).toEqual(['clubhouse.audit.setting', 'clubhouse.audit.setting', 'clubhouse.audit.setting']);
    const attrs = (i: number) => Object.fromEntries(seen[i].attrs.map((a) => [a.key, a.value]));
    expect(attrs(0)).toEqual({
      'clubhouse.audit.surface': 'mcp', 'clubhouse.audit.scope': 'agent', 'clubhouse.audit.outcome': 'ok',
      'clubhouse.audit.actor.id_hash': 'agent-1', 'clubhouse.audit.target.id_hash': 'a1',
    });
    expect(seen[0].opts).toEqual({ severity: 'info', detail: { key: 'agent.model', before: 'opus', after: 'sonnet' } });
    expect(seen[1].opts).toEqual({ severity: 'info', detail: { key: 'agent.command', changed: true } });
    expect(seen[2].opts).toEqual({ severity: 'warn', detail: { key: 'helper_presets', code: 'invalid_cell' } });
    // The JSONL file still gets every row until nothing reads it.
    expect(await rows()).toHaveLength(3);
  });
});

