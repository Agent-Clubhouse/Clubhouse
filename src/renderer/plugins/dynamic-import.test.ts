import { describe, it, expect, vi, afterEach } from 'vitest';
import type { PluginModule } from '../../shared/plugin-types';
import { buildPluginModuleUrl } from '../../shared/plugin-protocol-url';

const FAKE_SOURCE = 'export default {}';
const FAKE_BLOB_URL = 'blob:null/test-uuid';

type ClubhouseWindow = { clubhouse: { plugin: { loadModuleSource: ReturnType<typeof vi.fn> } } };
function setClubhouse(loadModuleSource: ReturnType<typeof vi.fn>) {
  (window as unknown as ClubhouseWindow).clubhouse = { plugin: { loadModuleSource } };
}
function getLoadModuleSource() {
  return (window as unknown as ClubhouseWindow).clubhouse.plugin.loadModuleSource;
}

function setOrigin(protocol: 'file:' | 'http:') {
  Object.defineProperty(window, 'location', {
    value: { protocol },
    writable: true,
    configurable: true,
  });
}

async function loadModule() {
  return import('./dynamic-import');
}

const PLUGIN_URL = buildPluginModuleUrl('/Users/me/.clubhouse/plugins/automations/dist/main.js', 1780813375562);

describe('dynamicImportModule', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  describe('production (file: origin)', () => {
    it('imports the clubhouse-plugin: URL directly — no IPC, no blob', async () => {
      setOrigin('file:');
      setClubhouse(vi.fn().mockResolvedValue(FAKE_SOURCE));
      const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue(FAKE_BLOB_URL);
      const fakeModule: PluginModule = { activate: vi.fn() };

      const mod = await loadModule();
      const rawImport = vi.spyOn(mod._internals, 'rawImport').mockResolvedValue(fakeModule);

      const result = await mod.dynamicImportModule(PLUGIN_URL);

      expect(result).toBe(fakeModule);
      expect(rawImport).toHaveBeenCalledWith(PLUGIN_URL);
      expect(getLoadModuleSource()).not.toHaveBeenCalled();
      expect(createObjectURL).not.toHaveBeenCalled();
    });

    it('does not fall back to blob if the prod import fails (real error surfaces)', async () => {
      setOrigin('file:');
      setClubhouse(vi.fn().mockResolvedValue(FAKE_SOURCE));

      const mod = await loadModule();
      vi.spyOn(mod._internals, 'rawImport').mockRejectedValue(new Error('boom'));

      await expect(mod.dynamicImportModule(PLUGIN_URL)).rejects.toThrow('boom');
      expect(getLoadModuleSource()).not.toHaveBeenCalled();
    });
  });

  describe('dev (http: origin)', () => {
    it('imports the clubhouse-plugin: URL directly when cross-origin import works', async () => {
      setOrigin('http:');
      setClubhouse(vi.fn().mockResolvedValue(FAKE_SOURCE));
      const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue(FAKE_BLOB_URL);
      const fakeModule: PluginModule = {};

      const mod = await loadModule();
      const rawImport = vi.spyOn(mod._internals, 'rawImport').mockResolvedValue(fakeModule);

      const result = await mod.dynamicImportModule(PLUGIN_URL);

      expect(result).toBe(fakeModule);
      expect(rawImport).toHaveBeenCalledWith(PLUGIN_URL);
      expect(createObjectURL).not.toHaveBeenCalled();
    });

    it('falls back to IPC + blob when the cross-origin protocol import fails', async () => {
      setOrigin('http:');
      setClubhouse(vi.fn().mockResolvedValue(FAKE_SOURCE));
      vi.spyOn(URL, 'createObjectURL').mockReturnValue(FAKE_BLOB_URL);
      const revoke = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
      const blobModule: PluginModule = { activate: vi.fn() };

      const mod = await loadModule();
      const rawImport = vi
        .spyOn(mod._internals, 'rawImport')
        .mockRejectedValueOnce(new Error('cross-origin blocked')) // protocol attempt
        .mockResolvedValueOnce(blobModule); // blob attempt

      const result = await mod.dynamicImportModule(PLUGIN_URL);

      expect(result).toBe(blobModule);
      // Source read for the parsed real file path (version prefix stripped):
      expect(getLoadModuleSource()).toHaveBeenCalledWith('/Users/me/.clubhouse/plugins/automations/dist/main.js');
      // First attempt = protocol URL, second = blob URL:
      expect(rawImport).toHaveBeenNthCalledWith(1, PLUGIN_URL);
      expect(rawImport).toHaveBeenNthCalledWith(2, FAKE_BLOB_URL);
      expect(revoke).toHaveBeenCalledWith(FAKE_BLOB_URL);
    });
  });

  describe('non-plugin URLs', () => {
    it('imports any other URL directly', async () => {
      setOrigin('file:');
      const fakeModule: PluginModule = {};
      const mod = await loadModule();
      const rawImport = vi.spyOn(mod._internals, 'rawImport').mockResolvedValue(fakeModule);

      const result = await mod.dynamicImportModule('https://example.com/x.js');
      expect(result).toBe(fakeModule);
      expect(rawImport).toHaveBeenCalledWith('https://example.com/x.js');
    });
  });
});
