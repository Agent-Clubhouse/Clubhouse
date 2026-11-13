import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getBaseDirPath } from '../base-dir';
import { appLog } from '../log-service';
import { ACTIVE_PHASES, IMPORT_EFFECTS, ImportError, containsControlCharacters, validateGithubUrl, validateImportBranch, type ImportPlan, type ImportReceipt, type ImportState } from './types';

export const IMPORT_STATE_MAX_BYTES = 128 * 1024;
export const IMPORT_HISTORY_MAX = 32;
const PHASES = new Set([...ACTIVE_PHASES, 'completed', 'partial', 'cancelled', 'interrupted', 'failed']);
const ID = /^[a-f0-9-]{36}$/;
const HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function fileSignature(stat: fs.BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

async function verifyMissingParent(file: string): Promise<void> {
  let directory = path.dirname(file);
  for (let probes = 0; probes < 128; probes++) {
    let stat: fs.BigIntStats;
    try {
      stat = await fsp.lstat(directory, { bigint: true });
    } catch (error) {
      // telemetry-exempt: only verified absence is accepted; filesystem paths/errors stay private.
      const parent = path.dirname(directory);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && parent !== directory) {
        directory = parent;
        continue;
      }
      throw new ImportError('history_unavailable', 'Import history absence cannot be verified safely. Existing state was not replaced.');
    }
    if (stat.isDirectory() && !stat.isSymbolicLink()) return;
    throw new ImportError('history_unavailable', 'Import history has an unsafe parent. Existing state was not replaced.');
  }
  throw new ImportError('history_unavailable', 'Import history absence exceeds the bounded parent inspection. Existing state was not replaced.');
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function boundedString(value: unknown, max = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !containsControlCharacters(value);
}

function validPlan(value: unknown): value is ImportPlan {
  if (!object(value) || !keys(value, ['id', 'agentId', 'url', 'defaultBranch', 'branch', 'commit', 'headCommit', 'destination', 'parent', 'parentIdentity', 'createdAt', 'expiresAt', 'effects'])) return false;
  if (typeof value.id !== 'string' || !ID.test(value.id) || !boundedString(value.agentId, 200)
    || !boundedString(value.url, 200) || !boundedString(value.branch, 200) || !boundedString(value.defaultBranch, 200)
    || typeof value.commit !== 'string' || !HASH.test(value.commit) || typeof value.headCommit !== 'string' || !HASH.test(value.headCommit)
    || !boundedString(value.destination) || !path.isAbsolute(value.destination) || !boundedString(value.parent) || !path.isAbsolute(value.parent)
    || path.dirname(value.destination) !== value.parent || !boundedString(value.parentIdentity, 100)
    || typeof value.createdAt !== 'number' || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= value.createdAt
    || JSON.stringify(value.effects) !== JSON.stringify(IMPORT_EFFECTS)) return false;
  try {
    return validateGithubUrl(value.url) === value.url && validateImportBranch(value.branch) === value.branch
      && validateImportBranch(value.defaultBranch) === value.defaultBranch;
  } catch {
    // telemetry-exempt: the caller refuses the corrupt lifecycle store without overwriting it.
    return false;
  }
}

function validReceipt(value: unknown): value is ImportReceipt {
  return object(value) && keys(value, ['id', 'plan', 'phase', 'updatedAt', 'directoryIdentity', 'cloneCompleted', 'projectId', 'gitignore', 'reason', 'failedAt', 'progress', 'agentCreated', 'agentStarted', 'agentCreation'])
    && typeof value.id === 'string' && ID.test(value.id) && validPlan(value.plan)
    && typeof value.phase === 'string' && PHASES.has(value.phase)
    && typeof value.updatedAt === 'number' && Number.isSafeInteger(value.updatedAt)
    && typeof value.cloneCompleted === 'boolean' && value.agentCreated === false && value.agentStarted === false
    && (value.directoryIdentity === undefined || boundedString(value.directoryIdentity, 100))
    && (value.projectId === undefined || boundedString(value.projectId, 200))
    && (value.gitignore === undefined || ['updated', 'unchanged', 'failed'].includes(String(value.gitignore)))
    && (value.reason === undefined || (typeof value.reason === 'string' && /^[a-z_]{1,100}$/.test(value.reason)))
    && (value.failedAt === undefined || (typeof value.failedAt === 'string' && PHASES.has(value.failedAt)))
    && (value.agentCreation === undefined || (object(value.agentCreation)
      && keys(value.agentCreation, ['key', 'requestId', 'phase', 'agentId'])
      && typeof value.agentCreation.key === 'string' && /^[a-f0-9]{64}$/.test(value.agentCreation.key)
      && typeof value.agentCreation.requestId === 'string' && ID.test(value.agentCreation.requestId)
      && ['reserved', 'completed', 'failed'].includes(String(value.agentCreation.phase))
      && (value.agentCreation.agentId === undefined || boundedString(value.agentCreation.agentId, 200))
      && (value.agentCreation.receiptSaved === undefined || (value.agentCreation.receiptSaved === false && value.agentCreation.phase === 'completed'))
      && (value.agentCreation.phase !== 'completed' || boundedString(value.agentCreation.agentId, 200))))
    && (value.progress === undefined || (typeof value.progress === 'number' && Number.isInteger(value.progress) && value.progress >= 0 && value.progress <= 100));
}

export function encodeImportState(state: ImportState): string {
  const body = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(body, 'utf8') > IMPORT_STATE_MAX_BYTES) {
    throw new ImportError('history_limit', 'Import history reached its byte limit. Existing imports are preserved; no new filesystem operation was started.');
  }
  return body;
}

