import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHandoffQuarantine, handoffQuarantineFits, handoffQuarantineRoots, HANDOFF_QUARANTINE_MAX_AGE, sweepHandoffQuarantines } from './handoff-quarantine';

let fixture: string;
let staging: string;
let short: string;
beforeEach(() => {
  fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-q-test-')));
  staging = path.join(fixture, 'x'.repeat(100), 'y'.repeat(100));
  fs.mkdirSync(staging, { recursive: true });
  short = path.join(fixture, 'short');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(fixture, { recursive: true, force: true }); });
const create = (roots = [short]) => createHandoffQuarantine(staging, { roots, windows: true });
const old = (directory: string) => {
  const date = new Date(Date.now() - HANDOFF_QUARANTINE_MAX_AGE - 10_000);
  fs.utimesSync(directory, date, date);
};

it('keeps short staging local and relocates Windows directories exceeding the init limit', async () => {
  expect(handoffQuarantineFits(staging, false)).toBe(true);
  expect(handoffQuarantineFits('x'.repeat(254), true)).toBe(false);
  const local = await createHandoffQuarantine(fixture, { roots: [short], windows: true });
  expect(path.dirname(local.directory)).toBe(fixture);
  await local.cleanup();
  const external = await create();
  expect(path.dirname(external.directory)).toBe(short);
  expect(path.basename(external.directory)).toMatch(/^q-[a-f0-9]{32}$/);
  expect(handoffQuarantineFits(external.directory, true)).toBe(true);
  await external.cleanup();
  expect(fs.existsSync(external.directory)).toBe(false);
});

it('selects the shortest usable canonical root regardless of candidate order', async () => {
  const longer = path.join(fixture, 'longer-root');
  const owned = await create([longer, short]);
  expect(path.dirname(owned.directory)).toBe(short);
  expect(fs.existsSync(longer)).toBe(false);
  await owned.cleanup();
});

it('uses only absolute app-owned roots derived from temp and local app data', () => {
  vi.stubEnv('LOCALAPPDATA', fixture);
  expect(handoffQuarantineRoots()).toContainEqual(expect.stringMatching(new RegExp('ch-q-[a-f0-9]{12}$')));
  expect(handoffQuarantineRoots()).toContain(path.join(fixture, path.basename(handoffQuarantineRoots()[0])));
  vi.stubEnv('LOCALAPPDATA', 'relative');
  expect(handoffQuarantineRoots().every(path.isAbsolute)).toBe(true);
});

it('creates unique private directories and rejects a symlink root', async () => {
  const first = await create(); const second = await create();
  expect(first.directory).not.toBe(second.directory);
  if (process.platform !== 'win32') {
    for (const directory of [short, first.directory, second.directory]) expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
  }
  const link = path.join(fixture, 'link');
  fs.symlinkSync(short, link, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(create([link])).rejects.toThrow('No safe short');
  await first.cleanup(); await second.cleanup();
});

it.skipIf(process.platform === 'win32')('rejects an app root accessible by other users', async () => {
  fs.mkdirSync(short, { mode: 0o755 });
  await expect(create()).rejects.toThrow('No safe short');
});

it('cleans only the owned directory and refuses a replacement symlink', async () => {
  const owned = await create();
  const moved = `${owned.directory}-moved`;
  fs.renameSync(owned.directory, moved);
  fs.symlinkSync(moved, owned.directory, process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(moved, 'keep'), 'keep');
  await expect(owned.assertCurrent()).rejects.toThrow('Unsafe');
  await expect(owned.cleanup()).rejects.toThrow('Unsafe');
  expect(fs.readFileSync(path.join(moved, 'keep'), 'utf8')).toBe('keep');
});

it('sweeps stale exact names on restart, preserving fresh/active dirs, links, files and near matches', async () => {
  const active = await create(); old(active.directory);
  const stale = path.join(short, `q-${'a'.repeat(32)}`);
  const fresh = path.join(short, `q-${'b'.repeat(32)}`);
  const names = ['quarantine-old', `q-${'a'.repeat(31)}`, `q-${'D'.repeat(32)}`, `q-${'c'.repeat(32)}-backup`, `prefix-q-${'d'.repeat(32)}`];
  if (process.platform !== 'win32') names.push(`q-${'9'.repeat(32)}\n`);
  for (const directory of [stale, fresh, ...names.map((name) => path.join(short, name))]) fs.mkdirSync(directory, { mode: 0o700 });
  old(stale);
  for (const name of names) old(path.join(short, name));
  const outside = path.join(fixture, 'outside'); fs.mkdirSync(outside); old(outside);
  const link = path.join(short, `q-${'e'.repeat(32)}`);
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const file = path.join(short, `q-${'f'.repeat(32)}`); fs.writeFileSync(file, 'keep'); old(file);
  await sweepHandoffQuarantines({ roots: [short] });
  expect(fs.existsSync(stale)).toBe(false);
  for (const directory of [active.directory, fresh, link, outside, file, ...names.map((name) => path.join(short, name))]) expect(fs.existsSync(directory)).toBe(true);
  await active.cleanup();
  // Simulate a crashed process: a stale directory is discovered without an in-memory handle.
  old(fresh);
  await sweepHandoffQuarantines({ roots: [short] });
  expect(fs.existsSync(fresh)).toBe(false);
});

it('cleans partial contents before Git has initialized', async () => {
  // The handle can be cleaned even if no Git repository was created.
  const owned = await create();
  fs.writeFileSync(path.join(owned.directory, 'partial'), 'unverified');
  await owned.cleanup();
  expect(fs.readdirSync(short)).toEqual([]);
});
