import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-app' },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  promises: {
    writeFile: vi.fn(async () => {}),
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

    it('returns a copy of defaults, not the same reference', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
      const a = store.get();
      const b = store.get();
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
      expect(a.nested).not.toBe(b.nested);
    });

    it('parses stored JSON and returns settings', () => {
      const saved: TestSettings = { name: 'custom', count: 42, nested: { flag: true } };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(saved));
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
      expect(store.get()).toEqual(saved);
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
