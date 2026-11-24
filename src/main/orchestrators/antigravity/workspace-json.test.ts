/**
 * The shared receipt-owned member edits (workspace-json.ts), exercised the
 * way `.agents/hooks.json` uses them: one top-level member. Everything lives
 * under a temp folder used as HOME and worktree.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/clubhouse-test' } }));
// Real file operations, with link and open wrapped so tests can inject failures.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    default: actual,
    link: vi.fn((...a: Parameters<typeof actual.link>) => actual.link(...a)),
    open: vi.fn((...a: Parameters<typeof actual.open>) => actual.open(...a)),
  };
});

import { createHash } from 'crypto';
import {
  AntigravityWorkspaceError, emptyOwnership, fileReceiptStore, insertOwnedMember, memoryReceiptStore, removeOwnedMember,
  setAntigravityReceiptStore, slotOf, TOP_LEVEL_SKELETON, type ReceiptStore,
} from './workspace-json';

const errno = (code: string) => Object.assign(new Error(code), { code });
const hashOf = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

const REL = '.agents/hooks.json';
const HOOK = { container: null, key: 'clubhouse-status' } as const;
const VALUE = JSON.stringify({ SessionStart: [{ type: 'command', command: 'clubhouse-hook', timeout: 5 }] });
const USER_HOOKS = '﻿{\n  // mine\n  "my-hook": { "Stop": [{"type": "command", "command": "say done"}] },\n}\n';

let tmp: string;
let home: string;
let worktree: string;
let file: string;
let store: ReceiptStore;
let previous: ReceiptStore;
const opts = () => ({ home });
const read = () => fsp.readFile(file, 'utf-8');
const write = async (text: string) => { await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.writeFile(file, text); };

beforeEach(async () => {
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'agy-ws-')));
  home = path.join(tmp, 'home');
  worktree = path.join(tmp, 'wt');
  await fsp.mkdir(path.join(home, '.gemini'), { recursive: true });
  await fsp.mkdir(worktree);
  file = path.join(worktree, '.agents', 'hooks.json');
  store = memoryReceiptStore();
  previous = setAntigravityReceiptStore(store);
});

afterEach(async () => {
  setAntigravityReceiptStore(previous);
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('top-level owned member', () => {
  it('insert then remove restores the person\'s hooks byte for byte', async () => {
    await write(USER_HOOKS);
    await insertOwnedMember(worktree, REL, { ...HOOK, valueJsonText: VALUE }, opts());
    expect(await read()).toContain(`"clubhouse-status": ${VALUE}`);
    expect(await removeOwnedMember(worktree, REL, HOOK, opts())).toBe('restored');
    expect(await read()).toBe(USER_HOOKS);
    expect(await store.get(file)).toBeUndefined();
  });

  it('a file Clubhouse created is deleted; a skeleton-shaped file the person wrote is kept', async () => {
    expect(await insertOwnedMember(worktree, REL, { ...HOOK, valueJsonText: VALUE }, opts())).toMatchObject({ created: true });
    expect(await removeOwnedMember(worktree, REL, HOOK, opts())).toBe('deleted');
    expect(fs.existsSync(path.dirname(file))).toBe(false);

    await write(TOP_LEVEL_SKELETON);
    await insertOwnedMember(worktree, REL, { ...HOOK, valueJsonText: VALUE }, opts());
    expect(await removeOwnedMember(worktree, REL, HOOK, opts())).toBe('restored');
    expect(await read()).toBe(TOP_LEVEL_SKELETON);
  });

  it('a same-named hook the person wrote is refused on insert and left on remove', async () => {
    const theirs = `{"clubhouse-status": ${VALUE}}`;
    await write(theirs);
    const err = await insertOwnedMember(worktree, REL, { ...HOOK, valueJsonText: VALUE }, opts()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AntigravityWorkspaceError);
    expect((err as AntigravityWorkspaceError).code).toBe('collision');
    expect(await removeOwnedMember(worktree, REL, HOOK, opts())).toMatchObject({ repair: expect.any(String) });
    expect(await read()).toBe(theirs);
  });

  it('replaces its own earlier value and keeps edits made elsewhere', async () => {
    await write(USER_HOOKS);
    await insertOwnedMember(worktree, REL, { ...HOOK, valueJsonText: VALUE }, opts());
    await fsp.writeFile(file, (await read()).replace('say done', 'say finished'));
    await insertOwnedMember(worktree, REL, { ...HOOK, valueJsonText: '{"Stop": []}' }, opts());
    expect((await read()).match(/clubhouse-status/g)).toHaveLength(1);
    await removeOwnedMember(worktree, REL, HOOK, opts());
    expect(await read()).toBe(USER_HOOKS.replace('say done', 'say finished'));
  });

  it('rejects a multi-line or non-JSON value', async () => {
    await expect(insertOwnedMember(worktree, REL, { ...HOOK, valueJsonText: '{\n}' }, opts())).rejects.toMatchObject({ code: 'unparsable' });
    await expect(insertOwnedMember(worktree, REL, { ...HOOK, valueJsonText: '{nope' }, opts())).rejects.toMatchObject({ code: 'unparsable' });
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('crash and concurrency cut points', () => {
  it('crash after write before commit: not adopted, refused, bytes kept', async () => {
    await write(USER_HOOKS);
    await insertOwnedMember(worktree, REL, { ...HOOK, valueJsonText: VALUE }, opts());
    const written = await read();
    const r = await store.get(file);
    await store.set(file, { committed: { ...r!.committed, members: {} }, pending: { txid: 't', beforeHash: 'b', afterHash: 'a' } });
    await expect(insertOwnedMember(worktree, REL, { ...HOOK, valueJsonText: VALUE }, opts())).rejects.toMatchObject({ code: 'collision' });
    expect(await removeOwnedMember(worktree, REL, HOOK, opts())).toMatchObject({ repair: expect.any(String) });
    expect(await read()).toBe(written);
  });

  it('a pending record alone confers nothing and is dropped', async () => {
    await write(USER_HOOKS);
    await store.set(file, { committed: emptyOwnership(), pending: { txid: 't', beforeHash: null, afterHash: 'x' } });
    expect(await removeOwnedMember(worktree, REL, HOOK, opts())).toBe('clean');
    expect(await store.get(file)).toBeUndefined();
    expect(await read()).toBe(USER_HOOKS);
  });

  it('a concurrent writer between read and swap: concurrent_edit, its bytes kept, ownership unchanged', async () => {
    await write(USER_HOOKS);
    const inner = memoryReceiptStore();
    const racing: ReceiptStore = {
      get: (f) => inner.get(f),
      set: async (f, receipt) => {
        // The pending record is written just before the swap: another writer saves now.
        if (receipt?.pending) await fsp.writeFile(file, '{"someone": "else"}');
        await inner.set(f, receipt);
      },
    };
    setAntigravityReceiptStore(racing);
    await expect(insertOwnedMember(worktree, REL, { ...HOOK, valueJsonText: VALUE }, opts())).rejects.toMatchObject({ code: 'concurrent_edit' });
    expect(await read()).toBe('{"someone": "else"}');
    expect(await inner.get(file)).toBeUndefined();
    expect(fs.readdirSync(path.dirname(file))).toEqual(['hooks.json']);
  });

  it('a concurrent creator of an absent file wins and nothing is owned', async () => {
    const inner = memoryReceiptStore();
    setAntigravityReceiptStore({
      get: (f) => inner.get(f),
      set: async (f, receipt) => {
        if (receipt?.pending) await fsp.writeFile(file, `{"clubhouse-status": ${VALUE}}`);
        await inner.set(f, receipt);
      },
    });
    await expect(insertOwnedMember(worktree, REL, { ...HOOK, valueJsonText: VALUE }, opts())).rejects.toMatchObject({ code: 'concurrent_edit' });
    expect(await inner.get(file)).toBeUndefined();
    setAntigravityReceiptStore(inner);
    expect(await removeOwnedMember(worktree, REL, HOOK, opts())).toMatchObject({ repair: expect.any(String) });
    expect(await read()).toBe(`{"clubhouse-status": ${VALUE}}`);
  });

  it('stores hashes only', async () => {
    await insertOwnedMember(worktree, REL, { ...HOOK, valueJsonText: VALUE }, opts());
    const receipt = JSON.stringify(await store.get(file));
    expect(receipt).not.toContain('clubhouse-hook');
    expect(receipt).toContain(JSON.stringify(slotOf(null, 'clubhouse-status')).slice(1, -1));
  });
});

describe('path containment', () => {
  it.each(['../outside.json', '.agents/../../x.json', '/abs.json'])('refuses %s', async (rel) => {
    await expect(insertOwnedMember(worktree, rel, { ...HOOK, valueJsonText: VALUE }, opts())).rejects.toMatchObject({ code: 'unsafe_path' });
  });

  it('refuses a linked .agents into HOME/.gemini without touching it', async () => {
    const target = path.join(home, '.gemini', 'config');
    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(path.join(target, 'hooks.json'), '{}');
    await fsp.symlink(target, path.join(worktree, '.agents'));
    await expect(insertOwnedMember(worktree, REL, { ...HOOK, valueJsonText: VALUE }, opts())).rejects.toMatchObject({ code: 'unsafe_path' });
    expect(await removeOwnedMember(worktree, REL, HOOK, opts())).toMatchObject({ repair: expect.any(String) });
    expect(await fsp.readFile(path.join(target, 'hooks.json'), 'utf-8')).toBe('{}');
    expect(fs.readdirSync(target)).toEqual(['hooks.json']);
  });

  it('refuses a linked hooks.json', async () => {
    const outside = path.join(tmp, 'outside.json');
    await fsp.writeFile(outside, '{}');
    await fsp.mkdir(path.join(worktree, '.agents'));
    await fsp.symlink(outside, file);
    await expect(insertOwnedMember(worktree, REL, { ...HOOK, valueJsonText: VALUE }, opts())).rejects.toMatchObject({ code: 'unsafe_path' });
    expect(await fsp.readFile(outside, 'utf-8')).toBe('{}');
  });
});

describe('swap failure recovery (QA B2)', () => {
  let realLink: typeof fsp.link;
  let realOpen: typeof fsp.open;
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    realLink = actual.link; realOpen = actual.open;
    vi.mocked(fsp.link).mockImplementation((...a) => realLink(...a));
    vi.mocked(fsp.open).mockImplementation((...a) => realOpen(...a));
  });

  it('a non-EEXIST link failure after the move puts the person\'s bytes back', async () => {
    await write(USER_HOOKS);
    vi.mocked(fsp.link).mockImplementationOnce(async () => { throw errno('EPERM'); });
    await expect(insertOwnedMember(worktree, REL, { ...HOOK, valueJsonText: VALUE }, opts())).rejects.toMatchObject({ code: 'write_failed' });
    expect(await read()).toBe(USER_HOOKS);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['hooks.json']);
    expect(await store.get(file)).toBeUndefined();
  });

  it('a failure reading the moved bytes puts them back', async () => {
    await write(USER_HOOKS);
    vi.mocked(fsp.open).mockImplementation(async (...a) => {
      if (String(a[0]).includes('.prev.')) throw errno('EIO');
      return realOpen(...a);
    });
    await expect(insertOwnedMember(worktree, REL, { ...HOOK, valueJsonText: VALUE }, opts())).rejects.toMatchObject({ code: 'write_failed' });
    expect(await read()).toBe(USER_HOOKS);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['hooks.json']);
  });

  it('when the bytes can\'t be put back, the error names where they are and nothing is deleted', async () => {
    await write(USER_HOOKS);
    vi.mocked(fsp.link).mockImplementation(async () => { throw errno('EPERM'); });
    const err = await insertOwnedMember(worktree, REL, { ...HOOK, valueJsonText: VALUE }, opts()).catch((e: unknown) => e) as AntigravityWorkspaceError;
    expect(err.code).toBe('concurrent_edit');
    const aside = fs.readdirSync(path.dirname(file)).find((n) => n.includes('.prev.'))!;
    expect(err.message).toContain(aside);
    expect(await fsp.readFile(path.join(path.dirname(file), aside), 'utf-8')).toBe(USER_HOOKS);
  });

  it('creating an absent file on a file system without hard links refuses and writes nothing', async () => {
    vi.mocked(fsp.link).mockImplementationOnce(async () => { throw errno('ENOTSUP'); });
    await expect(insertOwnedMember(worktree, REL, { ...HOOK, valueJsonText: VALUE }, opts())).rejects.toMatchObject({ code: 'write_failed' });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('crash after the move: the single matching saved copy is put back, never a fresh file', async () => {
    await write(USER_HOOKS);
    const aside = path.join(path.dirname(file), '.hooks.json.prev.deadbeef');
    await fsp.rename(file, aside);
    await store.set(file, { committed: emptyOwnership(), pending: { txid: 't', beforeHash: hashOf(USER_HOOKS), afterHash: hashOf('x') } });
    await insertOwnedMember(worktree, REL, { ...HOOK, valueJsonText: VALUE }, opts());
    expect(fs.existsSync(aside)).toBe(false);
    await removeOwnedMember(worktree, REL, HOOK, opts());
    expect(await read()).toBe(USER_HOOKS);
  });

  it('crash after the move with no matching copy: refused, no file created, pending kept', async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await store.set(file, { committed: emptyOwnership(), pending: { txid: 't', beforeHash: hashOf(USER_HOOKS), afterHash: hashOf('x') } });
    await expect(insertOwnedMember(worktree, REL, { ...HOOK, valueJsonText: VALUE }, opts())).rejects.toMatchObject({ code: 'interrupted' });
    expect(fs.existsSync(file)).toBe(false);
    expect(await removeOwnedMember(worktree, REL, HOOK, opts())).toMatchObject({ repair: expect.stringContaining('interrupted') });
    expect((await store.get(file))?.pending).toBeTruthy();
  });

  it('a planned delete that completed before its commit is simply settled', async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await store.set(file, { committed: { ...emptyOwnership(), created: true }, pending: { txid: 't', beforeHash: hashOf('{}'), afterHash: null } });
    expect(await removeOwnedMember(worktree, REL, HOOK, opts())).toBe('clean');
  });
});

describe('receipt store (QA B1)', () => {
  it('concurrent edits of different files through one real store file both commit', async () => {
    const storeFile = path.join(tmp, 'userData', 'receipts.json');
    setAntigravityReceiptStore(fileReceiptStore(() => storeFile));
    const trees = await Promise.all(Array.from({ length: 6 }, async (_, i) => {
      const wt = path.join(tmp, `wt${i}`);
      await fsp.mkdir(path.join(wt, '.agents'), { recursive: true });
      await fsp.writeFile(path.join(wt, REL), USER_HOOKS);
      return wt;
    }));
    await Promise.all(trees.map((wt) => insertOwnedMember(wt, REL, { ...HOOK, valueJsonText: VALUE }, opts())));
    const all = JSON.parse(await fsp.readFile(storeFile, 'utf-8')) as Record<string, { committed: { members: Record<string, string[]> }; pending?: unknown }>;
    expect(Object.keys(all)).toHaveLength(6);
    for (const entry of Object.values(all)) {
      expect(entry.pending).toBeUndefined();
      expect(entry.committed.members[slotOf(null, 'clubhouse-status')]).toHaveLength(1);
    }
    await Promise.all(trees.map((wt) => removeOwnedMember(wt, REL, HOOK, opts())));
    for (const wt of trees) expect(await fsp.readFile(path.join(wt, REL), 'utf-8')).toBe(USER_HOOKS);
    expect(JSON.parse(await fsp.readFile(storeFile, 'utf-8'))).toEqual({});
    expect(fs.statSync(storeFile).mode & 0o077).toBe(0);
  });

  it('a malformed store entry refuses rather than being trusted', async () => {
    const storeFile = path.join(tmp, 'userData', 'receipts.json');
    await fsp.mkdir(path.dirname(storeFile), { recursive: true });
    await write(USER_HOOKS);
    await fsp.writeFile(storeFile, JSON.stringify({ [file]: { committed: { members: 'nope' } } }));
    setAntigravityReceiptStore(fileReceiptStore(() => storeFile));
    await expect(insertOwnedMember(worktree, REL, { ...HOOK, valueJsonText: VALUE }, opts())).rejects.toMatchObject({ code: 'unparsable' });
    expect(await read()).toBe(USER_HOOKS);
  });
});
