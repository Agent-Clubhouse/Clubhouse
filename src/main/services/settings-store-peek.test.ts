import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
vi.mock('fs', async (original) => { const real = await original<typeof import('fs')>(); return { ...real, readSync: vi.fn(real.readSync) }; });
import { peekStoredSettings, peekStoredSettingsSync } from './settings-store';
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-bounded-settings-')); vi.spyOn(app, 'getPath').mockReturnValue(root); vi.mocked(fs.readSync).mockClear(); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
const target = () => path.join(root, 'display.json');
it('bounds a passive settings peek before reading an oversized primary and preserves unbounded legacy callers', async () => {
  fs.writeFileSync(target(), JSON.stringify({ content: 'x'.repeat(4096) }));
  expect.soft(peekStoredSettingsSync('display.json', { maxBytes: 128 })).toBe('unreadable');
  expect.soft(vi.mocked(fs.readSync)).not.toHaveBeenCalled();
  expect.soft(await peekStoredSettings('display.json', { maxBytes: 128 })).toBe('unreadable');
  expect(peekStoredSettingsSync('display.json')).toMatchObject({ content: 'x'.repeat(4096) });
  expect(await peekStoredSettings('display.json')).toMatchObject({ content: 'x'.repeat(4096) });
});
it('accepts exact byte bounds, distinguishes verified missing/empty from malformed data, and does not recover or sweep', async () => {
  fs.writeFileSync(path.join(root, 'display.json.bak'), '{"enabled":true}');
  const temp = path.join(root, `.display.json.tmp-${process.pid + 100000}-1`); fs.writeFileSync(temp, 'left alone'); const old = new Date(Date.now() - 3 * 86400000); fs.utimesSync(temp, old, old);
  const before = fs.readdirSync(root).sort();
  expect(peekStoredSettingsSync('display.json', { maxBytes: 64 })).toBe('missing');
  expect(await peekStoredSettings('display.json', { maxBytes: 64 })).toBe('missing');
  for (const [bytes, expected] of [['{}', {}], ['[]', 'unreadable'], ['null', 'unreadable'], ['{broken', 'unreadable']] as const) {
    fs.writeFileSync(target(), bytes);
    expect(peekStoredSettingsSync('display.json', { maxBytes: Buffer.byteLength(bytes) })).toEqual(expected);
    expect(await peekStoredSettings('display.json', { maxBytes: Buffer.byteLength(bytes) })).toEqual(expected);
  }
  fs.writeFileSync(target(), Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
  expect(peekStoredSettingsSync('display.json', { maxBytes: 64 })).toBe('unreadable');
  expect(await peekStoredSettings('display.json', { maxBytes: 64 })).toBe('unreadable');
  expect(fs.readdirSync(root).sort()).toEqual([...before, 'display.json'].sort());
  expect(fs.readFileSync(temp, 'utf8')).toBe('left alone');
  expect(fs.readFileSync(path.join(root, 'display.json.bak'), 'utf8')).toBe('{"enabled":true}');
});
it.each(['replace', 'rewrite'])('refuses primary %s during a bounded synchronous read and closes its descriptor', async (mode) => {
  fs.writeFileSync(target(), '{"enabled":false}');
  const real = await vi.importActual<typeof import('fs')>('fs'); let admittedFd: number | undefined;
  vi.mocked(fs.readSync).mockImplementationOnce((...args) => {
    admittedFd = args[0]; const bytes = Reflect.apply(real.readSync, real, args);
    if (mode === 'replace') real.renameSync(target(), `${target()}.old`);
    real.writeFileSync(target(), '{"enabled":true}'); return bytes;
  });
  expect(peekStoredSettingsSync('display.json', { maxBytes: 128 })).toBe('unreadable');
  expect(admittedFd).toBeTypeOf('number');
  expect(() => real.fstatSync(admittedFd!)).toThrow();
  expect(real.readFileSync(target(), 'utf8')).toBe('{"enabled":true}');
});
it('refuses directories and invalid caller budgets without normalizing them to verified empty', () => {
  fs.mkdirSync(target());
  expect(peekStoredSettingsSync('display.json', { maxBytes: 64 })).toBe('unreadable');
  fs.rmdirSync(target()); fs.writeFileSync(target(), '{}');
  for (const maxBytes of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER]) expect(peekStoredSettingsSync('display.json', { maxBytes })).toBe('unreadable');
});

it('refuses primary replacement across an awaited bounded read and closes its descriptor', async () => {
  fs.writeFileSync(target(), '{"enabled":false}');
  const open = fs.promises.open.bind(fs.promises); let observed = false; let file: Awaited<ReturnType<typeof open>> | undefined;
  vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args) => {
    file = await open(...args); const read = file.read.bind(file);
    vi.spyOn(file, 'read').mockImplementationOnce(async (...readArgs: Parameters<Awaited<ReturnType<typeof open>>['read']>) => {
      const result = await Reflect.apply(read, file, readArgs);
      fs.renameSync(target(), `${target()}.old`); fs.writeFileSync(target(), '{"enabled":true}'); observed = true; return result;
    });
    return file;
  });
  expect(await peekStoredSettings('display.json', { maxBytes: 128 })).toBe('unreadable');
  expect(observed).toBe(true); expect(file).toBeDefined();
  await expect(file!.stat()).rejects.toThrow();
});
it.skipIf(process.platform === 'win32')('can read a configured link to an ordinary metadata file while pinning its opened target', async () => {
  fs.writeFileSync(path.join(root, 'actual.json'), '{"enabled":false}'); fs.symlinkSync(path.join(root, 'actual.json'), target());
  expect(peekStoredSettingsSync('display.json', { maxBytes: 64 })).toEqual({ enabled: false });
  expect(await peekStoredSettings('display.json', { maxBytes: 64 })).toEqual({ enabled: false });
});
