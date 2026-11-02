/**
 * A bounded JSON-lines audit file under the Clubhouse base dir: one line per
 * row, moved to `.1` at {@link MAX_AUDIT_BYTES}, replacing the last one. Appends
 * and reads run one at a time, so a rotation never races a write. appLog isn't
 * enough for this: it can be off.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { getBaseDirPath } from './base-dir';
import { appLog } from './log-service';

export const MAX_AUDIT_BYTES = 1024 * 1024;

export interface AuditLog<Row> {
  path(): string;
  /** Append a row. Returns false when it couldn't be written: the change it describes has already happened. */
  append(row: Row): Promise<boolean>;
  /** The newest rows, newest first, up to `limit`. */
  read(limit: number): Promise<Array<Row & { ts: string }>>;
  /** For testing: forget pending work. */
  reset(): void;
}

async function rotateIfFull(file: string): Promise<void> {
  try {
    if ((await fsp.stat(file)).size >= MAX_AUDIT_BYTES) await fsp.rename(file, `${file}.1`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

async function readRows<T>(file: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const rows: T[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // telemetry-exempt: a torn line (a crash mid-append) is skipped; the rest still read
    }
  }
  return rows;
}

export function createAuditLog<Row extends object>(fileName: string, describe: (row: Row) => Record<string, unknown>, maxRead: number): AuditLog<Row> {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.catch((): void => undefined).then(fn);
    queue = run.catch((): void => undefined);
    return run;
  };
  const filePath = () => path.join(getBaseDirPath(), fileName);
  return {
    path: filePath,
    append: (row) => serial(async () => {
      try {
        const file = filePath();
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await rotateIfFull(file);
        await fsp.appendFile(file, `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`, 'utf-8');
        return true;
      } catch (err) {
        // telemetry-exempt: logged, and the caller decides what to tell whoever asked
        appLog('core:mcp', 'warn', `Could not write ${fileName}`, {
          meta: { ...describe(row), error: err instanceof Error ? err.message : String(err) },
        });
        return false;
      }
    }),
    read: (limit) => {
      const wanted = Math.min(Math.max(Math.floor(limit), 0), maxRead);
      return serial(async () => {
        if (wanted === 0) return [];
        const file = filePath();
        let rows = await readRows<Row & { ts: string }>(file);
        if (rows.length < wanted) rows = [...await readRows<Row & { ts: string }>(`${file}.1`), ...rows];
        return rows.slice(-wanted).reverse();
      });
    },
    reset: () => { queue = Promise.resolve(); },
  };
}
