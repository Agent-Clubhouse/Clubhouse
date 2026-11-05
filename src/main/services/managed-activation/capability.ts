/** Installed CLI flag evidence only. No auth, model, quota or policy readiness probe. */
import * as fs from 'fs/promises';
import * as syncFs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { ManagedActivationError } from './types';

export interface CliIdentity {
  path: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  sha256: string;
}
export interface DeliveryCapability {
  provider: 'claude-code';
  platform: 'darwin';
  version: string;
  identity: CliIdentity;
  flags: ['--append-system-prompt-file', '--plugin-dir'];
}

export async function cliIdentity(binary: string): Promise<CliIdentity> {
  if (!path.isAbsolute(binary)) throw new ManagedActivationError('activation_capability_unproven');
  const resolved = await fs.realpath(binary);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new ManagedActivationError('activation_capability_unproven');
  const sha256 = createHash('sha256').update(await fs.readFile(resolved)).digest('hex');
  return { path: resolved, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, sha256 };
}

export type CapabilityCommand = (binary: string, args: string[]) => Promise<string>;
const command: CapabilityCommand = (binary, args) => new Promise((resolve, reject) => {
  execFile(binary, args, { timeout: 5000, maxBuffer: 128 * 1024, windowsHide: true }, (err, stdout) => {
    if (err) reject(new ManagedActivationError('activation_capability_unproven'));
    else resolve(stdout);
  });
});

export async function establishDeliveryCapability(binary: string, platform: NodeJS.Platform = process.platform,
  execute: CapabilityCommand = command): Promise<DeliveryCapability> {
  if (platform !== 'darwin') throw new ManagedActivationError('activation_unsupported');
  try {
    const identity = await cliIdentity(binary);
    const versionOutput = await execute(identity.path, ['--version']);
    const match = /^(\d+)\.(\d+)\.(\d+)(?: \(Claude Code\))?\s*$/.exec(versionOutput);
    // Conservative bounded adapter floor, not an assertion about when a flag was introduced.
    if (!match || Number(match[1]) !== 2 || Number(match[2]) !== 1 || Number(match[3]) < 316) throw new ManagedActivationError('activation_capability_unproven');
    const help = await execute(identity.path, ['--help']);
    const flags: DeliveryCapability['flags'] = ['--append-system-prompt-file', '--plugin-dir'];
    if (flags.some((flag) => !help.split(/\r?\n/).some((line) => line.trimStart().startsWith(`${flag} `)))) throw new ManagedActivationError('activation_capability_unproven');
    const evidence: DeliveryCapability = { provider: 'claude-code', platform: 'darwin', version: `${match[1]}.${match[2]}.${match[3]}`, identity, flags };
    await assertDeliveryCapability(evidence, binary, platform);
    return evidence;
  } catch {
    // telemetry-exempt: CLI output and paths must not escape capability detection.
    throw new ManagedActivationError('activation_capability_unproven');
  }
}

export async function assertDeliveryCapability(capability: DeliveryCapability, binary: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform !== 'darwin' || capability.platform !== platform || capability.provider !== 'claude-code'
    || JSON.stringify(capability.identity) !== JSON.stringify(await cliIdentity(binary))) {
    throw new ManagedActivationError('activation_capability_stale');
  }
}

/** Last same-process boundary check, after asynchronous cwd validation and immediately before PTY creation. */
export function assertDeliveryCapabilitySync(capability: DeliveryCapability, binary: string): void {
  const resolved = syncFs.realpathSync(binary);
  const stat = syncFs.statSync(resolved);
  const sha256 = createHash('sha256').update(syncFs.readFileSync(resolved)).digest('hex');
  const identity: CliIdentity = { path: resolved, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, sha256 };
  if (JSON.stringify(identity) !== JSON.stringify(capability.identity)) throw new ManagedActivationError('activation_capability_stale');
}
