import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { decodeImportState, encodeImportState, ImportStore, IMPORT_HISTORY_MAX, IMPORT_STATE_MAX_BYTES } from './store';
import { IMPORT_EFFECTS, type ImportPlan, type ImportState } from './types';

vi.mock('fs/promises', async (original) => ({ ...await original<typeof import('fs/promises')>() }));

const roots: string[] = [];
function temporary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-history-'));
  roots.push(root);
  return { root, file: path.join(root, 'history.json') };
}
function plan(): ImportPlan {
  return {
    id: randomUUID(), agentId: 'dispatcher', url: 'https://github.com/example/repo.git', branch: 'trunk', defaultBranch: 'trunk',
    commit: 'a'.repeat(40), headCommit: 'a'.repeat(40), parent: path.resolve('/work'), destination: path.resolve('/work/repo'),
    parentIdentity: '1:2', createdAt: 1, expiresAt: 100, effects: IMPORT_EFFECTS,
  };
}
const empty = (): ImportState => ({ version: 1, plans: [], receipts: [] });
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('bounded fail-closed import lifecycle history', () => {
  it('saves atomically and serializes concurrent receipt/plan updates rather than losing one', async () => {
    const { file } = temporary();
    const store = new ImportStore(file);
    await Promise.all([
      store.update((state) => { state.plans.push(plan()); }),
      store.update((state) => { state.plans.push(plan()); }),
    ]);
    expect((await store.get()).plans).toHaveLength(2);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['history.json']);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it.each([
    'not json', '{"version":2,"plans":[],"receipts":[]}', '{"version":1,"plans":{},"receipts":[]}',
    '{"version":1,"plans":[],"receipts":[],"approved":true}',
  ])('refuses corrupt/unknown schema without replacing existing bytes: %s', async (raw) => {
    const { file } = temporary();
    fs.writeFileSync(file, raw);
    const store = new ImportStore(file);
    await expect(store.get()).rejects.toMatchObject({ reason: 'history_corrupt' });
    await expect(store.update(() => {})).rejects.toMatchObject({ reason: 'history_corrupt' });
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);
  });

  it('rejects forged effects, credential-bearing saved URLs and duplicate identities', () => {
    for (const transform of [
      (p: ImportPlan) => ({ ...p, effects: ['Clone and start an agent'] }),
      (p: ImportPlan) => ({ ...p, url: 'https://secret@github.com/example/repo.git' }),
      (p: ImportPlan) => ({ ...p, parent: path.resolve('/elsewhere') }),
    ]) {
      expect(() => decodeImportState(JSON.stringify({ version: 1, plans: [transform(plan())], receipts: [] }))).toThrow(/unsupported schema/);
    }
    const p = plan();
    expect(() => decodeImportState(JSON.stringify({ version: 1, plans: [p, p], receipts: [] }))).toThrow(/unsupported schema/);
  });

  it('enforces the exact persisted pretty-JSON UTF-8 byte limit, not JS character count or compact JSON size', () => {
    const state = empty();
    const p = plan();
    // Escaping expands a single character to six JSON bytes, while UTF-8 expands the multibyte text.
    p.agentId = '\\'.repeat(200);
    state.plans.push(p);
    const encoded = encodeImportState(state);
    expect(Buffer.byteLength(encoded)).toBe(Buffer.byteLength(`${JSON.stringify(state, null, 2)}\n`));
    p.agentId = '\u00e9'.repeat(IMPORT_STATE_MAX_BYTES / 2);
    expect(JSON.stringify(state).length).toBeLessThan(IMPORT_STATE_MAX_BYTES);
    expect(() => encodeImportState(state)).toThrow(/byte limit/);
  });

  it('refuses oversized new state before replacing the previous valid ledger', async () => {
    const { file } = temporary();
    const store = new ImportStore(file);
    await store.update(() => {});
    const original = fs.readFileSync(file, 'utf8');
    await expect(store.update((state) => {
      for (let i = 0; i < IMPORT_HISTORY_MAX; i++) {
        const p = plan();
        p.parent = path.resolve('/', 'x'.repeat(3000));
        p.destination = path.join(p.parent, 'repo');
        state.plans.push(p);
      }
    })).rejects.toMatchObject({ reason: 'history_limit' });
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('rejects an oversized on-disk ledger with a bounded read', async () => {
    const { file } = temporary();
    fs.writeFileSync(file, ' '.repeat(IMPORT_STATE_MAX_BYTES + 1));
    await expect(new ImportStore(file).get()).rejects.toMatchObject({ reason: 'history_corrupt' });
    expect(fs.statSync(file).size).toBe(IMPORT_STATE_MAX_BYTES + 1);
  });

  it('does not follow a lifecycle-file symlink or modify its target', async () => {
    const { root, file } = temporary();
    const target = path.join(root, 'user.json');
    fs.writeFileSync(target, encodeImportState(empty()));
    fs.symlinkSync(target, file);
    await expect(new ImportStore(file).update(() => {})).rejects.toMatchObject({ reason: 'history_unavailable' });
    expect(fs.readFileSync(target, 'utf8')).toBe(encodeImportState(empty()));
  });

  it.each(['existing', 'dangling'] as const)('refuses %s lifecycle symlinks even when the platform does not enforce O_NOFOLLOW, preserving the link and committed bytes', async (kind) => {
    const { root, file } = temporary();
    const store = new ImportStore(file);
    await store.update((state) => { state.plans.push(plan()); });
    const committed = fs.readFileSync(file, 'utf8');
    const backup = path.join(root, 'committed.json');
    fs.renameSync(file, backup);
    const target = path.join(root, 'user.json');
    const external = encodeImportState(empty());
    if (kind === 'existing') fs.writeFileSync(target, external);
    fs.symlinkSync(target, file);
    const open = fsp.open;
    const withoutNofollow = vi.spyOn(fsp, 'open').mockImplementation((file, flags, mode) =>
      open(file, typeof flags === 'number' ? flags & ~(fs.constants.O_NOFOLLOW ?? 0) : flags, mode));
    try {
      const read = await Promise.allSettled([store.get()]);
      const write = await Promise.allSettled([store.update(() => {})]);
      expect([...read, ...write]).toMatchObject([
        { status: 'rejected', reason: { reason: 'history_unavailable' } },
        { status: 'rejected', reason: { reason: 'history_unavailable' } },
      ]);
      expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(file)).toBe(target);
      if (kind === 'existing') expect(fs.readFileSync(target, 'utf8')).toBe(external);
      else expect(fs.existsSync(target)).toBe(false);
      expect(fs.readFileSync(backup, 'utf8')).toBe(committed);
    } finally { withoutNofollow.mockRestore(); }
  });

  it('refuses a different regular ledger opened after its path inspection without adopting the replacement', async () => {
    const { root, file } = temporary();
    const store = new ImportStore(file);
    await store.update((state) => { state.plans.push(plan()); });
    const committed = fs.readFileSync(file, 'utf8');
    const backup = path.join(root, 'committed.json');
    const replacement = encodeImportState(empty());
    const open = fsp.open;
    const replace = vi.spyOn(fsp, 'open').mockImplementation(async (name, flags, mode) => {
      if (name === file) {
        fs.renameSync(file, backup);
        fs.writeFileSync(file, replacement);
      }
      return open(name, flags, mode);
    });
    try {
      await expect(store.get()).rejects.toMatchObject({ reason: 'history_unavailable' });
      expect(fs.readFileSync(file, 'utf8')).toBe(replacement);
      expect(fs.readFileSync(backup, 'utf8')).toBe(committed);
    } finally { replace.mockRestore(); }
  });

  it('refuses a lifecycle symlink introduced during the temporary-write await without replacing it', async () => {
    const { root, file } = temporary();
    const store = new ImportStore(file);
    await store.update((state) => { state.plans.push(plan()); });
    const committed = fs.readFileSync(file, 'utf8');
    const backup = path.join(root, 'committed.json');
    const target = path.join(root, 'user.json');
    const external = encodeImportState(empty());
    fs.writeFileSync(target, external);
    const open = fsp.open;
    const replace = vi.spyOn(fsp, 'open').mockImplementation(async (name, flags, mode) => {
      const handle = await open(name, flags, mode);
      if (typeof name === 'string' && name.endsWith('.tmp')) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          await sync();
          fs.renameSync(file, backup);
          fs.symlinkSync(target, file);
        });
      }
      return handle;
    });
    try {
      await expect(store.update((state) => { state.plans.push(plan()); })).rejects.toMatchObject({ reason: 'history_unavailable' });
      expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(target, 'utf8')).toBe(external);
      expect(fs.readFileSync(backup, 'utf8')).toBe(committed);
      expect(fs.readdirSync(root).sort()).toEqual(['committed.json', 'history.json', 'user.json']);
    } finally { replace.mockRestore(); }
  });
});
