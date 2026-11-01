import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  asyncOnlySafeStorage, bothApisSafeStorage, fakeKeychain, syncOnlySafeStorage, type FakeKeychain,
} from './__test-utils__/fake-safe-storage';

const userData = vi.hoisted(() => ({ dir: '' }));
/** The safeStorage the module under test sees; each test installs a fake. */
const storage = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('electron', async () => {
  const actual = await vi.importActual<typeof import('../../__mocks__/electron')>('../../__mocks__/electron');
  return {
    ...actual,
    app: { ...actual.app, getPath: () => userData.dir },
    safeStorage: new Proxy({}, { get: (_target, key) => storage.current[key as string] }),
  };
});

import { deleteSecrets, getSecretPath, getSecureStorageState, readSecrets, updateSecrets, writeSecrets } from './secret-store';

const CS = 'InstrumentationKey=abc;IngestionEndpoint=https://x';
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

function onLinux() {
  Object.defineProperty(process, 'platform', { value: 'linux' });
}

let chain: FakeKeychain;

beforeEach(async () => {
  userData.dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'clubhouse-secret-'));
  chain = fakeKeychain();
});

afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  vi.restoreAllMocks();
  await fsp.rm(userData.dir, { recursive: true, force: true });
});

const SHAPES = [
  ['async API only (Electron 46+)', asyncOnlySafeStorage],
  ['sync API only (fallback)', syncOnlySafeStorage],
] as const;

describe.each(SHAPES)('telemetry secret store, %s', (_name, make) => {
  beforeEach(() => {
    storage.current = make(chain);
  });

  it('round-trips secrets through safeStorage, never writing plaintext', async () => {
    expect(await getSecureStorageState()).toBe('available');
    await writeSecrets({ connectionString: CS, otlpHeaders: { 'x-api-key': 'k123' } });
    const raw = (await fsp.readFile(getSecretPath())).toString('utf8');
    expect(raw).not.toContain('InstrumentationKey');
    expect(raw).not.toContain('k123');
    expect(await readSecrets()).toEqual({ connectionString: CS, otlpHeaders: { 'x-api-key': 'k123' } });
    if (process.platform !== 'win32') {
      expect((await fsp.stat(getSecretPath())).mode & 0o777).toBe(0o600);
    }
  });

  it('merges updates without dropping the other secret, even when concurrent', async () => {
    await Promise.all([
      updateSecrets((s) => ({ ...s, connectionString: 'cs' })),
      updateSecrets((s) => ({ ...s, otlpHeaders: { a: '1' } })),
    ]);
    expect(await readSecrets()).toEqual({ connectionString: 'cs', otlpHeaders: { a: '1' } });
  });

  it('deletes the file when nothing is left to store', async () => {
    await writeSecrets({ connectionString: 'cs' });
    await updateSecrets((s) => ({ ...s, connectionString: undefined }));
    await expect(fsp.stat(getSecretPath())).rejects.toThrow();
    await deleteSecrets();
  });

  it('treats an undecryptable file as empty', async () => {
    await fsp.writeFile(getSecretPath(), 'garbage');
    expect(await readSecrets()).toEqual({});
  });

  it('refuses to write, and reads nothing, when encryption is unavailable', async () => {
    await writeSecrets({ connectionString: 'cs' });
    chain.available = false;
    expect(await getSecureStorageState()).toBe('unavailable');
    expect(await readSecrets()).toEqual({});
    await expect(writeSecrets({ connectionString: 'other' })).rejects.toThrow(/unavailable/);
  });

  it('is unavailable before app ready rather than throwing', async () => {
    await writeSecrets({ connectionString: 'cs' });
    chain.ready = false;
    expect(await getSecureStorageState()).toBe('unavailable');
    expect(await readSecrets()).toEqual({});
    await expect(writeSecrets({ connectionString: 'cs' })).rejects.toThrow(/unavailable/);
  });

  describe('Linux', () => {
    beforeEach(onLinux);

    it('reports weak for basic_text, opting into the hard-coded key, and still round-trips', async () => {
      const store = make(chain, { backend: 'basic_text' });
      const optIn = vi.spyOn(store, 'setUsePlainTextEncryption');
      storage.current = store;
      expect(await getSecureStorageState()).toBe('weak');
      expect(optIn).toHaveBeenCalledWith(true);
      await writeSecrets({ connectionString: 'cs' });
      expect(await readSecrets()).toEqual({ connectionString: 'cs' });
    });

    it('refuses a backend that is unknown after ready', async () => {
      await writeSecrets({ connectionString: 'cs' });
      storage.current = make(chain, { backend: 'unknown' });
      expect(await getSecureStorageState()).toBe('unavailable');
      expect(await readSecrets()).toEqual({});
      await expect(writeSecrets({ connectionString: 'cs' })).rejects.toThrow(/unavailable/);
    });
  });
});

