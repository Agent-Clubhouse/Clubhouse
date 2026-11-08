import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

const mockGetPath = vi.fn(() => '/tmp/test-app');

vi.mock('electron', () => ({
  app: { getPath: (...args: unknown[]) => mockGetPath(...args as []) },
}));

const handle = vi.hoisted(() => ({
  writeFile: vi.fn(async () => {}),
  sync: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  readdirSync: vi.fn(() => []),
  rmSync: vi.fn(),
  promises: {
    writeFile: vi.fn(async () => {}),
    chmod: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
    open: vi.fn(async () => handle),
    stat: vi.fn(async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }),
  },
}));

import * as fs from 'fs';
import { createSettingsStore, resetAllSettingsStoresForTests } from './settings-store';

interface TestSettings {
  name: string;
  count: number;
  nested: { flag: boolean };
}

const DEFAULTS: TestSettings = {
  name: 'default',
  count: 0,
  nested: { flag: false },
};

describe('settings-store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPath.mockReturnValue('/tmp/test-app');
    resetAllSettingsStoresForTests();
  });

  describe('createSettingsStore', () => {
    it('returns an object with get, save, and update methods', () => {
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
      expect(store).toHaveProperty('get');
      expect(store).toHaveProperty('save');
      expect(store).toHaveProperty('update');
      expect(typeof store.get).toBe('function');
      expect(typeof store.save).toBe('function');
      expect(typeof store.update).toBe('function');
    });
  });

  describe('get', () => {
    it('returns defaults when file does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
      expect(store.get()).toEqual(DEFAULTS);
    });

    it('returns the same frozen reference on successive gets (no hot-path clone)', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
      const a = store.get();
      const b = store.get();
      expect(a).toEqual(b);
      expect(a).toBe(b);
      expect(Object.isFrozen(a)).toBe(true);
    });

    it('get() returns a frozen object', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ name: 'test', count: 1, nested: { flag: true } }));
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
      expect(Object.isFrozen(store.get())).toBe(true);
    });

    it('parses stored JSON and returns settings', () => {
      const saved: TestSettings = { name: 'custom', count: 42, nested: { flag: true } };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(saved));
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
      expect(store.get()).toEqual(saved);
    });

    it('preserves the loaded settings when a load observer throws', () => {
      const saved = { name: 'saved', count: 1, nested: { flag: true } };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(saved));
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const observer = vi.fn(() => { throw new Error('observer failed'); });
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS, undefined, { onLoad: observer });
      expect(store.get()).toEqual(saved);
      expect(store.get()).toEqual(saved);
      expect(observer).toHaveBeenCalledTimes(1);
      warning.mockRestore();
    });

    it('merges partial settings with defaults', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ name: 'partial' }));
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
      const result = store.get();
      expect(result.name).toBe('partial');
      expect(result.count).toBe(0);
      expect(result.nested).toEqual({ flag: false });
    });

    it('returns defaults on corrupt JSON', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('not valid json {{{');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
      expect(store.get()).toEqual(DEFAULTS);
    });

    it('warns on corrupt JSON when file exists', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(fs.readFileSync).mockReturnValue('corrupt');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
      store.get();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[settings-store] Failed to parse test.json'),
        expect.any(String),
      );
      warnSpy.mockRestore();
    });

    it('does not warn when file does not exist', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
      store.get();
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('returns defaults on empty string file content', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
      expect(store.get()).toEqual(DEFAULTS);
    });

    it('stored values override defaults with same keys', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ count: 99 }));
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
      const result = store.get();
      expect(result.count).toBe(99);
      expect(result.name).toBe('default');
    });

    it('reads from disk once after the cache is warm', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ name: 'cached', count: 7 }));
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);

      expect(store.get()).toEqual({ name: 'cached', count: 7, nested: { flag: false } });
      expect(store.get()).toEqual({ name: 'cached', count: 7, nested: { flag: false } });

      expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledTimes(1);
    });

    it('reads from the correct file path under userData', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const store = createSettingsStore<TestSettings>('my-settings.json', DEFAULTS);
      store.get();
      expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledWith(
        path.join('/tmp/test-app', 'my-settings.json'),
        'utf-8',
      );
    });
  });

  describe('save', () => {
    it('writes JSON to the correct file path asynchronously', async () => {
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
      const settings: TestSettings = { name: 'saved', count: 10, nested: { flag: true } };

      await store.save(settings);

      expect(vi.mocked(fs.promises.writeFile)).toHaveBeenCalledWith(
        path.join('/tmp/test-app', 'test.json'),
        expect.any(String),
        'utf-8',
      );
    });

    it('writes pretty-printed JSON', async () => {
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
      const settings: TestSettings = { name: 'pretty', count: 1, nested: { flag: false } };

      await store.save(settings);

      const written = vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string;
      expect(written).toBe(JSON.stringify(settings, null, 2));
    });

    it('updates the cache immediately before async persistence completes', async () => {
      let resolveWrite: (() => void) | undefined;
      vi.mocked(fs.promises.writeFile).mockImplementation(
        () => new Promise<void>((resolve) => { resolveWrite = resolve; }),
      );

      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
      const settings: TestSettings = { name: 'cached-save', count: 11, nested: { flag: true } };

      const savePromise = store.save(settings);

      expect(store.get()).toEqual(settings);
      expect(vi.mocked(fs.readFileSync)).not.toHaveBeenCalled();

      await vi.waitFor(() => {
        expect(vi.mocked(fs.promises.writeFile)).toHaveBeenCalledTimes(1);
      });
      resolveWrite?.();
      await savePromise;
    });

    it('round-trips from the in-memory cache after save', async () => {
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
      const settings: TestSettings = { name: 'round-trip', count: 77, nested: { flag: true } };

      await store.save(settings);

      expect(store.get()).toEqual(settings);
      expect(vi.mocked(fs.readFileSync)).not.toHaveBeenCalled();
    });

    it('queues writes in call order', async () => {
      const writeOrder: string[] = [];
      vi.mocked(fs.promises.writeFile).mockImplementation(async (_filePath, data) => {
        writeOrder.push(JSON.parse(String(data)).name);
      });

      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);

      await Promise.all([
        store.save({ name: 'first', count: 1, nested: { flag: false } }),
        store.save({ name: 'second', count: 2, nested: { flag: true } }),
      ]);

      expect(writeOrder).toEqual(['first', 'second']);
      expect(store.get().name).toBe('second');
    });
  });

  describe('multiple stores', () => {
    it('different filenames produce independent stores', async () => {
      const storeA = createSettingsStore<TestSettings>('store-a.json', DEFAULTS);
      const storeB = createSettingsStore<TestSettings>('store-b.json', { ...DEFAULTS, name: 'b-default' });

      await storeA.save({ name: 'a-value', count: 1, nested: { flag: false } });
      await storeB.save({ name: 'b-value', count: 2, nested: { flag: true } });

      const [callA, callB] = vi.mocked(fs.promises.writeFile).mock.calls;
      expect(callA[0]).toContain('store-a.json');
      expect(callB[0]).toContain('store-b.json');
    });
  });

  describe('userData path resolution', () => {
    // Regression test: createSettingsStore previously captured `app.getPath('userData')`
    // at construction time. That ran during module-load (e.g. when ipc/app-handlers
    // imported a settings module), which is *before* main/index.ts gets to call
    // `app.setPath('userData', CLUBHOUSE_USER_DATA)` for tests / dual-instance
    // workflows. The eager capture silently locked the store to the default
    // location, so test pre-seeded settings files in the override dir were ignored
    // and the IPC roundtrip returned defaults.
    it('reads from the current userData path on each get, not the path at construction', () => {
      mockGetPath.mockReturnValue('/tmp/initial');
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);

      // Simulate `app.setPath('userData', …)` running after the store was created.
      mockGetPath.mockReturnValue('/tmp/overridden');
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ name: 'from-override', count: 7, nested: { flag: true } }));

      expect(store.get()).toEqual({ name: 'from-override', count: 7, nested: { flag: true } });
      const readCall = vi.mocked(fs.readFileSync).mock.calls[0];
      expect(readCall[0]).toBe(path.join('/tmp/overridden', 'test.json'));
    });

    it('writes to the current userData path on each save, not the path at construction', async () => {
      mockGetPath.mockReturnValue('/tmp/initial');
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);

      mockGetPath.mockReturnValue('/tmp/overridden');
      await store.save({ name: 'written', count: 1, nested: { flag: false } });

      const writeCall = vi.mocked(fs.promises.writeFile).mock.calls[0];
      expect(writeCall[0]).toBe(path.join('/tmp/overridden', 'test.json'));
    });
  });

  describe('update', () => {
    it('reads current value, applies fn, and saves the result', async () => {
      const saved: TestSettings = { name: 'original', count: 5, nested: { flag: false } };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(saved));

      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
      const result = await store.update((current) => ({ ...current, count: current.count + 1 }));

      expect(result.count).toBe(6);
      expect(result.name).toBe('original');
      expect(vi.mocked(fs.promises.writeFile)).toHaveBeenCalledTimes(1);
      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.count).toBe(6);
    });

    it('returns the updated settings object', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(DEFAULTS));

      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
      const result = await store.update((current) => ({ ...current, name: 'updated' }));

      expect(result.name).toBe('updated');
    });

    it('uses defaults when file does not exist', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });

      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
      const result = await store.update((current) => ({ ...current, count: current.count + 10 }));

      expect(result.count).toBe(10);
      expect(result.name).toBe('default');
    });

    it('concurrent updates both apply without losing either write (LB-PS-2026-05-02)', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ name: 'initial', count: 0, nested: { flag: false } }));

      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);

      await Promise.all([
        store.update((current) => ({ ...current, name: 'from-update-1' })),
        store.update((current) => ({ ...current, count: 99 })),
      ]);

      const final = store.get();
      expect(final.name).toBe('from-update-1');
      expect(final.count).toBe(99);
    });

    it('sequential updates each see the result of the previous update', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ name: 'v1', count: 1, nested: { flag: false } }));

      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);

      await store.update((current) => ({ ...current, count: current.count + 1 }));
      await store.update((current) => ({ ...current, count: current.count + 1 }));

      expect(store.get().count).toBe(3);
      const writes = vi.mocked(fs.promises.writeFile).mock.calls.map(
        (call) => JSON.parse(call[1] as string).count,
      );
      expect(writes).toEqual([2, 3]);
    });
  });
});

