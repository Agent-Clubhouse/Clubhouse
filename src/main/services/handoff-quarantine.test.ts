import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHandoffQuarantine, handoffQuarantineFits, handoffQuarantineRoots, HANDOFF_QUARANTINE_MAX_AGE, sweepHandoffQuarantines, windowsHandoffQuarantineRoots } from './handoff-quarantine';
import * as windowsQuarantine from './handoff-quarantine-windows';
import * as logging from './log-service';
import { quarantineFailureCapture } from '../../../test/handoff-quarantine-diagnostics';

let fixture: string;
let staging: string;
let short: string;
beforeEach(async () => {
  fixture = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-q-test-')));
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

it('uses only profile-local LOCALAPPDATA on Windows, ignoring shared or custom temp', () => {
  expect(windowsHandoffQuarantineRoots('C:\\Users\\me\\AppData\\Local', 'C:\\Users\\me')).toEqual(['C:\\Users\\me\\AppData\\Local\\ch-q']);
  for (const candidate of [undefined, 'relative', 'C:\\Temp', 'D:\\Shared', 'C:\\Users\\me-other', 'C:\\Users\\me\\..\\other']) {
    expect(windowsHandoffQuarantineRoots(candidate, 'C:\\Users\\me')).toEqual([]);
  }
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
  await expect(create([link])).rejects.toMatchObject({ code: 'git_failed', message: expect.stringContaining('stderr=path_too_long.') });
  await first.cleanup(); await second.cleanup();
});

it.skipIf(process.platform === 'win32')('rejects an app root accessible by other users', async () => {
  fs.mkdirSync(short, { mode: 0o755 });
  await expect(create()).rejects.toMatchObject({ code: 'git_failed', message: expect.stringContaining('stderr=path_too_long.') });
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

it.skipIf(process.platform === 'win32')('tries the next root when the shortest private root is unwritable', async () => {
  fs.mkdirSync(short, { mode: 0o500 });
  const longer = path.join(fixture, 'longer-root');
  try {
    const owned = await create([short, longer]);
    expect(path.dirname(owned.directory)).toBe(longer);
    await owned.cleanup();
  } finally { fs.chmodSync(short, 0o700); }
});

it.skipIf(process.platform === 'win32')('skips deletion when an app-root ancestor is replaced by a symlink', async () => {
  const owned = await create();
  await owned.cleanup();
  const staleName = `q-${'8'.repeat(32)}`;
  const stale = path.join(short, staleName); fs.mkdirSync(stale, { mode: 0o700 }); old(stale);
  const outside = path.join(fixture, 'outside'); fs.mkdirSync(outside, { mode: 0o700 });
  const victim = path.join(outside, staleName); fs.mkdirSync(victim, { mode: 0o700 });
  fs.writeFileSync(path.join(victim, 'keep'), 'keep');
  const readdir = fs.promises.readdir;
  let swapped = false;
  vi.spyOn(fs.promises, 'readdir').mockImplementation(async (...args: Parameters<typeof readdir>) => {
    const result = await readdir(...args);
    if (args[0] === stale && !swapped) {
      swapped = true;
      fs.renameSync(short, `${short}-moved`);
      fs.symlinkSync(outside, short, 'dir');
    }
    return result;
  });
  await sweepHandoffQuarantines({ roots: [short] });
  expect(swapped).toBe(true);
  expect(fs.readFileSync(path.join(victim, 'keep'), 'utf8')).toBe('keep');
});

it.skipIf(process.platform !== 'win32')('rejects a junction anywhere in the external root ancestor chain', async () => {
  const parent = path.join(fixture, 'parent'); fs.mkdirSync(parent);
  const junction = path.join(fixture, 'junction'); fs.symlinkSync(parent, junction, 'junction');
  await expect(create([path.join(junction, 'q')])).rejects.toMatchObject({ code: 'git_failed', message: expect.stringContaining('stderr=path_too_long.') });
  expect(fs.readdirSync(parent)).toEqual([]);
});

it.skipIf(process.platform !== 'win32')('refuses allocation and sweeping under an unverified inherited Windows ACL', async () => {
  fs.mkdirSync(short);
  const stale = path.join(short, `q-${'7'.repeat(32)}`); fs.mkdirSync(stale); old(stale);
  await expect(create()).rejects.toMatchObject({ code: 'git_failed', message: expect.stringContaining('stderr=path_too_long.') });
  await sweepHandoffQuarantines({ roots: [short] });
  expect(fs.readdirSync(short)).toEqual([path.basename(stale)]);
}, 30_000);

// Injected verification: deterministic on every platform.
const failClosed = { code: 'git_failed', message: expect.stringContaining('stderr=path_too_long.') };
const options = (verify: (directory: string, created: boolean) => Promise<void>, inspect?: (directory: string) => Promise<boolean>) =>
  ({ roots: [short], windows: true, verify, inspect, retryDelay: 1 });
const deny = () => Object.assign(new Error('Unverified Windows quarantine root.'), { code: 1 });
const timeout = () => Object.assign(new Error('timeout'), { killed: true });

it('removes a root it just created when verification fails, so the next attempt initializes it again', async () => {
  const verify = vi.fn().mockRejectedValueOnce(deny()).mockResolvedValue(undefined);
  const owned = await createHandoffQuarantine(staging, options(verify));
  expect(verify.mock.calls.map((call) => call[1])).toEqual([true, true]);
  expect(path.dirname(owned.directory)).toBe(short);
  await owned.cleanup();
});

it('fails closed without Git and leaves nothing behind when every attempt on a fresh root fails verification', async () => {
  const verify = vi.fn().mockRejectedValue(deny());
  await expect(createHandoffQuarantine(staging, options(verify))).rejects.toMatchObject(failClosed);
  expect(verify).toHaveBeenCalledTimes(3);
  expect(fs.existsSync(short)).toBe(false);
});

it('retries an existing root that is still being initialized by a concurrent creator', async () => {
  fs.mkdirSync(short, { mode: 0o700 });
  const verify = vi.fn().mockRejectedValueOnce(deny()).mockResolvedValue(undefined);
  const owned = await createHandoffQuarantine(staging, options(verify));
  expect(verify.mock.calls.map((call) => call[1])).toEqual([false, false]);
  expect(path.dirname(owned.directory)).toBe(short);
  await owned.cleanup();
});

it('recovers an empty, owned, non-reparse root left unverifiable by an earlier timed-out create', async () => {
  fs.mkdirSync(short, { mode: 0o700 });
  const verify = vi.fn(async (directory: string, created: boolean) => { if (!created) throw deny(); });
  const inspect = vi.fn().mockResolvedValue(true);
  const owned = await createHandoffQuarantine(staging, options(verify, inspect));
  expect(inspect).toHaveBeenCalledTimes(1);
  expect(verify.mock.calls.map((call) => call[1])).toEqual([false, false, false, true]);
  expect(path.dirname(owned.directory)).toBe(short);
  await owned.cleanup();
});

it('never recovers a non-empty root, and leaves its contents untouched', async () => {
  fs.mkdirSync(short, { mode: 0o700 });
  fs.writeFileSync(path.join(short, 'keep'), 'keep');
  const verify = vi.fn(async (directory: string, created: boolean) => { if (!created) throw deny(); });
  const inspect = vi.fn().mockResolvedValue(true);
  await expect(createHandoffQuarantine(staging, options(verify, inspect))).rejects.toMatchObject(failClosed);
  expect(fs.readFileSync(path.join(short, 'keep'), 'utf8')).toBe('keep');
  expect(verify.mock.calls.every((call) => call[1] === false)).toBe(true);
});

it('never recovers a root another user owns', async () => {
  fs.mkdirSync(short, { mode: 0o700 });
  const verify = vi.fn(async (directory: string, created: boolean) => { if (!created) throw deny(); });
  const inspect = vi.fn().mockResolvedValue(false);
  await expect(createHandoffQuarantine(staging, options(verify, inspect))).rejects.toMatchObject(failClosed);
  expect(inspect).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(short)).toBe(true);
  expect(verify.mock.calls.every((call) => call[1] === false)).toBe(true);
});

it('never recovers a reparse point, and never touches its target', async () => {
  const target = path.join(fixture, 'target'); fs.mkdirSync(target, { mode: 0o700 });
  fs.writeFileSync(path.join(target, 'keep'), 'keep');
  const link = path.join(fixture, 'link');
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  const verify = vi.fn().mockResolvedValue(undefined);
  const inspect = vi.fn().mockResolvedValue(true);
  await expect(createHandoffQuarantine(staging, { roots: [link], windows: true, verify, inspect, retryDelay: 1 })).rejects.toMatchObject(failClosed);
  expect(inspect).not.toHaveBeenCalled();
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(path.join(target, 'keep'), 'utf8')).toBe('keep');
});

it('attempts recovery only once, and fails closed if the re-created root still does not verify', async () => {
  fs.mkdirSync(short, { mode: 0o700 });
  const verify = vi.fn().mockRejectedValue(deny());
  const inspect = vi.fn().mockResolvedValue(true);
  await expect(createHandoffQuarantine(staging, options(verify, inspect))).rejects.toMatchObject(failClosed);
  expect(inspect).toHaveBeenCalledTimes(1);
  expect(verify.mock.calls.map((call) => call[1])).toEqual([false, false, false, true]);
  expect(fs.existsSync(short)).toBe(false);
});

it('fails closed when no inspection is available, never recovering on its own say-so', async () => {
  fs.mkdirSync(short, { mode: 0o700 });
  const verify = vi.fn(async (directory: string, created: boolean) => { if (!created) throw deny(); });
  await expect(createHandoffQuarantine(staging, options(verify))).rejects.toMatchObject(failClosed);
  expect(verify.mock.calls.every((call) => call[1] === false)).toBe(true);
  expect(fs.existsSync(short)).toBe(true);
});

it.each([['existing', true], ['fresh', false]] as const)('stops at the first timed-out verification of a %s root instead of retrying or recovering', async (_kind, existing) => {
  const capture = quarantineFailureCapture();
  const log = logging.appLog;
  vi.spyOn(logging, 'appLog').mockImplementation((namespace, level, message, options) => {
    capture.record(namespace, message, options?.meta);
    log(namespace, level, message, options);
  });
  if (existing) fs.mkdirSync(short, { mode: 0o700 });
  const verify = vi.fn().mockRejectedValue(timeout());
  const inspect = vi.fn().mockResolvedValue(true);
  await expect(createHandoffQuarantine(staging, options(verify, inspect))).rejects.toMatchObject(failClosed);
  expect(verify).toHaveBeenCalledTimes(1);
  expect(inspect).not.toHaveBeenCalled();
  expect(fs.existsSync(short)).toBe(existing);
  expect(capture.snapshot()).toEqual({ events: [
    { event: 'root_rejected', failure: 'verify:timeout', attempt: 1, created: !existing, elapsedMs: expect.any(Number) },
    { event: 'allocation_rejected', eligible: 1, canonical: 1, fitting: 1, admitted: false, elapsedMs: expect.any(Number) },
  ], dropped: 0 });
});

it.each(['ineligible', 'canonical', 'length'] as const)('reports the %s admission gate without disclosing candidate text', async (gate) => {
  const capture = quarantineFailureCapture();
  vi.spyOn(logging, 'appLog').mockImplementation((namespace, _level, message, options) => capture.record(namespace, message, options?.meta));
  const roots = gate === 'ineligible' ? [] : gate === 'canonical' ? [path.join(short, 'missing-parent', 'root')] : [path.join(fixture, 'x'.repeat(260))];
  await expect(createHandoffQuarantine(staging, { roots, windows: true })).rejects.toMatchObject(failClosed);
  const { events } = capture.snapshot();
  expect(events.at(-1)).toEqual({ event: 'allocation_rejected', eligible: gate === 'ineligible' ? 0 : 1, canonical: gate === 'length' ? 1 : 0, fitting: 0, admitted: false, elapsedMs: expect.any(Number) });
  if (gate === 'canonical') expect(events[0]).toMatchObject({ event: 'root_rejected', failure: 'canonical:other' });
  expect(JSON.stringify(events)).not.toContain(fixture);
});

it('removes its child and fails closed if the verified root is replaced while the child is created', async () => {
  const verify = vi.fn().mockResolvedValue(undefined);
  const mkdir = fs.promises.mkdir;
  let swapped = false;
  let mkdirCalls = 0;
  const rootIdentity = (directory = short) => {
    const numeric = fs.lstatSync(directory);
    const exact = fs.lstatSync(directory, { bigint: true });
    return {
      dev: numeric.dev, ino: numeric.ino, safeDev: Number.isSafeInteger(numeric.dev), safeIno: Number.isSafeInteger(numeric.ino),
      exactDev: exact.dev.toString(), exactIno: exact.ino.toString(),
    };
  };
  let before: ReturnType<typeof rootIdentity> | undefined;
  let after: ReturnType<typeof rootIdentity> | undefined;
  let moved: ReturnType<typeof rootIdentity> | undefined;
  let afterChild: ReturnType<typeof rootIdentity> | undefined;
  vi.spyOn(fs.promises, 'mkdir').mockImplementation(async (...args: Parameters<typeof mkdir>) => {
    mkdirCalls++;
    if (!swapped && /^q-[a-f0-9]{32}$/.test(path.basename(args[0].toString()))) {
      // A racing recovery removes the verified root and re-creates an uninitialized one.
      before = rootIdentity();
      swapped = true;
      // Keep the original alive so the replacement cannot reuse its inode.
      fs.renameSync(short, `${short}-moved`); fs.mkdirSync(short, { mode: 0o700 });
      moved = rootIdentity(`${short}-moved`);
      after = rootIdentity();
    }
    const result = await mkdir(...args);
    if (swapped) afterChild = rootIdentity();
    return result;
  });
  const diagnostic = (outcome: string) => process.stdout.write(`QUARANTINE_ROOT_SWAP ${JSON.stringify({
    platform: process.platform, node: process.version, mkdirCalls, swapped, before, moved, after, afterChild,
    verifyCalls: verify.mock.calls.length, outcome,
  })}\n`);
  const allocation = createHandoffQuarantine(staging, options(verify)).then(
    (handle) => { diagnostic('resolved'); return handle; },
    (error) => { diagnostic('rejected'); throw error; },
  );
  await expect(allocation).rejects.toMatchObject(failClosed);
  expect(swapped).toBe(true);
  expect(before).toBeDefined();
  expect(after).toBeDefined();
  expect(moved).toEqual(before);
  expect(afterChild).toEqual(after);
  expect([after?.exactDev, after?.exactIno]).not.toEqual([before?.exactDev, before?.exactIno]);
  expect(fs.readdirSync(short)).toEqual([]);
});

/** Controlled identity precision case, not evidence of the original Windows run's IDs. */
function collidingRootIdentity(field: 'dev' | 'ino', replace: boolean): () => boolean {
  const first = 2n ** 60n;
  const second = first + 1n;
  expect(first).not.toBe(second);
  expect(Number(first)).toBe(Number(second));
  const lstat = fs.promises.lstat;
  const mkdir = fs.promises.mkdir;
  let childCreated = false;
  vi.spyOn(fs.promises, 'lstat').mockImplementation((async (file: fs.PathLike, options?: fs.StatOptions) => {
    const stat = await lstat(file, options);
    if (file.toString() === short) {
      const value = replace && childCreated ? second : first;
      Object.assign(stat, { [field]: options?.bigint ? value : Number(value) });
    }
    return stat;
  }) as typeof fs.promises.lstat);
  vi.spyOn(fs.promises, 'mkdir').mockImplementation(async (...args: Parameters<typeof mkdir>) => {
    const result = await mkdir(...args);
    if (/^q-[a-f0-9]{32}$/.test(path.basename(args[0].toString()))) childCreated = true;
    return result;
  });
  return () => childCreated;
}

it.each(['dev', 'ino'] as const)('rejects a replaced root when distinct exact %s identities collide as numbers', async (field) => {
  const childCreated = collidingRootIdentity(field, true);
  await expect(createHandoffQuarantine(staging, options(vi.fn().mockResolvedValue(undefined)))).rejects.toMatchObject(failClosed);
  expect(childCreated()).toBe(true);
  expect(fs.readdirSync(short)).toEqual([]);
});

it.each(['dev', 'ino'] as const)('accepts and cleans an unchanged exact %s identity above the safe-number range', async (field) => {
  const childCreated = collidingRootIdentity(field, false);
  const owned = await createHandoffQuarantine(staging, options(vi.fn().mockResolvedValue(undefined)));
  expect(childCreated()).toBe(true);
  await owned.assertCurrent();
  await owned.cleanup();
  expect(fs.readdirSync(short)).toEqual([]);
});

it.each(['dev', 'ino'] as const)('refuses cleanup when an entry exact %s changes despite a numeric identity collision', async (field) => {
  const owned = await create();
  const entry = path.join(owned.directory, 'keep');
  fs.writeFileSync(entry, 'keep');
  const lstat = fs.promises.lstat;
  let observations = 0;
  vi.spyOn(fs.promises, 'lstat').mockImplementation((async (file: fs.PathLike, options?: fs.StatOptions) => {
    const stat = await lstat(file, options);
    if (file.toString() === entry) {
      const value = 2n ** 60n + (observations++ === 0 ? 0n : 1n);
      Object.assign(stat, { [field]: options?.bigint ? value : Number(value) });
    }
    return stat;
  }) as typeof fs.promises.lstat);
  await expect(owned.cleanup()).rejects.toThrow('Handoff quarantine entry changed.');
  expect(observations).toBeGreaterThanOrEqual(2);
  expect(fs.readFileSync(entry, 'utf8')).toBe('keep');
});

it.each([
  ['exact age limit', 0, false],
  ['older than the age limit', 1, true],
  ['future modification time', -HANDOFF_QUARANTINE_MAX_AGE - 1, false],
  ['fractional injected millisecond', 0.75, false],
] as const)('preserves sweep cutoff for %s', async (_case, offset, removed) => {
  // Time-policy test: isolate ACL verification, leaving directory/no-follow identity guards real.
  vi.spyOn(windowsQuarantine, 'verifyWindowsQuarantineRoot').mockResolvedValue(undefined);
  fs.mkdirSync(short, { mode: 0o700 });
  const entry = path.join(short, `q-${'1'.repeat(32)}`);
  fs.mkdirSync(entry, { mode: 0o700 });
  const modified = 1_000_000_000_000;
  fs.utimesSync(entry, modified / 1000, modified / 1000);
  await sweepHandoffQuarantines({ roots: [short], now: modified + HANDOFF_QUARANTINE_MAX_AGE + offset });
  expect(fs.existsSync(entry)).toBe(!removed);
});
