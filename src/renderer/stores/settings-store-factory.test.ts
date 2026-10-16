import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SettingsDefinition } from '../../shared/settings-definitions';
import { createSettingsStore } from './settings-store-factory';

// Mock the preload bridge
const mockGet = vi.fn();
const mockSave = vi.fn();

vi.stubGlobal('window', {
  clubhouse: {
    settings: {
      get: mockGet,
      save: mockSave,
    },
  },
});

interface TestSettings {
  enabled: boolean;
  count: number;
}

const TEST_DEF: SettingsDefinition<TestSettings> = {
  key: 'test',
  filename: 'test-settings.json',
  defaults: { enabled: false, count: 0 },
};

describe('settings-store-factory', () => {
  let useStore: ReturnType<typeof createSettingsStore<TestSettings>>;

  beforeEach(() => {
    mockGet.mockReset().mockResolvedValue(null);
    mockSave.mockReset().mockResolvedValue(undefined);
    useStore = createSettingsStore(TEST_DEF);
  });

  describe('initial state', () => {
    it('starts with definition defaults', () => {
      const state = useStore.getState();
      expect(state.enabled).toBe(false);
      expect(state.count).toBe(0);
    });

    it('starts with loaded = false', () => {
      expect(useStore.getState().loaded).toBe(false);
    });

    it('provides loadSettings and saveSettings methods', () => {
      const state = useStore.getState();
      expect(typeof state.loadSettings).toBe('function');
      expect(typeof state.saveSettings).toBe('function');
    });
  });

  describe('loadSettings', () => {
    it('fetches settings via the generic bridge', async () => {
      mockGet.mockResolvedValue({ enabled: true, count: 42 });
      await useStore.getState().loadSettings();

      expect(mockGet).toHaveBeenCalledWith('test');
      expect(useStore.getState().enabled).toBe(true);
      expect(useStore.getState().count).toBe(42);
    });

    it('sets loaded = true after successful load', async () => {
      mockGet.mockResolvedValue({ enabled: true, count: 1 });
      await useStore.getState().loadSettings();

      expect(useStore.getState().loaded).toBe(true);
    });

    it('keeps defaults when bridge returns null', async () => {
      mockGet.mockResolvedValue(null);
      await useStore.getState().loadSettings();

      expect(useStore.getState().enabled).toBe(false);
      expect(useStore.getState().count).toBe(0);
      expect(useStore.getState().loaded).toBe(true);
    });

    it('keeps defaults on error and sets loaded', async () => {
      mockGet.mockRejectedValue(new Error('IPC failed'));
      await useStore.getState().loadSettings();

      expect(useStore.getState().enabled).toBe(false);
      expect(useStore.getState().count).toBe(0);
      expect(useStore.getState().loaded).toBe(true);
    });

    it('merges partial settings with defaults', async () => {
      mockGet.mockResolvedValue({ enabled: true });
      await useStore.getState().loadSettings();

      expect(useStore.getState().enabled).toBe(true);
      expect(useStore.getState().count).toBe(0); // default
    });
  });

  describe('custom defaults', () => {
    it('supports runtime default resolution for platform-specific settings', async () => {
      const dynamicStore = createSettingsStore(TEST_DEF, {
        getDefaults: () => ({ enabled: true, count: 7 }),
      });

      expect(dynamicStore.getState().enabled).toBe(true);
      expect(dynamicStore.getState().count).toBe(7);

      mockGet.mockResolvedValue(null);
      await dynamicStore.getState().loadSettings();

      expect(dynamicStore.getState().enabled).toBe(true);
      expect(dynamicStore.getState().count).toBe(7);
    });
  });

  describe('saveSettings', () => {
    it('optimistically updates store state', async () => {
      await useStore.getState().saveSettings({ enabled: true });

      expect(useStore.getState().enabled).toBe(true);
    });

    it('persists full settings via the generic bridge', async () => {
      // Set initial state
      mockGet.mockResolvedValue({ enabled: false, count: 5 });
      await useStore.getState().loadSettings();

      // Save partial update
      await useStore.getState().saveSettings({ enabled: true });

      expect(mockSave).toHaveBeenCalledWith('test', { enabled: true, count: 5 });
    });

    it('reverts on save error', async () => {
      mockGet.mockResolvedValue({ enabled: false, count: 10 });
      await useStore.getState().loadSettings();

      mockSave.mockRejectedValue(new Error('Save failed'));
      await useStore.getState().saveSettings({ enabled: true });

      // Should revert to previous value
      expect(useStore.getState().enabled).toBe(false);
      expect(useStore.getState().count).toBe(10);
    });

    it('preserves unchanged fields during partial update', async () => {
      mockGet.mockResolvedValue({ enabled: true, count: 42 });
      await useStore.getState().loadSettings();

      await useStore.getState().saveSettings({ count: 99 });

      expect(useStore.getState().enabled).toBe(true);
      expect(useStore.getState().count).toBe(99);
      expect(mockSave).toHaveBeenCalledWith('test', { enabled: true, count: 99 });
    });
  });

  describe('request sequencing', () => {
    function deferred<T>() {
      let resolve!: (v: T) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    }

    it('a failed save does not roll back a newer save to a different key', async () => {
      const first = deferred<void>();
      mockSave.mockReturnValueOnce(first.promise).mockResolvedValueOnce(undefined);

      const p1 = useStore.getState().saveSettings({ enabled: true });
      await useStore.getState().saveSettings({ count: 7 });
      first.reject(new Error('save failed'));
      await p1;

      expect(useStore.getState().enabled).toBe(false);
      expect(useStore.getState().count).toBe(7);
    });

    it('a failed save does not roll back a newer save to the same key', async () => {
      const first = deferred<void>();
      mockSave.mockReturnValueOnce(first.promise).mockResolvedValueOnce(undefined);

      const p1 = useStore.getState().saveSettings({ count: 1 });
      await useStore.getState().saveSettings({ count: 2 });
      first.reject(new Error('save failed'));
      await p1;

      expect(useStore.getState().count).toBe(2);
    });

    it('an older load response arriving after a newer one is ignored', async () => {
      const older = deferred<TestSettings>();
      mockGet.mockReturnValueOnce(older.promise).mockResolvedValueOnce({ enabled: true, count: 2 });

      const p1 = useStore.getState().loadSettings();
      await useStore.getState().loadSettings();
      older.resolve({ enabled: false, count: 1 });
      await p1;

      expect(useStore.getState().enabled).toBe(true);
      expect(useStore.getState().count).toBe(2);
    });

    it('a load response does not clobber a save made while it was in flight', async () => {
      const load = deferred<TestSettings>();
      mockGet.mockReturnValueOnce(load.promise);

      const p1 = useStore.getState().loadSettings();
      await useStore.getState().saveSettings({ count: 9 });
      load.resolve({ enabled: true, count: 1 });
      await p1;

      expect(useStore.getState().count).toBe(9);
      // Keys not touched by the save still take the loaded value
      expect(useStore.getState().enabled).toBe(true);
      expect(useStore.getState().loaded).toBe(true);
    });
  });

  describe('multiple stores', () => {
    it('different definitions produce independent stores', () => {
      interface OtherSettings { name: string }
      const otherDef: SettingsDefinition<OtherSettings> = {
        key: 'other',
        filename: 'other.json',
        defaults: { name: 'default' },
      };

      const otherStore = createSettingsStore(otherDef);

      // Changing one store doesn't affect the other
      useStore.setState({ enabled: true });
      expect(otherStore.getState().name).toBe('default');
    });
  });
});
