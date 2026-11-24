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

import {
  AntigravityWorkspaceError, emptyOwnership, insertOwnedMember, memoryReceiptStore, removeOwnedMember,
  setAntigravityReceiptStore, slotOf, TOP_LEVEL_SKELETON, type ReceiptStore,
} from './workspace-json';

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
