/**
 * The local record's hash salt before any export is set up (#2920). Local
 * recording hashes ids the way export does, and needs the same salt from one
 * run to the next so a hash in an older file still means the same agent: the
 * Dispatcher's `list_orchestrator_controls` maps them back by hashing the
 * agents it knows. Without an install identity there's no salt to reuse, so
 * this keeps one in `telemetry-local-salt.json` (0600, next to
 * telemetry-settings.json). It holds the salt only: never an install id.
 *
 * The first install identity adopts it, so local and exported hashes match and
 * a later backfill needs no rehashing. Resetting the install id or deleting
 * local telemetry data removes it.
 */

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

const FILE = 'telemetry-local-salt.json';

function filePath(): string {
  return path.join(app.getPath('userData'), FILE);
}

function valid(salt: unknown): salt is string {
  return typeof salt === 'string' && Buffer.from(salt, 'base64').length === 32;
}

/** The saved local salt, if there is one. Never creates it. */
export function peekLocalSalt(): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf-8')) as { hashSalt?: unknown };
    return valid(parsed.hashSalt) ? parsed.hashSalt : undefined;
  } catch {
    return undefined;
  }
}

/** The local salt, made and saved on first use. If it can't be saved, a salt for this run only. */
export function localSalt(): Buffer {
  const saved = peekLocalSalt();
  if (saved) return Buffer.from(saved, 'base64');
  const hashSalt = randomBytes(32).toString('base64');
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify({ hashSalt }), { mode: 0o600 });
  } catch {
    // Read-only or missing userData: hashes hold for this run only.
  }
  return Buffer.from(hashSalt, 'base64');
}

/** Remove the saved salt: the install id was reset, or local telemetry data deleted. Never throws. */
export function deleteLocalSalt(): void {
  try {
    fs.rmSync(filePath(), { force: true });
  } catch {
    // Nothing to remove, or it can't be: the next identity simply won't adopt it.
  }
}
