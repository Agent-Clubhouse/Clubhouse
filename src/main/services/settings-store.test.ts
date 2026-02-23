import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-app' },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  writeFileSync: vi.fn(),
}));

import * as fs from 'fs';
import { createSettingsStore } from './settings-store';

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
  });

  describe('createSettingsStore', () => {
    it('returns an object with get and save methods', () => {
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
      expect(store).toHaveProperty('get');
      expect(store).toHaveProperty('save');
      expect(typeof store.get).toBe('function');
      expect(typeof store.save).toBe('function');
    });
  });

  describe('get', () => {
    it('returns defaults when file does not exist (readFileSync throws)', () => {
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

    it('reads from the correct file path under userData', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const store = createSettingsStore<TestSettings>('my-settings.json', DEFAULTS);
      store.get();
      expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledWith(
        '/tmp/test-app/my-settings.json',
        'utf-8',
      );
    });
  });

  describe('save', () => {
    it('writes JSON to the correct file path', () => {
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
      const settings: TestSettings = { name: 'saved', count: 10, nested: { flag: true } };
      store.save(settings);
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
        '/tmp/test-app/test.json',
        expect.any(String),
        'utf-8',
      );
    });

    it('writes pretty-printed JSON', () => {
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
      const settings: TestSettings = { name: 'pretty', count: 1, nested: { flag: false } };
      store.save(settings);
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toBe(JSON.stringify(settings, null, 2));
    });

    it('round-trips: saved settings can be read back', () => {
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
      const settings: TestSettings = { name: 'round-trip', count: 77, nested: { flag: true } };
      store.save(settings);
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      vi.mocked(fs.readFileSync).mockReturnValue(written);
      expect(store.get()).toEqual(settings);
    });

    it('can overwrite previously saved settings', () => {
      const store = createSettingsStore<TestSettings>('test.json', DEFAULTS);
      store.save({ name: 'first', count: 1, nested: { flag: false } });
      store.save({ name: 'second', count: 2, nested: { flag: true } });
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledTimes(2);
      const lastWritten = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[1][1] as string);
      expect(lastWritten.name).toBe('second');
    });
  });

  describe('multiple stores', () => {
    it('different filenames produce independent stores', () => {
      const storeA = createSettingsStore<TestSettings>('store-a.json', DEFAULTS);
      const storeB = createSettingsStore<TestSettings>('store-b.json', { ...DEFAULTS, name: 'b-default' });

      storeA.save({ name: 'a-value', count: 1, nested: { flag: false } });
      storeB.save({ name: 'b-value', count: 2, nested: { flag: true } });

      const [callA, callB] = vi.mocked(fs.writeFileSync).mock.calls;
      expect(callA[0]).toContain('store-a.json');
      expect(callB[0]).toContain('store-b.json');
    });
  });
});
