import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { decodeImportState, encodeImportState, ImportStore, IMPORT_HISTORY_MAX, IMPORT_STATE_MAX_BYTES } from './store';
import { IMPORT_EFFECTS, type ImportPlan, type ImportState } from './types';

vi.mock('fs/promises', async (original) => ({ ...await original<typeof import('fs/promises')>() }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));

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
function duringTemp(stage: 'write' | 'sync', change: (file: string) => void) {
  const open = fsp.open;
  return vi.spyOn(fsp, 'open').mockImplementation(async (name, flags, mode) => {
    const handle = await open(name, flags, mode);
    if (typeof name === 'string' && name.endsWith('.tmp')) {
      if (stage === 'write') {
        const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementation(async (...args) => { await write(...args); change(name); });
      } else {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => { await sync(); change(name); });
      }
    }
    return handle;
  });
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
    const replace = duringTemp('sync', () => {
      fs.renameSync(file, backup);
      fs.symlinkSync(target, file);
    });
    try {
      await expect(store.update((state) => { state.plans.push(plan()); })).rejects.toMatchObject({ reason: 'history_unavailable' });
      expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(target, 'utf8')).toBe(external);
      expect(fs.readFileSync(backup, 'utf8')).toBe(committed);
      expect(fs.readdirSync(root).sort()).toEqual(['committed.json', 'history.json', 'user.json']);
    } finally { replace.mockRestore(); }
  });

  it.each(['regular', 'symlink', 'hardlink'] as const)('refuses an actual post-sync %s temp replacement without deleting it or changing committed/outside bytes', async (kind) => {
    const { root, file } = temporary();
    const store = new ImportStore(file);
    const first = plan();
    await store.update((state) => { state.plans.push(first); });
    const committed = fs.readFileSync(file, 'utf8');
    const second = plan();
    const ownBytes = encodeImportState({ version: 1, plans: [first, second], receipts: [] });
    const outside = path.join(root, 'outside.json');
    const outsideBytes = '{"version":99,"outside":"do not adopt"}\n';
    fs.writeFileSync(outside, outsideBytes);
    let temp = '';
    const replace = duringTemp('sync', (name) => {
      temp = name;
      fs.renameSync(name, `${name}.owned`);
      if (kind === 'regular') fs.writeFileSync(name, outsideBytes);
      else if (kind === 'symlink') fs.symlinkSync(outside, name);
      else fs.linkSync(outside, name);
    });
    try {
      await expect(store.update((state) => { state.plans.push(second); })).rejects.toMatchObject({ reason: 'history_unavailable' });
      expect(fs.readFileSync(file, 'utf8')).toBe(committed);
      expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
      expect(fs.lstatSync(file).nlink).toBe(1);
      expect(fs.readFileSync(outside, 'utf8')).toBe(outsideBytes);
      expect(fs.readFileSync(temp, 'utf8')).toBe(outsideBytes);
      expect(fs.readFileSync(`${temp}.owned`, 'utf8')).toBe(ownBytes);
      expect(fs.lstatSync(temp).isSymbolicLink()).toBe(kind === 'symlink');
      if (kind === 'hardlink') expect(fs.lstatSync(temp).nlink).toBe(2);
    } finally { replace.mockRestore(); }
  });

  it.each(['write', 'sync'] as const)('refuses same-inode temp bytes changed after the real %s await instead of sealing/adopting them', async (stage) => {
    const { file } = temporary();
    const store = new ImportStore(file);
    await store.update(() => {});
    const committed = fs.readFileSync(file, 'utf8');
    const changed = committed.replace('"version": 1', '"version": 9');
    let temp = '';
    let identity = 0n;
    const replace = duringTemp(stage, (name) => {
      temp = name;
      identity = fs.lstatSync(name, { bigint: true }).ino;
      fs.writeFileSync(name, changed);
    });
    try {
      await expect(store.update(() => {})).rejects.toMatchObject({ reason: 'history_unavailable' });
      expect(fs.readFileSync(file, 'utf8')).toBe(committed);
      expect(fs.lstatSync(temp, { bigint: true }).ino).toBe(identity);
      expect(fs.readFileSync(temp, 'utf8')).toBe(changed);
    } finally { replace.mockRestore(); }
  });

  it('retains the actual owned descriptor through rename and closes it after committing the exact encoding', async () => {
    const { file } = temporary();
    const store = new ImportStore(file);
    const open = fsp.open;
    let owned: fsp.FileHandle | undefined;
    const opened = vi.spyOn(fsp, 'open').mockImplementation(async (name, flags, mode) => {
      const handle = await open(name, flags, mode);
      if (typeof name === 'string' && name.endsWith('.tmp')) owned = handle;
      return handle;
    });
    const rename = fsp.rename;
    const commit = vi.spyOn(fsp, 'rename').mockImplementation(async (source, destination) => {
      if (!owned || owned.fd < 0) throw new Error('Owned temp descriptor closed before commit');
      expect(fs.fstatSync(owned.fd, { bigint: true }).nlink).toBe(1n);
      await rename(source, destination);
    });
    try {
      await expect(store.update(() => {})).resolves.toEqual(empty());
      expect(owned?.fd).toBe(-1);
      expect(fs.readFileSync(file, 'utf8')).toBe(encodeImportState(empty()));
    } finally { opened.mockRestore(); commit.mockRestore(); }
  });

  it('reports a post-commit close failure truthfully without rolling back or claiming the history was not saved', async () => {
    const { root, file } = temporary();
    const open = fsp.open;
    const refuseClose = vi.spyOn(fsp, 'open').mockImplementation(async (name, flags, mode) => {
      const handle = await open(name, flags, mode);
      if (typeof name === 'string' && name.endsWith('.tmp')) {
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); throw new Error('private filesystem diagnostic'); });
      }
      return handle;
    });
    try {
      await expect(new ImportStore(file).update(() => {})).rejects.toMatchObject({
        reason: 'history_unavailable', message: expect.stringContaining('was committed'),
      });
      expect(fs.readFileSync(file, 'utf8')).toBe(encodeImportState(empty()));
      expect(fs.readdirSync(root)).toEqual(['history.json']);
    } finally { refuseClose.mockRestore(); }
  });

  it('preserves owned cleanup and close-error precedence when both commit and close fail', async () => {
    const { root, file } = temporary();
    const committed = encodeImportState(empty());
    fs.writeFileSync(file, committed);
    const open = fsp.open;
    const refuseClose = vi.spyOn(fsp, 'open').mockImplementation(async (name, flags, mode) => {
      const handle = await open(name, flags, mode);
      if (typeof name === 'string' && name.endsWith('.tmp')) {
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); throw new Error('private close diagnostic'); });
      }
      return handle;
    });
    const refuseCommit = vi.spyOn(fsp, 'rename').mockRejectedValue(Object.assign(new Error('private commit diagnostic'), { code: 'EACCES' }));
    try {
      await expect(new ImportStore(file).update((state) => { state.plans.push(plan()); })).rejects.toMatchObject({
        reason: 'history_unavailable',
        message: 'Import history could not be closed safely. Existing committed history was preserved; inspect status before retrying.',
      });
      expect(fs.readFileSync(file, 'utf8')).toBe(committed);
      expect(fs.readdirSync(root)).toEqual(['history.json']);
    } finally { refuseClose.mockRestore(); refuseCommit.mockRestore(); }
  });

  it.each(['regular', 'dangling', 'permission', 'unknown-root'] as const)('refuses modeled ENOENT with a %s ancestor instead of fabricating empty history', async (kind) => {
    const { root } = temporary();
    const parent = path.join(root, 'parent');
    if (kind === 'regular') fs.writeFileSync(parent, 'not a directory');
    else if (kind === 'dangling') fs.symlinkSync(path.join(root, 'missing-target'), parent);
    else if (kind === 'permission') fs.mkdirSync(parent);
    const file = path.join(parent, 'nested', 'history.json');
    const lstat = fsp.lstat;
    const missing = () => Object.assign(new Error('modeled Windows missing path'), { code: 'ENOENT' });
    const probe = vi.spyOn(fsp, 'lstat').mockImplementation(async (...args) => {
      if (kind === 'unknown-root' || args[0] === file || args[0] === path.dirname(file)) throw missing();
      if (kind === 'permission' && args[0] === parent) throw Object.assign(new Error('modeled permission refusal'), { code: 'EACCES' });
      return lstat(...args);
    });
    try {
      await expect(new ImportStore(file).get()).rejects.toMatchObject({ reason: 'history_unavailable' });
      if (kind === 'regular') expect(fs.readFileSync(parent, 'utf8')).toBe('not a directory');
      if (kind === 'dangling') expect(fs.lstatSync(parent).isSymbolicLink()).toBe(true);
    } finally { probe.mockRestore(); }
  });

  it('permits genuinely absent nested directories and commits the exact ordinary state', async () => {
    const { root } = temporary();
    const file = path.join(root, 'absent', 'nested', 'history.json');
    const store = new ImportStore(file);
    await expect(store.get()).resolves.toEqual(empty());
    await expect(store.update(() => {})).resolves.toEqual(empty());
    expect(fs.readFileSync(file, 'utf8')).toBe(encodeImportState(empty()));
  });

  it('bounds missing-path classification to 128 ancestor probes and refuses one more', async () => {
    const { root } = temporary();
    const within = path.join(root, ...Array<string>(127).fill('m'), 'history.json');
    const beyond = path.join(root, ...Array<string>(128).fill('m'), 'history.json');
    await expect(new ImportStore(within).get()).resolves.toEqual(empty());
    await expect(new ImportStore(beyond).get()).rejects.toMatchObject({ reason: 'history_unavailable' });
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
