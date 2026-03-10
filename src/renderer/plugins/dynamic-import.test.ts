import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PluginModule } from '../../shared/plugin-types';

// We intercept the `new Function(...)` call used inside dynamicImportModule
// by replacing the global Function constructor with a wrapper that records
// calls and returns a controllable mock import function.

describe('dynamicImportModule', () => {
  const OriginalFunction = globalThis.Function;
  let mockImportFn: ReturnType<typeof vi.fn>;
  let functionSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockImportFn = vi.fn();
    functionSpy = vi.fn();

    // Replace global Function with a real constructor function (not vi.fn())
    // so that `new Function(...)` works. The constructor records its arguments
    // and returns the mock import function.
    const FakeFunction = function (this: any, ...args: any[]) {
      functionSpy(...args);
      return mockImportFn;
    } as any;
    FakeFunction.prototype = OriginalFunction.prototype;

    globalThis.Function = FakeFunction;
  });

  afterEach(() => {
    globalThis.Function = OriginalFunction;
    vi.restoreAllMocks();
    // Clear the module cache so each test gets a fresh import
    vi.resetModules();
  });

  async function loadModule() {
    // Dynamic import so each test gets the mocked Function constructor
    const { dynamicImportModule } = await import('./dynamic-import');
    return dynamicImportModule;
  }

  it('constructs a Function with the expected arguments to wrap dynamic import', async () => {
    const fakeModule: PluginModule = { activate: vi.fn() };
    mockImportFn.mockResolvedValue(fakeModule);

    const dynamicImportModule = await loadModule();
    await dynamicImportModule('file:///plugin/index.js');

    // Verify `new Function('path', 'return import(path)')` was called
    expect(functionSpy).toHaveBeenCalledWith('path', 'return import(path)');
  });

  it('passes a data: URI to the constructed import function for file: URLs in dev mode', async () => {
    const fakeModule: PluginModule = {};
    mockImportFn.mockResolvedValue(fakeModule);

    const dynamicImportModule = await loadModule();
    await dynamicImportModule('file:///some/plugin/main.js');

    // In dev mode (non-file: protocol), file contents are read via IPC
    // and imported from a data: URI instead of the original file: URL
    expect(mockImportFn).toHaveBeenCalledWith(
      expect.stringMatching(/^data:text\/javascript;base64,/),
    );
  });

  it('returns the resolved module from the import function', async () => {
    const fakeModule: PluginModule = {
      activate: vi.fn(),
      deactivate: vi.fn(),
    };
    mockImportFn.mockResolvedValue(fakeModule);

    const dynamicImportModule = await loadModule();
    const result = await dynamicImportModule('file:///plugin/index.js');

    expect(result).toBe(fakeModule);
  });

  it('propagates errors when the import function rejects', async () => {
    const importError = new Error('Module not found: invalid-plugin');
    mockImportFn.mockRejectedValue(importError);

    const dynamicImportModule = await loadModule();

    await expect(dynamicImportModule('file:///bad/path.js')).rejects.toThrow(
      'Module not found: invalid-plugin',
    );
  });

  it('propagates errors when the import function throws synchronously', async () => {
    const syncError = new TypeError('Cannot resolve module specifier');
    mockImportFn.mockImplementation(() => {
      throw syncError;
    });

    const dynamicImportModule = await loadModule();

    await expect(dynamicImportModule(':::invalid')).rejects.toThrow(
      'Cannot resolve module specifier',
    );
  });
});
