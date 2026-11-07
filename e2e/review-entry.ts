import * as fs from 'node:fs';
import * as path from 'node:path';

/** Run-only, reviewed local entry. Never changes the application's launch defaults. */
export interface ReviewEntry {
  executablePath: string;
  bootstrapPath: string;
  receiptPath: string;
}

export function parseReviewEntry(value: unknown): ReviewEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid review entry');
  const record = value as Record<string, unknown>;
  const keys = ['executablePath', 'bootstrapPath', 'receiptPath'] as const;
  if (Object.keys(record).length !== keys.length) throw new Error('Unexpected review entry fields');
  for (const key of keys) {
    if (typeof record[key] !== 'string' || !path.isAbsolute(record[key]) || record[key].includes('\0')) {
      throw new Error(`Invalid review entry ${key}`);
    }
  }
  return { executablePath: record.executablePath as string, bootstrapPath: record.bootstrapPath as string, receiptPath: record.receiptPath as string };
}

/** Only the selected fixture calls this; ordinary CI has no override. */
export function readReviewEntry(configPath: string | undefined): ReviewEntry | undefined {
  if (configPath === undefined) return undefined;
  if (!path.isAbsolute(configPath)) throw new Error('Review entry config must be absolute');
  const info = fs.lstatSync(configPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Review entry config must be a regular file');
  return parseReviewEntry(JSON.parse(fs.readFileSync(configPath, 'utf8')));
}

export function assertReviewReceipt(raw: string, pid: number | undefined): void {
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0) throw new Error('Missing owned review PID');
  const rows = raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as { pid?: number; kind?: string });
  const owned = rows.filter(row => row.pid === pid);
  const start = owned.findIndex(row => row.kind === 'install-start');
  const installed = owned.findIndex(row => row.kind === 'guard-installed-before-main');
  if (start < 0 || installed <= start) throw new Error('Missing ordered pre-main guard receipt');
}
