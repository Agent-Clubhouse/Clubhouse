/**
 * Fake Electron safeStorage for tests, in the two shapes the secret stores support:
 * async only (Electron 46+) and sync only (the fallback). Both read and write the
 * same ciphertext, as Electron's do (data from `encryptString` decrypts with
 * `decryptStringAsync`), so a record written through one reads back through the other.
 */

/** The OS key store both fakes share. */
export interface FakeKeychain {
  /** The key new data is encrypted with. */
  key: string;
  /** Older keys that still decrypt; the async API asks to re-encrypt their data. */
  previousKeys: string[];
  available: boolean;
  /** False until app ready: the async methods reject, the sync check reports false. */
  ready: boolean;
}

export function fakeKeychain(overrides: Partial<FakeKeychain> = {}): FakeKeychain {
  return { key: 'k1', previousKeys: [], available: true, ready: true, ...overrides };
}

const PREFIX = 'fake-enc:';

function seal(chain: FakeKeychain, text: string): Buffer {
  return Buffer.from(`${PREFIX}${chain.key}:${Buffer.from(text, 'utf8').toString('base64')}`, 'utf8');
}

function unseal(chain: FakeKeychain, buf: Buffer): { text: string; rotated: boolean } {
  const raw = Buffer.from(buf).toString('utf8');
  const match = /^fake-enc:([^:]+):([A-Za-z0-9+/=]*)$/.exec(raw);
  if (!match || (match[1] !== chain.key && !chain.previousKeys.includes(match[1]))) {
    throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
  }
  return { text: Buffer.from(match[2], 'base64').toString('utf8'), rotated: match[1] !== chain.key };
}

interface LinuxOptions {
  /** What `getSelectedStorageBackend` returns (Linux only). */
  backend?: string;
}

function linux({ backend = 'gnome_libsecret' }: LinuxOptions) {
  return {
    getSelectedStorageBackend: () => backend,
    setUsePlainTextEncryption: (_usePlainText: boolean) => {},
  };
}

export function asyncOnlySafeStorage(chain: FakeKeychain, options: LinuxOptions = {}) {
  const notReady = () => Promise.reject(new Error('safeStorage cannot be used before app is ready'));
  return {
    ...linux(options),
    isAsyncEncryptionAvailable: async () => (chain.ready ? chain.available : notReady()),
    encryptStringAsync: async (text: string) => {
      if (!chain.ready) return notReady();
      if (!chain.available) throw new Error('Encryption is not available.');
      return seal(chain, text);
    },
    decryptStringAsync: async (buf: Buffer) => {
      if (!chain.ready) return notReady();
      if (!chain.available) throw new Error('Decryption is not available.');
      const { text, rotated } = unseal(chain, buf);
      return { result: text, shouldReEncrypt: rotated };
    },
  };
}

export function syncOnlySafeStorage(chain: FakeKeychain, options: LinuxOptions = {}) {
  return {
    ...linux(options),
    isEncryptionAvailable: () => chain.ready && chain.available,
    encryptString: (text: string) => {
      if (!chain.ready || !chain.available) throw new Error('Encryption is not available.');
      return seal(chain, text);
    },
    decryptString: (buf: Buffer) => {
      if (!chain.ready || !chain.available) throw new Error('Decryption is not available.');
      return unseal(chain, buf).text;
    },
  };
}

/** Electron 42 to 45: both APIs. Using the sync one fails the test. */
export function bothApisSafeStorage(chain: FakeKeychain, options: LinuxOptions = {}) {
  const refuse = () => { throw new Error('sync safeStorage API used where the async one exists'); };
  return {
    ...asyncOnlySafeStorage(chain, options),
    isEncryptionAvailable: refuse,
    encryptString: refuse,
    decryptString: refuse,
  };
}