export function decodeImportState(raw: string): ImportState {
  const invalid = () => new ImportError('history_corrupt', 'Import history is unreadable or has an unsupported schema. It was not replaced. Restore the app-owned project-imports.json from a known-good backup before importing again.');
  if (Buffer.byteLength(raw, 'utf8') > IMPORT_STATE_MAX_BYTES) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // telemetry-exempt: the explicit corrupt-history result preserves the original bytes.
    throw invalid();
  }
  if (!object(value) || !keys(value, ['version', 'plans', 'receipts']) || value.version !== 1
    || !Array.isArray(value.plans) || value.plans.length > IMPORT_HISTORY_MAX || !value.plans.every(validPlan)
    || !Array.isArray(value.receipts) || value.receipts.length > IMPORT_HISTORY_MAX || !value.receipts.every(validReceipt)
    || new Set(value.plans.map((p) => p.id)).size !== value.plans.length
    || new Set(value.receipts.map((r) => r.id)).size !== value.receipts.length
    || new Set(value.receipts.map((r) => r.plan.id)).size !== value.receipts.length) throw invalid();
  return { version: 1, plans: value.plans, receipts: value.receipts };
}

export class ImportStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file = path.join(getBaseDirPath(), 'project-imports.json')) {}

  private async read(): Promise<{ state: ImportState; signature?: string }> {
    const unavailable = () => new ImportError('history_unavailable', 'Import history cannot be read safely. Existing state was not replaced.');
    let before: fs.BigIntStats;
    try {
      before = await fsp.lstat(this.file, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await verifyMissingParent(this.file);
        return { state: { version: 1, plans: [], receipts: [] } };
      }
      throw unavailable();
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw unavailable();
    const signature = fileSignature(before);
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    } catch {
      // telemetry-exempt: a previously observed ledger must not become an empty-store fallback.
      throw unavailable();
    }
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || fileSignature(opened) !== signature) throw unavailable();
      const buffer = Buffer.alloc(IMPORT_STATE_MAX_BYTES + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > IMPORT_STATE_MAX_BYTES) throw new ImportError('history_corrupt', 'Import history exceeds its byte limit. Existing state was not replaced.');
      if (fileSignature(await handle.stat({ bigint: true })) !== signature
        || fileSignature(await fsp.lstat(this.file, { bigint: true })) !== signature) throw unavailable();
      return { state: decodeImportState(buffer.subarray(0, total).toString('utf8')), signature };
    } catch (error) {
      // telemetry-exempt: filesystem diagnostics and lifecycle paths stay private.
      if (error instanceof ImportError) throw error;
      throw unavailable();
    } finally {
      await handle.close();
    }
  }

  async get(): Promise<ImportState> {
    await this.queue;
    return (await this.read()).state;
  }

  update(fn: (state: ImportState) => void): Promise<ImportState> {
    const operation = this.queue.then(async () => {
      const { state, signature } = await this.read();
      fn(state);
      const body = encodeImportState(state);
      // Revalidate our own encoding before committing, including the exact persisted byte bound.
      decodeImportState(body);
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      const handle = await fsp.open(temp, 'wx+', 0o600);
      const unavailable = () => new ImportError('history_unavailable', 'Import history could not be saved safely. Existing committed history and any checkout/project were preserved; inspect status before retrying.');
      const expected = Buffer.from(body, 'utf8');
      let created: fs.BigIntStats | undefined;
      let sealed: string | undefined;
      let writtenSealed = false;
      let committed = false;
      let failure: ImportError | undefined;
      const verifyTemp = (version?: string) => {
        const opened = fs.fstatSync(handle.fd, { bigint: true });
        const current = fs.lstatSync(temp, { bigint: true, throwIfNoEntry: false });
        const owned = (stat: fs.BigIntStats) => created && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n
          && stat.dev === created.dev && stat.ino === created.ino && stat.mode === created.mode;
        if (!owned(opened) || !current || !owned(current) || fileSignature(opened) !== fileSignature(current)
          || (version !== undefined && fileSignature(opened) !== version)) throw unavailable();
        return opened;
      };
      const verifyBytes = () => {
        const buffer = Buffer.alloc(expected.length + 1);
        let total = 0;
        while (total < buffer.length) {
          const bytes = fs.readSync(handle.fd, buffer, total, buffer.length - total, total);
          if (!bytes) break;
          total += bytes;
        }
        if (total !== expected.length || !buffer.subarray(0, total).equals(expected)) throw unavailable();
      };
      try {
        created = fs.fstatSync(handle.fd, { bigint: true });
        sealed = fileSignature(created);
        if (created.size !== 0n) throw unavailable();
        verifyTemp(sealed);
        await handle.writeFile(body, 'utf8');
        const written = verifyTemp();
        if (written.size !== BigInt(expected.length)) throw unavailable();
        verifyBytes();
        sealed = fileSignature(written);
        verifyTemp(sealed);
        writtenSealed = true;
        await handle.sync();
        verifyTemp(sealed);
        verifyBytes();
        const current = fs.lstatSync(this.file, { bigint: true, throwIfNoEntry: false });
        if ((current ? fileSignature(current) : undefined) !== signature) {
          throw unavailable();
        }
        verifyTemp(sealed);
        await fsp.rename(temp, this.file);
        committed = true;
      } catch {
        // telemetry-exempt: failure is explicit; remove only the unchanged owned temporary file.
        try {
          if (!sealed) throw unavailable();
          verifyTemp(sealed);
          if (writtenSealed) verifyBytes();
          verifyTemp(sealed);
          fs.unlinkSync(temp);
        } catch {
          // telemetry-exempt: report preserved unexpected state without private paths or raw errors.
          appLog('core:project', 'warn', 'Import history commit failed; unexpected temporary state was preserved');
        }
        failure = unavailable();
      } finally {
        try { await handle.close(); } catch {
          // telemetry-exempt: report the actual commit outcome without private paths or raw errors.
          appLog('core:project', 'warn', 'Import history descriptor could not be closed safely', { meta: { committed } });
          failure = new ImportError('history_unavailable', committed
            ? 'Import history was committed, but its file could not be closed safely. Inspect status before retrying.'
            : 'Import history could not be closed safely. Existing committed history was preserved; inspect status before retrying.');
        }
      }
      if (failure) throw failure;
      return state;
    });
    this.queue = operation.catch((): void => {});
    return operation;
  }
}
