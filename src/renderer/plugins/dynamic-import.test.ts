import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PluginModule } from '../../shared/plugin-types';

const FAKE_SOURCE = 'export default {}';
const FAKE_BLOB_URL = 'blob:null/test-uuid';

type ClubhouseWindow = { clubhouse: { plugin: { loadModuleSource: ReturnType<typeof vi.fn> } } };
function setClubhouse(loadModuleSource: ReturnType<typeof vi.fn>) {
  (window as unknown as ClubhouseWindow).clubhouse = { plugin: { loadModuleSource } };
}
function getLoadModuleSource() {
  return (window as unknown as ClubhouseWindow).clubhouse.plugin.loadModuleSource;
}

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

  async function loadModule() {
    return import('./dynamic-import');
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
      // Provide a clubhouse stub + URL spies so we can assert the blob/IPC
      // path is NOT taken in production (that path is what broke relative
      // imports in #1499).
      setClubhouse(vi.fn().mockResolvedValue(FAKE_SOURCE));
      vi.spyOn(URL, 'createObjectURL').mockReturnValue(FAKE_BLOB_URL);
      vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
    });

    // The exact case #1499's tests missed: a multi-file plugin whose entry
    // module does `import './x.js'`. Blob-wrapping (no path) broke this. We
    // assert production imports the file:// URL DIRECTLY — no IPC, no blob —
    // which is the prerequisite for the entry module's relative import to
    // resolve against its real filesystem path.
    it('imports the file:// URL directly for a multi-file plugin — no IPC, no blob', async () => {
      const fakeModule: PluginModule = { activate: vi.fn() };
      const url = 'file:///Users/me/.clubhouse/plugins/automations/dist/main.js';

      const mod = await loadModule();
      const rawImport = vi.spyOn(mod._internals, 'rawImport').mockResolvedValue(fakeModule);

      const result = await mod.dynamicImportModule(url);

      // Imported directly with the real file:// path — not a blob/IPC copy.
      expect(result).toBe(fakeModule);
      expect(rawImport).toHaveBeenCalledWith(url);
      expect(getLoadModuleSource()).not.toHaveBeenCalled();
      expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    // A bare/external dependency import inside the entry module (e.g.
    // `import 'some-dep'`) likewise only resolves when the module is imported
    // directly with its real path — never through a pathless blob URL.
    it('imports directly for an entry module with a bare dependency import', async () => {
      const fakeModule: PluginModule = {};
      const url = 'file:///plugins/with-deps/dist/main.js';

      const mod = await loadModule();
      const rawImport = vi.spyOn(mod._internals, 'rawImport').mockResolvedValue(fakeModule);

      const result = await mod.dynamicImportModule(url);

      expect(result).toBe(fakeModule);
      expect(rawImport).toHaveBeenCalledWith(url);
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      expect(getLoadModuleSource()).not.toHaveBeenCalled();
    });

    it('strips the ?v= cache-busting query param before importing in production', async () => {
      const fakeModule: PluginModule = {};
      const cleanUrl = 'file:///plugins/automations/dist/main.js';

      const mod = await loadModule();
      const rawImport = vi.spyOn(mod._internals, 'rawImport').mockResolvedValue(fakeModule);

      await mod.dynamicImportModule(`${cleanUrl}?v=1780813375562`);

      // The query param must be gone — Chromium's ESM loader rejects ?v= on file://.
      expect(rawImport).toHaveBeenCalledWith(cleanUrl);
      expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    it('loads a single-file plugin in production without blob-wrapping', async () => {
      const fakeModule: PluginModule = { activate: vi.fn() };
      const url = 'file:///plugins/single/main.js';

      const mod = await loadModule();
      const rawImport = vi.spyOn(mod._internals, 'rawImport').mockResolvedValue(fakeModule);

      const result = await mod.dynamicImportModule(url);

      expect(result).toBe(fakeModule);
      expect(rawImport).toHaveBeenCalledWith(url);
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      expect(getLoadModuleSource()).not.toHaveBeenCalled();
    });
  });

  describe('dev mode — direct-import seam (single-file, blob path)', () => {
    it('imports the generated blob URL via the raw import seam', async () => {
      const fakeModule: PluginModule = { activate: vi.fn() };
      setupDevModeGlobals(fakeModule);

      const mod = await loadModule();
      const rawImport = vi.spyOn(mod._internals, 'rawImport').mockResolvedValue(fakeModule);

      const result = await mod.dynamicImportModule('file:///some/plugin/main.js');

      expect(result).toBe(fakeModule);
      // Dev imports the blob URL (not the file path) to dodge the cross-origin block.
      expect(rawImport).toHaveBeenCalledWith(FAKE_BLOB_URL);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith(FAKE_BLOB_URL);
    });
  });
});
