/**
 * Small JSON files behind the group project host (#3356): a missing file reads
 * as its default, an unreadable or corrupt one refuses rather than being
 * replaced, and writes are atomic (temp file, flush, rename) so a crash
 * mid-write leaves the previous contents readable.
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import { replaceFile } from './settings-store';

export async function readJsonFile<T>(file: string, fallback: () => T, validate: (value: unknown) => T): Promise<T> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback();
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path.basename(file)} could not be read. Its file was left unchanged.`);
  }
  return validate(parsed);
}

export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await replaceFile(file, JSON.stringify(value, null, 2), undefined);
}
