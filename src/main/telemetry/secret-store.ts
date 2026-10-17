/**
 * Telemetry secret store (spec §6.8): the App Insights connection string and
 * OTLP header values, encrypted with Electron `safeStorage` in
 * `userData/telemetry-secret.bin` (mode 0600). This is the first use of
 * `safeStorage` in the codebase.
 *
 * `safeStorage` only works after `app` is ready; every function here must be
 * called after `app.whenReady()`.
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

/**
 * `weak` is Linux without a keyring, where Chromium falls back to a
 * hard-coded key (`basic_text`). The UI warns and asks before storing there.
 */
export function getSecureStorageState(): SecureStorageState {
  try {
    if (!safeStorage.isEncryptionAvailable()) return 'unavailable';
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') return 'weak';
    return 'available';
  } catch {
    return 'unavailable';
  }
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

/** Returns `{}` when nothing is stored or the file can't be decrypted. */
export async function readSecrets(): Promise<TelemetrySecrets> {
  let buf: Buffer;
  try {
    buf = await fs.promises.readFile(getSecretPath());
  } catch {
    return {};
  }
  try {
    return clean(JSON.parse(safeStorage.decryptString(buf)) as TelemetrySecrets);
  } catch {
    // Encrypted under a different OS user or keyring: unusable, treat as unset.
    return {};
  }
}

export async function writeSecrets(secrets: TelemetrySecrets): Promise<void> {
  const cleaned = clean(secrets);
  const file = getSecretPath();
  if (!cleaned.connectionString && !cleaned.otlpHeaders) {
    await deleteSecrets();
    return;
  }
  if (getSecureStorageState() === 'unavailable') {
    throw new Error('Secure storage is unavailable on this system');
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(cleaned));
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, encrypted, { mode: FILE_MODE });
  if (process.platform !== 'win32') await fs.promises.chmod(file, FILE_MODE);
}

let lock: Promise<unknown> = Promise.resolve();

/** Serialized read-modify-write, so concurrent settings saves can't drop a secret. */
export function updateSecrets(fn: (current: TelemetrySecrets) => TelemetrySecrets): Promise<TelemetrySecrets> {
  const run = lock.catch(() => {}).then(async () => {
    const next = clean(fn(await readSecrets()));
    await writeSecrets(next);
    return next;
  });
  lock = run;
  return run;
}

export async function deleteSecrets(): Promise<void> {
  await fs.promises.rm(getSecretPath(), { force: true });
}