// ── LB-SP-003: write errors logged (not silently swallowed) ──────────────

describe('file mode option', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPath.mockReturnValue('/tmp/test-app');
    resetAllSettingsStoresForTests();
  });

  it('creates the file with the mode and tightens an existing file to it', async () => {
    const store = createSettingsStore<TestSettings>('secret.json', DEFAULTS, undefined, { mode: 0o600 });
    await store.save({ ...DEFAULTS, name: 'x' });
    const filePath = path.join('/tmp/test-app', 'secret.json');
    expect(fs.promises.writeFile).toHaveBeenCalledWith(filePath, expect.any(String), { encoding: 'utf-8', mode: 0o600 });
    if (process.platform === 'win32') {
      expect(fs.promises.chmod).not.toHaveBeenCalled();
    } else {
      expect(fs.promises.chmod).toHaveBeenCalledWith(filePath, 0o600);
    }
  });

  it('leaves permissions alone without a mode', async () => {
    const store = createSettingsStore<TestSettings>('plain.json', DEFAULTS);
    await store.save(DEFAULTS);
    expect(fs.promises.chmod).not.toHaveBeenCalled();
  });
});

describe('atomic option', () => {
  const filePath = path.join('/tmp/test-app', 'atomic.json');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const setPlatform = (value: string) => Object.defineProperty(process, 'platform', { ...platform, value });
  const tempOf = (n = 0) => vi.mocked(fs.promises.open).mock.calls[n][0] as string;
  const atomicStore = (extra: { mode?: number } = {}) =>
    createSettingsStore<TestSettings>('atomic.json', DEFAULTS, undefined, { atomic: true, ...extra });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPath.mockReturnValue('/tmp/test-app');
    resetAllSettingsStoresForTests();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
  });

  it('writes and flushes a temp file beside the target, then renames it over the target', async () => {
    await atomicStore().save({ ...DEFAULTS, name: 'x' });
    const tmp = tempOf();
    expect(path.dirname(tmp)).toBe(path.dirname(filePath));
    expect(tmp).not.toBe(filePath);
    const body = handle.writeFile.mock.calls[0][0] as unknown as string;
    expect(JSON.parse(body).name).toBe('x');
    expect(handle.sync.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(fs.promises.rename).mock.invocationCallOrder[0]);
    expect(handle.close).toHaveBeenCalled();
    expect(fs.promises.rename).toHaveBeenCalledWith(tmp, filePath);
    expect(fs.promises.writeFile).not.toHaveBeenCalled();
  });

  it('uses a new temp name for each write', async () => {
    const store = atomicStore();
    await store.save({ ...DEFAULTS, count: 1 });
    await store.save({ ...DEFAULTS, count: 2 });
    expect(tempOf(0)).not.toBe(tempOf(1));
  });

  it.runIf(process.platform !== 'win32')('applies the mode to the temp file before the rename', async () => {
    await atomicStore({ mode: 0o600 }).save(DEFAULTS);
    const tmp = tempOf();
    expect(fs.promises.open).toHaveBeenCalledWith(tmp, 'w', 0o600);
    expect(fs.promises.chmod).toHaveBeenCalledWith(tmp, 0o600);
    expect(vi.mocked(fs.promises.chmod).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(fs.promises.rename).mock.invocationCallOrder[0]);
  });

  it.runIf(process.platform !== 'win32')('keeps the old file\'s permissions without a mode', async () => {
    vi.mocked(fs.promises.stat).mockResolvedValueOnce({ mode: 0o100600 } as fs.Stats);
    await atomicStore().save(DEFAULTS);
    expect(fs.promises.chmod).toHaveBeenCalledWith(tempOf(), 0o600);
  });

  it('removes the temp file and fails the save when the rename fails', async () => {
    vi.mocked(fs.promises.rename).mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'EXDEV' }));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(atomicStore().save(DEFAULTS)).rejects.toThrow('nope');
    expect(fs.promises.rm).toHaveBeenCalledWith(tempOf(), { force: true });
    consoleSpy.mockRestore();
  });

  it('retries a rename Windows briefly refuses', async () => {
    setPlatform('win32');
    vi.mocked(fs.promises.rename).mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EPERM' }));
    await atomicStore().save(DEFAULTS);
    expect(fs.promises.rename).toHaveBeenCalledTimes(2);
    expect(fs.promises.rm).not.toHaveBeenCalled();
  });

  it('does not retry elsewhere', async () => {
    setPlatform('linux');
    vi.mocked(fs.promises.rename).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EPERM' }));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(atomicStore().save(DEFAULTS)).rejects.toThrow('denied');
    expect(fs.promises.rename).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });

  it('removes temp files other processes left behind when it loads, and none of its own', () => {
    vi.mocked(fs.readdirSync).mockReturnValueOnce([
      'atomic.json',
      'atomic.json.tmp-1-1',
      `atomic.json.tmp-${process.pid}-7`,
      'other.json.tmp-1-1',
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    atomicStore().get();
    expect(fs.rmSync).toHaveBeenCalledTimes(1);
    expect(fs.rmSync).toHaveBeenCalledWith(path.join('/tmp/test-app', 'atomic.json.tmp-1-1'), { force: true });
  });

  it('sweeps nothing for a store that isn\'t atomic', () => {
    createSettingsStore<TestSettings>('plain.json', DEFAULTS).get();
    expect(fs.readdirSync).not.toHaveBeenCalled();
  });
});

