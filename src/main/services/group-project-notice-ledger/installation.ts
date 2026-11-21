/** Fixed local installation metadata only. No generation adoption, migration or dispatch. */
import { constants } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { NoticeDirectoryFlusher, type NoticeDirectoryDurability } from './durability';

export const NOTICE_INSTALLATION_MARKER = 'group-project-notice-ledger.required';
export const NOTICE_INSTALLATION_DIRECTORY = 'group-project-notice-ledger.v1';
const MAX_MARKER_BYTES = 8192;
interface InstallationMetadata {
  schemaVersion: 1;
  minWriterVersion: 1 | 2;
  installationId: string;
  phase?: 'bootstrapping' | 'prepared' | 'active';
  [extra: string]: unknown;
}
export class NoticeInstallationError extends Error {
  declare readonly cause?: unknown;
  constructor(public readonly code: 'notice_installation_incomplete' | 'notice_installation_corrupt' | 'notice_installation_version' | 'notice_installation_changed' | 'notice_installation_unavailable', message: string, cause?: unknown) {
    super(message);
    if (cause !== undefined) Object.defineProperty(this, 'cause', { value: cause, configurable: true });
  }
}
export interface NoticeInstallation {
  installationId: string;
  directory: string;
  created: boolean;
  resumedBootstrap: boolean;
  /** Only this open/create's observed flushes; not a claim about historical durability. */
  directoryDurability: NoticeDirectoryDurability;
}
export type NoticeInstallationStage = 'markerSynced' | 'directoryCreated' | 'envelopeSynced' | 'beforeMarkerActive' | 'markerActive';
export type NoticeMetadataPurpose = 'markerCreate' | 'envelopeCreate' | 'markerActivate';
export type NoticeMetadataPoint = 'tempOpened' | 'beforeWrite' | 'beforeSync' | 'beforeRename' | 'beforeCleanup';
export interface NoticeInstallationOptions {
  testFailure?: (stage: NoticeInstallationStage) => void | Promise<void>;
  testMetadataFailure?: (point: NoticeMetadataPoint, purpose: NoticeMetadataPurpose) => void | Promise<void>;
  directoryFlusher?: NoticeDirectoryFlusher;
}
const opening = new Map<string, Promise<NoticeInstallation>>();
const uuid = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
const same = (a: import('fs').BigIntStats, b: import('fs').BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

async function readMetadata(location: string, role: 'marker' | 'envelope', fingerprint?: { digest?: string }): Promise<InstallationMetadata | undefined> {
  let named: import('fs').BigIntStats;
  try { named = await fs.lstat(location, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; // telemetry-exempt: caller distinguishes a fresh install from missing required metadata
    throw error;
  }
  if (!named.isFile() || named.size > BigInt(MAX_MARKER_BYTES)) throw new NoticeInstallationError('notice_installation_corrupt', 'Invalid notice installation metadata file');
  const handle = await fs.open(location, constants.O_RDONLY | constants.O_NONBLOCK);
  let body: Buffer;
  try {
    const before = await handle.stat({ bigint: true });
    if (!same(named, before) || !before.isFile()) throw new NoticeInstallationError('notice_installation_changed', 'Notice installation metadata changed during read');
    body = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < body.length) {
      const read = await handle.read(body, offset, body.length - offset, offset);
      if (!read.bytesRead) throw new NoticeInstallationError('notice_installation_changed', 'Notice installation metadata read was incomplete');
      offset += read.bytesRead;
    }
    if (!same(before, await handle.stat({ bigint: true })) || !same(before, await fs.lstat(location, { bigint: true }))) throw new NoticeInstallationError('notice_installation_changed', 'Notice installation metadata changed during read');
  } finally { await handle.close(); }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { throw new NoticeInstallationError('notice_installation_corrupt', 'Unreadable notice installation metadata'); } // telemetry-exempt: original bytes preserved; stable failure is returned to the owning UI
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new NoticeInstallationError('notice_installation_corrupt', 'Invalid notice installation metadata');
  const value = parsed as Record<string, unknown>;
  if (value.schemaVersion !== 1 || ![1, 2].includes(value.minWriterVersion as number)) throw new NoticeInstallationError('notice_installation_version', 'Unsupported notice installation writer version');
  if (!uuid(value.installationId)) throw new NoticeInstallationError('notice_installation_corrupt', 'Invalid notice installation identity');
  if (value.minWriterVersion === 1 && value.phase !== undefined) throw new NoticeInstallationError('notice_installation_version', 'Legacy notice metadata cannot declare a bootstrap phase');
  if (value.minWriterVersion === 2 && (role === 'marker' ? !['bootstrapping', 'active'].includes(value.phase as string) : value.phase !== 'prepared')) throw new NoticeInstallationError('notice_installation_corrupt', 'Invalid notice installation phase');
  if (fingerprint) fingerprint.digest = createHash('sha256').update(body).digest('hex');
  return { ...value, schemaVersion: 1, minWriterVersion: value.minWriterVersion as 1 | 2, installationId: value.installationId };
}
/** Cleanup only this exclusive-create path, and never let cleanup mask its original failure. */
async function withMetadataTemp(
  location: string, body: string, purpose: NoticeMetadataPurpose, options: NoticeInstallationOptions,
  publish: (temporary: string) => Promise<void>,
): Promise<void> {
  const temporary = `${location}.${randomUUID()}.tmp`;
  let handle: import('fs/promises').FileHandle | undefined;
  let created = false;
  let identity: import('fs').BigIntStats | undefined;
  let failed = false; let original: unknown;
  try {
    handle = await fs.open(temporary, 'wx', 0o600); created = true;
    identity = await handle.stat({ bigint: true });
    await options.testMetadataFailure?.('tempOpened', purpose);
    await options.testMetadataFailure?.('beforeWrite', purpose);
    await handle.writeFile(body);
    await options.testMetadataFailure?.('beforeSync', purpose);
    await handle.sync();
    await handle.close(); handle = undefined; // Windows rename must not retain the open writer.
    await publish(temporary);
  } catch (error) {
    // telemetry-exempt: propagated below after best-effort own-temp cleanup
    failed = true; original = error;
  } finally {
    if (handle) {
      try { await handle.close(); }
      catch (error) {
        // telemetry-exempt: preserve first failure over secondary close error
        if (!failed) { failed = true; original = error; }
      }
    }
    if (created) {
      try {
        await options.testMetadataFailure?.('beforeCleanup', purpose);
        const named = await fs.lstat(temporary, { bigint: true });
        if (named.isFile() && (!identity || named.dev === identity.dev && named.ino === identity.ino)) await fs.unlink(temporary);
      } catch { /* telemetry-exempt: best effort only; do not mask original error or remove an ambiguous replacement; residue remains fail-closed */ }
    }
  }
  if (failed) throw original;
}
async function activateMarker(location: string, expected: InstallationMetadata, flusher: NoticeDirectoryFlusher, options: NoticeInstallationOptions): Promise<void> {
  const expectedBytes: { digest?: string } = {};
  const current = await readMetadata(location, 'marker', expectedBytes);
  if (!current || current.minWriterVersion !== 2 || current.phase !== 'bootstrapping' || current.installationId !== expected.installationId) throw new NoticeInstallationError('notice_installation_changed', 'Notice bootstrap marker is no longer current');
  await withMetadataTemp(location, JSON.stringify({ ...current, phase: 'active' }), 'markerActivate', options, async (temporary) => {
    const actualBytes: { digest?: string } = {};
    await readMetadata(location, 'marker', actualBytes);
    if (actualBytes.digest !== expectedBytes.digest) throw new NoticeInstallationError('notice_installation_changed', 'Notice bootstrap marker changed before activation');
    await options.testMetadataFailure?.('beforeRename', 'markerActivate');
    // Single-instance + single-flight premise; this is not interprocess compare-and-swap.
    await fs.rename(temporary, location);
    await flusher.flush(path.dirname(location));
  });
}
async function pristineBootstrap(directory: string, marker: InstallationMetadata): Promise<InstallationMetadata | undefined> {
  for await (const entry of await fs.opendir(directory)) {
    if (entry.name !== 'installation.json') throw new NoticeInstallationError('notice_installation_incomplete', 'Notice bootstrap has ambiguous retained data');
  }
  const envelope = await readMetadata(path.join(directory, 'installation.json'), 'envelope');
  if (envelope && (envelope.installationId !== marker.installationId || envelope.minWriterVersion !== 2 || envelope.phase !== 'prepared')) throw new NoticeInstallationError('notice_installation_changed', 'Notice bootstrap envelope is not the prepared identity');
  return envelope;
}
async function writeNewMetadata(location: string, value: InstallationMetadata, flusher: NoticeDirectoryFlusher, options: NoticeInstallationOptions, purpose: NoticeMetadataPurpose): Promise<void> {
  await withMetadataTemp(location, JSON.stringify(value), purpose, options, async (temporary) => {
    // Metadata initialization is owned by the single main instance. Never overwrite a discovered file.
    try { await fs.lstat(location); throw new NoticeInstallationError('notice_installation_changed', 'Notice installation metadata appeared during creation'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } // telemetry-exempt: unexpected writer conflict refuses activation
    await options.testMetadataFailure?.('beforeRename', purpose);
    await fs.rename(temporary, location);
    await flusher.flush(path.dirname(location));
  });
}

/** userData comes from trusted main app ownership, never renderer/Annex input. */
export function openNoticeInstallation(userData: string, options: NoticeInstallationOptions = {}): Promise<NoticeInstallation> {
  const ownedPath = path.resolve(userData);
  const existing = opening.get(ownedPath);
  if (existing) return existing;
  const work: Promise<NoticeInstallation> = openOwnedInstallation(ownedPath, options).finally(() => {
    if (opening.get(ownedPath) === work) opening.delete(ownedPath);
  });
  opening.set(ownedPath, work);
  return work;
}
async function openOwnedInstallation(userData: string, options: NoticeInstallationOptions): Promise<NoticeInstallation> {
  const flusher = options.directoryFlusher ?? new NoticeDirectoryFlusher();
  const markerPath = path.join(userData, NOTICE_INSTALLATION_MARKER);
  const directory = path.join(userData, NOTICE_INSTALLATION_DIRECTORY);
  const envelopePath = path.join(directory, 'installation.json');
  try {
    let marker = await readMetadata(markerPath, 'marker');
    let directoryExists = false;
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new NoticeInstallationError('notice_installation_corrupt', 'Invalid notice ledger directory');
      directoryExists = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } // telemetry-exempt: absence is classified against the independent marker
    if (marker && (marker.minWriterVersion === 1 || marker.phase === 'active')) {
      if (!directoryExists) throw new NoticeInstallationError('notice_installation_incomplete', 'Required notice ledger directory is missing');
      const envelope = await readMetadata(envelopePath, 'envelope');
      if (!envelope) throw new NoticeInstallationError('notice_installation_incomplete', 'Required notice ledger envelope is missing');
      if (envelope.installationId !== marker.installationId || envelope.minWriterVersion !== marker.minWriterVersion) throw new NoticeInstallationError('notice_installation_changed', 'Notice installation identities or writer versions do not match');
      return { installationId: marker.installationId, directory, created: false, resumedBootstrap: false, directoryDurability: flusher.observation };
    }
    const resumedBootstrap = !!marker;
    if (!marker) {
      if (directoryExists) throw new NoticeInstallationError('notice_installation_incomplete', 'Notice ledger exists without its required marker');
      await fs.mkdir(userData, { recursive: true });
      marker = { schemaVersion: 1, minWriterVersion: 2, installationId: randomUUID(), phase: 'bootstrapping' };
      await writeNewMetadata(markerPath, marker, flusher, options, 'markerCreate');
      await options.testFailure?.('markerSynced');
    }
    if (!directoryExists) {
      await fs.mkdir(directory, { mode: 0o700 });
      await flusher.flush(userData);
      await options.testFailure?.('directoryCreated');
    }
    const envelope = await pristineBootstrap(directory, marker);
    if (!envelope) {
      await writeNewMetadata(envelopePath, { schemaVersion: 1, minWriterVersion: 2, installationId: marker.installationId, phase: 'prepared' }, flusher, options, 'envelopeCreate');
      await options.testFailure?.('envelopeSynced');
    }
    await pristineBootstrap(directory, marker);
    await options.testFailure?.('beforeMarkerActive');
    await activateMarker(markerPath, marker, flusher, options);
    await options.testFailure?.('markerActive');
    return { installationId: marker.installationId, directory, created: !resumedBootstrap, resumedBootstrap, directoryDurability: flusher.observation };
  } catch (error) {
    if (error instanceof NoticeInstallationError) throw error;
    throw new NoticeInstallationError('notice_installation_unavailable', 'Local notice installation is unavailable', error); // telemetry-exempt: preserve private cause; stable message/code omit local paths/raw errors
  }
}
