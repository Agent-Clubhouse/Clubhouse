/**
 * Telemetry secret store (spec §6.8): the App Insights connection string and
 * OTLP header values, encrypted with Electron `safeStorage` in
 * `userData/telemetry-secret.bin` (mode 0600). This is the first use of
 * `safeStorage` in the codebase.
 *
 * `safeStorage` only works after `app` is ready (the async methods reject
 * before it); every function here must be called after `app.whenReady()`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { app, safeStorage } from 'electron';
import type { SecureStorageState } from '../../shared/telemetry/settings-types';

export interface TelemetrySecrets {
  connectionString?: string;
  otlpHeaders?: Record<string, string>;
}

const FILE_MODE = 0o600;

export function getSecretPath(): string {
  return path.join(app.getPath('userData'), 'telemetry-secret.bin');
}

type SafeStorageApi = 'async' | 'sync';

/**
 * The async API (Electron 42+, the only one from Electron 46) when all three methods
 * exist, else the sync one; never a mix. Both read and write the same ciphertext, so a
 * file written by `encryptString` decrypts with `decryptStringAsync`.
 */
function safeStorageApi(): SafeStorageApi | null {
  const s = safeStorage as Partial<typeof safeStorage> | undefined;
  if (typeof s?.isAsyncEncryptionAvailable === 'function' && typeof s.encryptStringAsync === 'function' && typeof s.decryptStringAsync === 'function') return 'async';
  if (typeof s?.isEncryptionAvailable === 'function' && typeof s.encryptString === 'function' && typeof s.decryptString === 'function') return 'sync';
  return null;
}

async function encryptionAvailable(api: SafeStorageApi | null): Promise<boolean> {
  if (api === 'async') return (await safeStorage.isAsyncEncryptionAvailable()) === true;
  if (api === 'sync') return safeStorage.isEncryptionAvailable() === true;
  return false;
}

async function encrypt(api: SafeStorageApi, text: string): Promise<Buffer> {
  return api === 'async' ? safeStorage.encryptStringAsync(text) : safeStorage.encryptString(text);
}

/** `reencrypt` is the async API's `shouldReEncrypt`: the OS key rotated. */
async function decrypt(api: SafeStorageApi, buf: Buffer): Promise<{ text: string; reencrypt: boolean }> {
  if (api === 'sync') return { text: safeStorage.decryptString(buf), reencrypt: false };
  const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(buf);
  return { text: result, reencrypt: shouldReEncrypt === true };
}

/**
 * `weak` is Linux without a keyring, where Chromium falls back to a
 * hard-coded key (`basic_text`). The UI warns and asks before storing there.
 *
 * On `basic_text`, Electron reports encryption as unavailable until the app
 * opts into the hard-coded key with `setUsePlainTextEncryption(true)` (#2336),
 * so the backend is checked first. Opting in here only makes reads and writes
 * possible; control.ts still asks before anything is written. The async check
 * resolves true on `basic_text`, so the backend check is what keeps it `weak`.
 * A Linux backend that isn't known after ready is refused, as Framebriar does.
 */
async function storageState(api: SafeStorageApi | null): Promise<SecureStorageState> {
  try {
    if (process.platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend?.();
      if (backend === 'basic_text') {
        safeStorage.setUsePlainTextEncryption?.(true);
        return (await encryptionAvailable(api)) ? 'weak' : 'unavailable';
      }
      if (typeof backend !== 'string' || backend === 'unknown') return 'unavailable';
    }
    return (await encryptionAvailable(api)) ? 'available' : 'unavailable';
  } catch {
    // The async methods reject before app ready.
    return 'unavailable';
  }
}

export function getSecureStorageState(): Promise<SecureStorageState> {
  return storageState(safeStorageApi());
}

function clean(secrets: TelemetrySecrets): TelemetrySecrets {
  const out: TelemetrySecrets = {};
  if (typeof secrets.connectionString === 'string' && secrets.connectionString) out.connectionString = secrets.connectionString;
  if (secrets.otlpHeaders && typeof secrets.otlpHeaders === 'object') {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(secrets.otlpHeaders)) {
      if (typeof v === 'string') headers[k] = v;
    }
    if (Object.keys(headers).length) out.otlpHeaders = headers;
  }
  return out;
}

async function load(): Promise<{ secrets: TelemetrySecrets; reencrypt: boolean }> {
  const none = { secrets: {}, reencrypt: false };
  let buf: Buffer;
  try {
    buf = await fs.promises.readFile(getSecretPath());
  } catch {
    return none;
  }
  const api = safeStorageApi();
  // On Linux basic_text, opts into the hard-coded key so a weak file can be decrypted.
  if (!api || (await storageState(api)) === 'unavailable') return none;
  try {
    const { text, reencrypt } = await decrypt(api, buf);
    return { secrets: clean(JSON.parse(text) as TelemetrySecrets), reencrypt };
  } catch {
    // Encrypted under a different OS user or keyring: unusable, treat as unset.
    return none;
  }
}

/** Returns `{}` when nothing is stored or the file can't be decrypted. */
export async function readSecrets(): Promise<TelemetrySecrets> {
  const { secrets, reencrypt } = await load();
  // Best effort, under the lock so it can't overwrite a newer save. The old
  // ciphertext still decrypts if this fails.
  if (reencrypt) {
    serialized(async () => {
      const current = await load();
      if (current.reencrypt) await writeSecrets(current.secrets);
    }).catch(() => {}); // telemetry-exempt: the stored secrets stay readable
  }
  return secrets;
}

export async function writeSecrets(secrets: TelemetrySecrets): Promise<void> {
  const cleaned = clean(secrets);
  const file = getSecretPath();
  if (!cleaned.connectionString && !cleaned.otlpHeaders) {
    await deleteSecrets();
    return;
  }
  const api = safeStorageApi();
  if (!api || (await storageState(api)) === 'unavailable') {
    throw new Error('Secure storage is unavailable on this system');
  }
  const encrypted = await encrypt(api, JSON.stringify(cleaned));
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, encrypted, { mode: FILE_MODE });
  if (process.platform !== 'win32') await fs.promises.chmod(file, FILE_MODE);
}

let lock: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.catch(() => {}).then(fn);
  lock = run;
  return run;
}

/** Serialized read-modify-write, so concurrent settings saves can't drop a secret. */
export function updateSecrets(fn: (current: TelemetrySecrets) => TelemetrySecrets): Promise<TelemetrySecrets> {
  return serialized(async () => {
    // Writing always re-encrypts, so a rotated key needs nothing extra here.
    const next = clean(fn((await load()).secrets));
    await writeSecrets(next);
    return next;
  });
}

export async function deleteSecrets(): Promise<void> {
  await fs.promises.rm(getSecretPath(), { force: true });
}
