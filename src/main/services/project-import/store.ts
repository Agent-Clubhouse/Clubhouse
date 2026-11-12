import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getBaseDirPath } from '../base-dir';
import { ACTIVE_PHASES, IMPORT_EFFECTS, ImportError, containsControlCharacters, validateGithubUrl, validateImportBranch, type ImportPlan, type ImportReceipt, type ImportState } from './types';

export const IMPORT_STATE_MAX_BYTES = 128 * 1024;
export const IMPORT_HISTORY_MAX = 32;
const PHASES = new Set([...ACTIVE_PHASES, 'completed', 'partial', 'cancelled', 'interrupted', 'failed']);
const ID = /^[a-f0-9-]{36}$/;
const HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

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
  return object(value) && keys(value, ['id', 'plan', 'phase', 'updatedAt', 'directoryIdentity', 'cloneCompleted', 'projectId', 'gitignore', 'reason', 'failedAt', 'progress', 'agentCreated', 'agentStarted'])
    && typeof value.id === 'string' && ID.test(value.id) && validPlan(value.plan)
    && typeof value.phase === 'string' && PHASES.has(value.phase)
    && typeof value.updatedAt === 'number' && Number.isSafeInteger(value.updatedAt)
    && typeof value.cloneCompleted === 'boolean' && value.agentCreated === false && value.agentStarted === false
    && (value.directoryIdentity === undefined || boundedString(value.directoryIdentity, 100))
    && (value.projectId === undefined || boundedString(value.projectId, 200))
    && (value.gitignore === undefined || ['updated', 'unchanged', 'failed'].includes(String(value.gitignore)))
    && (value.reason === undefined || (typeof value.reason === 'string' && /^[a-z_]{1,100}$/.test(value.reason)))
    && (value.failedAt === undefined || (typeof value.failedAt === 'string' && PHASES.has(value.failedAt)))
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

  private async read(): Promise<ImportState> {
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, plans: [], receipts: [] };
      throw new ImportError('history_unavailable', 'Import history cannot be read safely. Existing state was not replaced.');
    }
    try {
      const buffer = Buffer.alloc(IMPORT_STATE_MAX_BYTES + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > IMPORT_STATE_MAX_BYTES) throw new ImportError('history_corrupt', 'Import history exceeds its byte limit. Existing state was not replaced.');
      return decodeImportState(buffer.subarray(0, total).toString('utf8'));
    } finally {
      await handle.close();
    }
  }

  async get(): Promise<ImportState> {
    await this.queue;
    return this.read();
  }

  update(fn: (state: ImportState) => void): Promise<ImportState> {
    const operation = this.queue.then(async () => {
      const state = await this.read();
      fn(state);
      const body = encodeImportState(state);
      // Revalidate our own encoding before committing, including the exact persisted byte bound.
      decodeImportState(body);
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      const handle = await fsp.open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(body, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fsp.rename(temp, this.file);
      } catch {
        // telemetry-exempt: a failed receipt write is explicit; only our exact temporary file is removed.
        await fsp.unlink(temp);
        throw new ImportError('history_unavailable', 'Import history could not be saved. Any completed checkout or project is preserved; inspect status before retrying.');
      }
      return state;
    });
    this.queue = operation.catch((): void => {});
    return operation;
  }
}
