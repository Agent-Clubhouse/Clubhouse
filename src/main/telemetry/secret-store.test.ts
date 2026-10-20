import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const userData = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron', async () => {
  const actual = await vi.importActual<typeof import('../../__mocks__/electron')>('../../__mocks__/electron');
  return {
    ...actual,
    app: { ...actual.app, getPath: () => userData.dir },
  };
});

import { safeStorage } from 'electron';
import { deleteSecrets, getSecretPath, getSecureStorageState, readSecrets, updateSecrets, writeSecrets } from './secret-store';

beforeEach(async () => {
  userData.dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'clubhouse-secret-'));
});

afterEach(async () => {
  await fsp.rm(userData.dir, { recursive: true, force: true });
});

describe('telemetry secret store', () => {
  it('round-trips secrets through safeStorage, never writing plaintext', async () => {
    await writeSecrets({ connectionString: 'InstrumentationKey=abc;IngestionEndpoint=https://x', otlpHeaders: { 'x-api-key': 'k123' } });
    const raw = await fsp.readFile(getSecretPath());
    expect(raw.toString('utf8')).not.toBe(JSON.stringify({}));
    expect(await readSecrets()).toEqual({
      connectionString: 'InstrumentationKey=abc;IngestionEndpoint=https://x',
      otlpHeaders: { 'x-api-key': 'k123' },
    });
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

  it('reports weak storage for Linux basic_text and refuses when unavailable', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const backend = vi.spyOn(safeStorage, 'getSelectedStorageBackend').mockReturnValue('basic_text');
    try {
      expect(getSecureStorageState()).toBe('weak');
    } finally {
      Object.defineProperty(process, 'platform', platform);
      backend.mockRestore();
    }
    const available = vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(false);
    expect(getSecureStorageState()).toBe('unavailable');
    await expect(writeSecrets({ connectionString: 'cs' })).rejects.toThrow(/unavailable/);
    available.mockRestore();
  });

  describe('Linux basic_text, where encryption is off until the app opts in (#2336)', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    let plainText: boolean;

    beforeEach(() => {
      plainText = false;
      Object.defineProperty(process, 'platform', { value: 'linux' });
      vi.spyOn(safeStorage, 'getSelectedStorageBackend').mockReturnValue('basic_text');
      // Electron: basic_text is only available after setUsePlainTextEncryption(true).
      vi.spyOn(safeStorage, 'isEncryptionAvailable').mockImplementation(() => plainText);
      vi.spyOn(safeStorage, 'setUsePlainTextEncryption').mockImplementation((v: boolean) => {
        plainText = v;
      });
      const encrypt = safeStorage.encryptString;
      const decrypt = safeStorage.decryptString;
      vi.spyOn(safeStorage, 'encryptString').mockImplementation((s: string) => {
        if (!plainText) throw new Error('Encryption is not available.');
        return encrypt(s);
      });
      vi.spyOn(safeStorage, 'decryptString').mockImplementation((b: Buffer) => {
        if (!plainText) throw new Error('Decryption is not available.');
        return decrypt(b);
      });
    });

    afterEach(() => {
      Object.defineProperty(process, 'platform', platform);
      vi.restoreAllMocks();
    });

    it('reports weak, not unavailable, so the consent path is reachable', () => {
      expect(getSecureStorageState()).toBe('weak');
      expect(safeStorage.setUsePlainTextEncryption).toHaveBeenCalledWith(true);
    });

    it('saves and reads secrets back', async () => {
      await writeSecrets({ connectionString: 'cs' });
      plainText = false; // A new run starts without the opt-in.
      expect(await readSecrets()).toEqual({ connectionString: 'cs' });
    });

    it('stays unavailable when the opt-in does not enable encryption', async () => {
      vi.spyOn(safeStorage, 'setUsePlainTextEncryption').mockImplementation(() => {});
      expect(getSecureStorageState()).toBe('unavailable');
      await expect(writeSecrets({ connectionString: 'cs' })).rejects.toThrow(/unavailable/);
    });
  });
});
