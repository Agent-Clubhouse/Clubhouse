import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { decodeImportState, encodeImportState, ImportStore, IMPORT_HISTORY_MAX, IMPORT_STATE_MAX_BYTES } from './store';
import { IMPORT_EFFECTS, type ImportPlan, type ImportState } from './types';

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
});
