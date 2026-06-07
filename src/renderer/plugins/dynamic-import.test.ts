import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PluginModule } from '../../shared/plugin-types';

const FAKE_SOURCE = 'export default {}';
const FAKE_BLOB_URL = 'blob:null/test-uuid';

function setupDevModeGlobals(mockModule: PluginModule) {
  // Simulate http: origin (dev mode)
  Object.defineProperty(window, 'location', {
    value: { protocol: 'http:' },
    writable: true,
    configurable: true,
  });

  const loadModuleSource = vi.fn().mockResolvedValue(FAKE_SOURCE);
  (window as any).clubhouse = { plugin: { loadModuleSource } };

  vi.spyOn(URL, 'createObjectURL').mockReturnValue(FAKE_BLOB_URL);
  vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);

  return { loadModuleSource, mockModule };
}

function setupProdModeGlobals() {
  Object.defineProperty(window, 'location', {
    value: { protocol: 'file:' },
    writable: true,
    configurable: true,
  });
}

describe('dynamicImportModule', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function loadFn() {
    const { dynamicImportModule } = await import('./dynamic-import');
    return dynamicImportModule;
  }

  describe('dev mode (non-file: origin)', () => {
    it('reads module source via IPC for file: URLs', async () => {
      const fakeModule: PluginModule = { activate: vi.fn() };
      const { loadModuleSource } = setupDevModeGlobals(fakeModule);

      vi.doMock('blob:null/test-uuid', () => fakeModule, { virtual: true });

      const fn = await loadFn();
      await fn('file:///path/to/plugin/main.js').catch(() => {
        // import of blob url may fail in jsdom — we only care about side effects
      });

      expect(loadModuleSource).toHaveBeenCalledWith('/path/to/plugin/main.js');
    });

    it('creates a blob URL from the module source', async () => {
      const fakeModule: PluginModule = {};
      setupDevModeGlobals(fakeModule);

      const fn = await loadFn();
      await fn('file:///some/plugin/main.js').catch(() => {});

      expect(URL.createObjectURL).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'text/javascript' }),
      );
    });

    it('revokes the blob URL after import (cleanup)', async () => {
      const fakeModule: PluginModule = {};
      setupDevModeGlobals(fakeModule);

      const fn = await loadFn();
      await fn('file:///plugin/main.js').catch(() => {});

      expect(URL.revokeObjectURL).toHaveBeenCalledWith(FAKE_BLOB_URL);
    });

    it('revokes the blob URL even when import rejects', async () => {
      setupDevModeGlobals({});
      // Make the import throw by having a bad URL succeed createObjectURL but fail import
      // We verify revokeObjectURL is still called via the finally block

      const fn = await loadFn();
      await fn('file:///bad/plugin.js').catch(() => {});

      // revokeObjectURL should always be called (finally block)
      expect(URL.revokeObjectURL).toHaveBeenCalled();
    });

    it('strips cache-busting query params when extracting the file path', async () => {
      const fakeModule: PluginModule = {};
      const { loadModuleSource } = setupDevModeGlobals(fakeModule);

      const fn = await loadFn();
      await fn('file:///path/to/plugin/main.js?v=1234567890').catch(() => {});

      expect(loadModuleSource).toHaveBeenCalledWith('/path/to/plugin/main.js');
    });

    it('does not use new Function() — no unsafe-eval required', async () => {
      const originalFunction = globalThis.Function;
      const functionSpy = vi.fn((...args: unknown[]) => originalFunction(...(args as [string])));
      globalThis.Function = functionSpy as any;

      const fakeModule: PluginModule = {};
      setupDevModeGlobals(fakeModule);

      const fn = await loadFn();
      await fn('file:///plugin/main.js').catch(() => {});

      // Function constructor should NOT be called — we use webpackIgnore import() instead
      expect(functionSpy).not.toHaveBeenCalled();
      globalThis.Function = originalFunction;
    });
  });

  describe('production mode (file: origin)', () => {
    beforeEach(() => {
      setupProdModeGlobals();
      vi.spyOn(URL, 'createObjectURL').mockReturnValue(FAKE_BLOB_URL);
      vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
    });

    it('reads module source via IPC for file: origin (same as dev mode)', async () => {
      const fakeModule: PluginModule = { activate: vi.fn() };
      const { loadModuleSource } = setupDevModeGlobals(fakeModule);
      // Override location back to production after setupDevModeGlobals set it to http:
      setupProdModeGlobals();

      const fn = await loadFn();
      await fn('file:///Users/masonallen/.clubhouse/plugins/automations/dist/main.js').catch(() => {});

      expect(loadModuleSource).toHaveBeenCalledWith(
        '/Users/masonallen/.clubhouse/plugins/automations/dist/main.js',
      );
    });

    it('creates a blob URL for file: origin — avoids ?v= query-param failure', async () => {
      const loadModuleSource = vi.fn().mockResolvedValue(FAKE_SOURCE);
      (window as any).clubhouse = { plugin: { loadModuleSource } };

      const fn = await loadFn();
      await fn('file:///plugins/automations/dist/main.js?v=1780813375562').catch(() => {});

      expect(URL.createObjectURL).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'text/javascript' }),
      );
    });

    it('strips ?v= cache-busting query param from file path in production', async () => {
      const loadModuleSource = vi.fn().mockResolvedValue(FAKE_SOURCE);
      (window as any).clubhouse = { plugin: { loadModuleSource } };

      const fn = await loadFn();
      await fn('file:///plugins/automations/dist/main.js?v=1780813375562').catch(() => {});

      expect(loadModuleSource).toHaveBeenCalledWith('/plugins/automations/dist/main.js');
    });

    it('revokes the blob URL after import in production (cleanup)', async () => {
      const loadModuleSource = vi.fn().mockResolvedValue(FAKE_SOURCE);
      (window as any).clubhouse = { plugin: { loadModuleSource } };

      const fn = await loadFn();
      await fn('file:///plugins/automations/dist/main.js').catch(() => {});

      expect(URL.revokeObjectURL).toHaveBeenCalledWith(FAKE_BLOB_URL);
    });
  });
});