describe('telemetry secret store, moving from the sync to the async API', () => {
  it('reads a file the sync API wrote through the async API, then saves with the async API', async () => {
    storage.current = syncOnlySafeStorage(chain);
    await writeSecrets({ connectionString: CS, otlpHeaders: { 'x-api-key': 'k123' } });

    storage.current = asyncOnlySafeStorage(chain);
    expect(await readSecrets()).toEqual({ connectionString: CS, otlpHeaders: { 'x-api-key': 'k123' } });
    await updateSecrets((s) => ({ ...s, otlpHeaders: undefined }));

    // A rollback to a sync-API build still reads what the async API wrote.
    storage.current = syncOnlySafeStorage(chain);
    expect(await readSecrets()).toEqual({ connectionString: CS });
  });

  it('uses only the async API when Electron has both', async () => {
    storage.current = syncOnlySafeStorage(chain);
    await writeSecrets({ connectionString: CS });
    storage.current = bothApisSafeStorage(chain);
    expect(await getSecureStorageState()).toBe('available');
    expect(await readSecrets()).toEqual({ connectionString: CS });
    await writeSecrets({ connectionString: 'next' });
    expect(await readSecrets()).toEqual({ connectionString: 'next' });
  });

  it('falls back to the sync API when the async one is incomplete, never mixing them', async () => {
    const sync = syncOnlySafeStorage(chain);
    storage.current = { ...sync, isAsyncEncryptionAvailable: async () => { throw new Error('mixed'); } };
    await writeSecrets({ connectionString: CS });
    expect(await readSecrets()).toEqual({ connectionString: CS });
  });

  it('re-encrypts under the new key when the async API asks to, keeping a later save', async () => {
    storage.current = asyncOnlySafeStorage(chain);
    await writeSecrets({ connectionString: CS });
    chain.previousKeys = ['k1'];
    chain.key = 'k2';

    expect(await readSecrets()).toEqual({ connectionString: CS });
    await vi.waitFor(async () => {
      expect((await fsp.readFile(getSecretPath())).toString('utf8')).toContain('fake-enc:k2:');
    });
    expect(await readSecrets()).toEqual({ connectionString: CS });

    // A save racing the rewrap wins: the rewrap re-reads under the lock.
    await writeSecrets({ connectionString: 'old' });
    chain.previousKeys = ['k2'];
    chain.key = 'k3';
    const read = readSecrets();
    const saved = updateSecrets(() => ({ connectionString: 'new' }));
    expect(await read).toEqual({ connectionString: 'old' });
    await saved;
    await updateSecrets((s) => s);
    expect(await readSecrets()).toEqual({ connectionString: 'new' });
  });

  it('is unavailable without any safeStorage API', async () => {
    storage.current = {};
    expect(await getSecureStorageState()).toBe('unavailable');
    expect(await readSecrets()).toEqual({});
    await expect(writeSecrets({ connectionString: 'cs' })).rejects.toThrow(/unavailable/);
  });
});
