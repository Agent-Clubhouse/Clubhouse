/**
 * Immutable, private app staging only. Never writes or removes worktree/repository files.
 * Ordinary repository edits cannot redirect these paths. Malicious same-user rewrites of
 * private app storage are outside this boundary; observed private edits fail closed.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import type { FrozenActivation } from '../asset-catalog/store';
import { ManagedActivationError, type OutputFile, type PreparedGeneration } from './types';

export const byteHash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
export interface OutputBytes extends OutputFile { bytes: Buffer }
export const pluginNameFor = (agentId: string): string => `clubhouse-agent-${byteHash(agentId).slice(0, 16)}`;

/** Accept a small unambiguous YAML subset, rather than trying to blacklist operational keys. */
export function validateSkillText(text: string, skillName: string): void {
  const unsupported = () => { throw new ManagedActivationError('activation_skill_unsupported'); };
  // Provider dynamic command interpolation would execute during skill expansion.
  if (text.includes('!`') || text.startsWith('\uFEFF')) unsupported();
  if (!text.startsWith('---')) return;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') unsupported();
  const end = lines.indexOf('---', 1);
  if (end < 1) unsupported();
  const keys = new Set<string>();
  for (const line of lines.slice(1, end)) {
    // No quoted/duplicate keys, tags, aliases, flow syntax, multiline scalars or unknown fields.
    const match = /^(name|description): ([a-zA-Z0-9][a-zA-Z0-9 .,_()/+-]*)$/.exec(line);
    if (!match || keys.has(match[1])) unsupported();
    keys.add(match![1]);
    if (match![1] === 'name' && match![2] !== skillName) unsupported();
  }
}

export function outputsOf(frozen: FrozenActivation): { files: OutputBytes[]; skillRoots: string[]; skillNames: string[] } {
  if (frozen.instructions === null) throw new ManagedActivationError('activation_unsupported');
  const files: OutputBytes[] = [];
  const add = (filePath: string, bytes: Buffer, executable = false) => {
    if (!filePath || filePath.includes('\\') || filePath.split('/').some((part) => !part || part === '.' || part === '..')
      || path.posix.isAbsolute(filePath) || files.some((file) => file.path.toLowerCase() === filePath.toLowerCase())) {
      throw new ManagedActivationError('activation_corrupt');
    }
    files.push({ path: filePath, hash: byteHash(bytes), executable, bytes });
  };
  add('instructions.txt', Buffer.from(frozen.instructions, 'utf8'));
  const namespace = pluginNameFor(frozen.plan.agentId);
  if (frozen.skills.length) add('plugin/.claude-plugin/plugin.json', Buffer.from(JSON.stringify({ name: namespace })));
  const skillRoots = frozen.skills.map(({ payload }) => {
    const entry = payload.files.find((file) => file.path === 'SKILL.md');
    if (!entry || entry.encoding === 'base64') throw new ManagedActivationError('activation_skill_unsupported');
    validateSkillText(entry.content, payload.skillName);
    const root = `plugin/skills/${payload.skillName}`;
    for (const file of payload.files) add(`${root}/${file.path}`, Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8'), file.executable);
    return root;
  });
  const folded = files.map((file) => file.path.toLowerCase());
  if (folded.some((file, i) => folded.some((other, j) => i !== j && other.startsWith(`${file}/`)))) throw new ManagedActivationError('activation_corrupt');
  return { files, skillRoots, skillNames: frozen.skills.map(({ payload }) => `${namespace}:${payload.skillName}`) };
}

async function statOrNull(file: string) {
  try { return await fs.lstat(file); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
}

async function checkDirectory(dir: string): Promise<void> {
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ManagedActivationError('activation_foreign_output');
}

/** Check all existing ancestors beneath the trusted private app root. No repo path is accepted. */
async function checkParents(root: string, relative: string): Promise<void> {
  await checkDirectory(root);
  const parts = relative.split('/');
  for (let count = 1; count < parts.length; count++) {
    const dir = path.join(root, ...parts.slice(0, count));
    const stat = await statOrNull(dir);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new ManagedActivationError('activation_foreign_output');
  }
}

async function observed(root: string, file: OutputFile): Promise<boolean> {
  await checkParents(root, file.path);
  const target = path.join(root, file.path);
  const stat = await statOrNull(target);
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || byteHash(await fs.readFile(target)) !== file.hash
    || (process.platform !== 'win32' && ((stat.mode & 0o111) !== 0) !== file.executable)) {
    throw new ManagedActivationError('activation_output_changed');
  }
  return true;
}

export async function verifyOutputs(root: string, generation: PreparedGeneration): Promise<void> {
  const allowedFiles = new Set(generation.files.map((file) => file.path));
  const allowedDirectories = new Set<string>();
  for (const file of generation.files) {
    let dir = path.posix.dirname(file.path);
    while (dir !== '.') { allowedDirectories.add(dir); dir = path.posix.dirname(dir); }
  }
  const walk = async (dir: string, relative = '') => {
    await checkDirectory(dir);
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory() && allowedDirectories.has(child)) await walk(path.join(dir, entry.name), child);
      else if (!entry.isFile() || !allowedFiles.has(child)) throw new ManagedActivationError('activation_foreign_output');
    }
  };
  await walk(root);
  for (const file of generation.files) if (!await observed(root, file)) throw new ManagedActivationError('activation_output_changed');
}

/**
 * Intent is already durable. A partially written private generation may resume only with exact
 * already-written bytes. Published generations are verified and never overwritten or deleted.
 */
export async function stageOutputs(parent: string, generation: PreparedGeneration, bytes: OutputBytes[],
  afterFile?: () => Promise<void>, beforeWrite?: (root: string) => Promise<void>): Promise<string> {
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await checkDirectory(parent);
  const published = path.join(parent, generation.id);
  if (await statOrNull(published)) { await verifyOutputs(published, generation); return published; }
  // Each interrupted attempt stays inert. Recovery builds a fresh complete generation;
  // no partial file must be trusted, overwritten or deleted to recover after a crash.
  const staging = await fs.mkdtemp(path.join(parent, `.staging-${generation.id}-`));
  for (const file of bytes) {
    await beforeWrite?.(staging);
    await checkParents(staging, file.path);
    await fs.mkdir(path.dirname(path.join(staging, file.path)), { recursive: true, mode: 0o700 });
    await checkParents(staging, file.path);
    const handle = await fs.open(path.join(staging, file.path), 'wx', file.executable ? 0o500 : 0o400);
    try { await handle.writeFile(file.bytes); await handle.sync(); }
    finally { await handle.close(); }
    await afterFile?.();
  }
  await verifyOutputs(staging, generation);
  // A destination that appeared meanwhile is foreign; never replace it.
  if (await statOrNull(published)) throw new ManagedActivationError('activation_foreign_output');
  await fs.rename(staging, published);
  await verifyOutputs(published, generation);
  return published;
}