describe('LB-SP-003: write errors are surfaced, not silently swallowed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPath.mockReturnValue('/tmp/test-app');
    resetAllSettingsStoresForTests();
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
  });

  it('logs write failure to console.error and re-throws so caller can detect it', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
    const writeError = new Error('ENOSPC: no space left on device');
    vi.mocked(fs.promises.writeFile).mockRejectedValue(writeError);

    await expect(store.save(DEFAULTS)).rejects.toThrow('ENOSPC');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('test.json'),
      expect.stringContaining('ENOSPC'),
    );
    errorSpy.mockRestore();
  });

  it('logs previous write failure at warn level and lets the next write proceed', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);

    let rejectFirst!: (err: Error) => void;
    let callCount = 0;
    // Each save is queued via the pendingWrite chain. First save returns a promise we control.
    vi.mocked(fs.promises.writeFile).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return new Promise<void>((_, reject) => {
          // Capture the rejector — called after both saves are queued
          rejectFirst = reject;
        });
      }
      return Promise.resolve();
    });

    // Queue two saves — both are queued before first rejects
    const save1 = store.save({ name: 'first', count: 1, nested: { flag: false } });
    const save2 = store.save({ name: 'second', count: 2, nested: { flag: true } });

    // Wait for the pendingWrite chain to advance so writeFile has been called for save1
    await vi.waitFor(() => { expect(callCount).toBeGreaterThanOrEqual(1); });

    rejectFirst(new Error('disk full'));

    // save1 rejects; save2 should still succeed because the .catch() swallows the prior error
    await expect(save1).rejects.toThrow();
    await expect(save2).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('test.json'),
      expect.stringContaining('disk full'),
    );
    warnSpy.mockRestore();
  });

  it('reject propagates to the caller — write errors are not silently swallowed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
    vi.mocked(fs.promises.writeFile).mockRejectedValue(new Error('write error'));

    await expect(store.save(DEFAULTS)).rejects.toThrow('write error');
  });

  describe('rollBackFailedSaves', () => {
    const named = (name: string): TestSettings => ({ ...DEFAULTS, name });

    it('keeps a failed save in memory by default, which some stores rely on', async () => {
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
      vi.mocked(fs.promises.writeFile).mockRejectedValueOnce(new Error('write error'));
      await expect(store.save(named('attempted'))).rejects.toThrow('write error');
      expect(store.get().name).toBe('attempted');
    });

    it('goes back to the value before a failed save when asked', async () => {
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS, undefined, { rollBackFailedSaves: true });
      await store.save(named('saved'));
      vi.mocked(fs.promises.writeFile).mockRejectedValueOnce(new Error('write error'));
      await expect(store.save(named('attempted'))).rejects.toThrow('write error');
      expect(store.get().name).toBe('saved');
    });

    it('doesn\'t undo a newer save that has replaced the failed one', async () => {
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS, undefined, { rollBackFailedSaves: true });
      vi.mocked(fs.promises.writeFile).mockRejectedValueOnce(new Error('write error'));
      const failed = store.save(named('attempted'));
      const newer = store.save(named('newer'));
      await expect(failed).rejects.toThrow('write error');
      await newer;
      expect(store.get().name).toBe('newer');
    });
  });
});
