/** Fixed local installation metadata only. No generation adoption, migration or dispatch. */
import { constants } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { NoticeDirectoryFlusher, type NoticeDirectoryDurability } from './durability';

export const NOTICE_INSTALLATION_MARKER = 'group-project-notice-ledger.required';
export const NOTICE_INSTALLATION_DIRECTORY = 'group-project-notice-ledger.v1';
const MAX_MARKER_BYTES = 8192;
interface InstallationMetadata {
  schemaVersion: 1;
  minWriterVersion: 1;
  installationId: string;
  [extra: string]: unknown;
}
export class NoticeInstallationError extends Error {
  constructor(public readonly code: 'notice_installation_incomplete' | 'notice_installation_corrupt' | 'notice_installation_version' | 'notice_installation_changed' | 'notice_installation_unavailable', message: string) { super(message); }
}
export interface NoticeInstallation {
  installationId: string;
  directory: string;
  created: boolean;
  /** Only this open/create's observed flushes; not a claim about historical durability. */
  directoryDurability: NoticeDirectoryDurability;
}
export type NoticeInstallationStage = 'markerSynced' | 'directoryCreated' | 'envelopeSynced';
export interface NoticeInstallationOptions {
  testFailure?: (stage: NoticeInstallationStage) => void | Promise<void>;
  directoryFlusher?: NoticeDirectoryFlusher;
}
const opening = new Map<string, Promise<NoticeInstallation>>();
const uuid = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
const same = (a: import('fs').BigIntStats, b: import('fs').BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

async function readMetadata(location: string): Promise<InstallationMetadata | undefined> {
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
  if (value.schemaVersion !== 1 || value.minWriterVersion !== 1) throw new NoticeInstallationError('notice_installation_version', 'Unsupported notice installation writer version');
  if (!uuid(value.installationId)) throw new NoticeInstallationError('notice_installation_corrupt', 'Invalid notice installation identity');
  return { ...value, schemaVersion: 1, minWriterVersion: 1, installationId: value.installationId };
}
async function writeNewMetadata(location: string, value: InstallationMetadata, flusher: NoticeDirectoryFlusher): Promise<void> {
  const temporary = `${location}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  // Metadata initialization is owned by the single main instance. Never overwrite a discovered file.
  try { await fs.lstat(location); throw new NoticeInstallationError('notice_installation_changed', 'Notice installation metadata appeared during creation'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } // telemetry-exempt: unexpected writer conflict refuses activation
  await fs.rename(temporary, location);
  await flusher.flush(path.dirname(location));
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
    const marker = await readMetadata(markerPath);
    let directoryExists = false;
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new NoticeInstallationError('notice_installation_corrupt', 'Invalid notice ledger directory');
      directoryExists = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } // telemetry-exempt: absence is classified against the independent marker
    if (marker) {
      if (!directoryExists) throw new NoticeInstallationError('notice_installation_incomplete', 'Required notice ledger directory is missing');
      const envelope = await readMetadata(envelopePath);
      if (!envelope) throw new NoticeInstallationError('notice_installation_incomplete', 'Required notice ledger envelope is missing');
      if (envelope.installationId !== marker.installationId) throw new NoticeInstallationError('notice_installation_changed', 'Notice installation identities do not match');
      return { installationId: marker.installationId, directory, created: false, directoryDurability: flusher.observation };
    }
    if (directoryExists) throw new NoticeInstallationError('notice_installation_incomplete', 'Notice ledger exists without its required marker');
    await fs.mkdir(userData, { recursive: true });
    const metadata: InstallationMetadata = { schemaVersion: 1, minWriterVersion: 1, installationId: randomUUID() };
    await writeNewMetadata(markerPath, metadata, flusher);
    await options.testFailure?.('markerSynced');
    await fs.mkdir(directory, { mode: 0o700 });
    await flusher.flush(userData);
    await options.testFailure?.('directoryCreated');
    await writeNewMetadata(envelopePath, metadata, flusher);
    await options.testFailure?.('envelopeSynced');
    return { installationId: metadata.installationId, directory, created: true, directoryDurability: flusher.observation };
  } catch (error) {
    if (error instanceof NoticeInstallationError) throw error;
    throw new NoticeInstallationError('notice_installation_unavailable', 'Local notice installation is unavailable'); // telemetry-exempt: never rebaseline on IO/fault; stable code omits local paths/raw errors
  }
}
