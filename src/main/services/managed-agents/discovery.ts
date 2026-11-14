/**
 * Native assets in one registered agent's provider folder. This is discovery,
 * not effective-provider inventory or evidence that a session loaded anything.
 * Callers resolve the registered worktree; no caller-supplied path is admitted.
 */
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { OrchestratorConventions } from '../../orchestrators/types';
import type { ManagedMcpContent, ManagedSkillContent } from '../../../shared/managed-agents-types';
import { isSafeSkillPathSegment, MAX_SKILL_PATH_CHARS } from '../../../shared/skill-paths';
import { MAX_LISTED_SKILLS, skillsFolderOf } from '../../../shared/skills-folder';
import { redactSecretValues } from '../../telemetry/diag-redaction';
import { canonicalHash } from '../asset-catalog/planner';
import { adoptNativeMcpServer, MAX_SKILL_BUNDLE_BYTES, MAX_SKILL_FILE_BYTES, MAX_SKILL_FILES, validatePayload } from '../asset-catalog/validation';
import { envAsNames } from './agents';
import { ManagedError } from './service';

const MAX_MCP_BYTES = 1024 * 1024;
const MAX_ENTRIES = 1000;
const MAX_DEPTH = 16;

export interface DiscoveredManagedAsset {
  id: string;
  kind: 'skill' | 'mcp';
  nativeName: string;
  evidence: 'discovered';
}

export interface ManagedAssetDiscovery {
  candidates: DiscoveredManagedAsset[];
  notes: string[];
  scope: 'agent_provider_folder';
  providerLoaded: 'not_confirmed';
}

export interface NativeAssetSource {
  root: string;
  conventions: OrchestratorConventions;
}

export interface NativeAssetRead {
  candidate: DiscoveredManagedAsset;
  content: ManagedSkillContent | ManagedMcpContent;
  fingerprint: string;
  droppedEnvValues: string[];
}

export class SourceError extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function safeName(name: string): boolean {
  return isSafeSkillPathSegment(name) && name.length <= 120 && redactSecretValues(name) === name;
}

export function missing(error: unknown): boolean {
  return record(error) && error.code === 'ENOENT';
}

/** Recheck every component below the registered anchor, including the anchor itself. */
export async function sourcePath(root: string, relative: string): Promise<string> {
  const segments = relative.split('/');
  if (!segments.every(isSafeSkillPathSegment)) throw new SourceError('The provider source path is not a safe relative path.');
  let current = path.resolve(root);
  if (!(await fs.lstat(current)).isDirectory()) throw new SourceError('The registered source folder must be a directory, not a link.');
  const anchor = await fs.realpath(current);
  for (const segment of segments) {
    current = path.join(current, segment);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new SourceError('A source path contains a symbolic link; it was not followed.');
    const resolved = await fs.realpath(current);
    const rel = path.relative(anchor, resolved);
    if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) throw new SourceError('A source path leaves the registered folder.');
  }
  return current;
}

export async function readFile(root: string, relative: string, limit: number): Promise<{ bytes: Buffer; executable: boolean }> {
  const full = await sourcePath(root, relative);
  const file = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new SourceError('A source member is not an ordinary file.');
    if (before.nlink !== 1) throw new SourceError('A source member has multiple hard links; the complete import was refused.');
    if (before.size > limit) throw new SourceError('The source exceeds the import size limit.');
    const bytes = Buffer.alloc(Math.min(before.size + 1, limit + 1));
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await file.stat();
    await sourcePath(root, relative);
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new SourceError('The source changed while it was read. Preview it again.');
    }
    return { bytes: bytes.subarray(0, length), executable: process.platform !== 'win32' && (before.mode & 0o111) !== 0 };
  } finally {
    await file.close();
  }
}

export async function entries(root: string, relative: string, limit: number): Promise<{ names: string[]; truncated: boolean }> {
  const dir = await fs.opendir(await sourcePath(root, relative));
  const names: string[] = [];
  let truncated = false;
  for await (const entry of dir) {
    if (names.length === limit) { truncated = true; break; }
    names.push(entry.name);
  }
  await sourcePath(root, relative);
  return { names: names.sort(), truncated };
}

function candidate(kind: 'skill' | 'mcp', nativeName: string): DiscoveredManagedAsset {
  return { id: canonicalHash({ kind, nativeName }), kind, nativeName, evidence: 'discovered' };
}

export function sourceProblem(error: unknown): string {
  return error instanceof SourceError ? error.message : 'The source could not be read. Check access and preview again.';
}

/** JSON.parse alone silently takes the last duplicate server/environment field. */
export function refuseDuplicateKeys(json: string): void {
  const stack: Array<{ object: boolean; keyNext: boolean; keys: Set<string> }> = [];
  for (const token of json.match(/"(?:\\.|[^"\\])*"|[{}[\]:,]|[^{}[\]:,\s]+/g) ?? []) {
    if (token === '{' || token === '[') {
      if (stack.length >= MAX_DEPTH) throw new SourceError('The MCP configuration exceeds the nesting limit.');
      stack.push({ object: token === '{', keyNext: true, keys: new Set() });
    } else if (token === '}' || token === ']') stack.pop();
    else {
      const current = stack[stack.length - 1];
      if (token === ',' && current?.object) current.keyNext = true;
      else if (token.startsWith('"') && current?.object && current.keyNext) {
        const key: string = JSON.parse(token);
        if (current.keys.has(key)) throw new SourceError('The MCP configuration has duplicate fields. Resolve ambiguous definitions before importing.');
        current.keys.add(key);
        current.keyNext = false;
      }
    }
  }
}

async function mcpDefinitions(source: NativeAssetSource): Promise<{ servers: Record<string, unknown>; fingerprint: string }> {
  return readMcpServers(source.root, source.conventions.mcpConfigFile);
}

/** The `mcpServers` object of a JSON file below `root`, read within limits, with duplicate fields refused. */
export async function readMcpServers(root: string, relative: string): Promise<{ servers: Record<string, unknown>; fingerprint: string }> {
  const { bytes } = await readFile(root, relative, MAX_MCP_BYTES);
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch {
    throw new SourceError('The local MCP configuration is not valid JSON; no values were returned.');
  }
  refuseDuplicateKeys(bytes.toString('utf8'));
  if (!record(parsed) || !record(parsed.mcpServers)) throw new SourceError('The local MCP configuration must contain an mcpServers object.');
  if (Object.keys(parsed.mcpServers).length > MAX_LISTED_SKILLS) throw new SourceError('The local MCP configuration exceeds the server limit.');
  return { servers: parsed.mcpServers, fingerprint: canonicalHash(bytes.toString('base64')) };
}

export async function discoverManagedAssets(source: NativeAssetSource): Promise<ManagedAssetDiscovery> {
  const out: ManagedAssetDiscovery = {
    candidates: [], notes: ['Only this agent\'s provider folder was inspected. Inherited, global and other-provider assets were not inspected; this is not effective configuration or proof of loading.'],
    scope: 'agent_provider_folder', providerLoaded: 'not_confirmed',
  };
  const skills = skillsFolderOf(source.conventions);
  try {
    const found = await entries(source.root, skills, MAX_LISTED_SKILLS);
    if (found.truncated) out.notes.push('The skill folder list was truncated. Narrow the source folder before importing missing skills.');
    for (const name of found.names) {
      if (name.startsWith('.')) continue;
      if (!safeName(name)) { out.notes.push('A skill folder with an unsafe name was not inspected.'); continue; }
      try {
        const entry = await sourcePath(source.root, `${skills}/${name}/SKILL.md`);
        if (!(await fs.lstat(entry)).isFile()) throw new SourceError('SKILL.md is not an ordinary file.');
        out.candidates.push(candidate('skill', name));
      } catch (error) {
        // telemetry-exempt: safe, content-free diagnostics are returned in this discovery result.
        if (!missing(error)) out.notes.push(`A skill candidate was not inspected: ${sourceProblem(error)}`);
      }
    }
  } catch (error) {
    // telemetry-exempt: missing roots are ordinary; other failures are returned as safe notes.
    if (!missing(error)) out.notes.push(`Skills were not inspected: ${sourceProblem(error)}`);
  }
  if (source.conventions.settingsFormat && source.conventions.settingsFormat !== 'json') {
    out.notes.push('Local MCP discovery does not support this provider\'s non-JSON format. The file was preserved.');
    return out;
  }
  try {
    const { servers } = await mcpDefinitions(source);
    for (const name of Object.keys(servers).sort()) {
      if (/^clubhouse(?:[-_.].*)?$/i.test(name)) continue;
      if (!safeName(name)) { out.notes.push('An MCP server with an unsafe name was not listed.'); continue; }
      out.candidates.push(candidate('mcp', name));
    }
  } catch (error) {
    // telemetry-exempt: safe diagnostics, never the parser's raw input or a filesystem path, reach the caller.
    if (!missing(error)) out.notes.push(`MCP servers were not inspected: ${sourceProblem(error)}`);
  }
  return out;
}

/** Read the complete selected bundle, or refuse it whole. No script or server is run. */
export async function readDiscoveredManagedAsset(source: NativeAssetSource, id: string): Promise<NativeAssetRead> {
  const selected = (await discoverManagedAssets(source)).candidates.find((c) => c.id === id);
  if (!selected) throw new ManagedError('not_found', 'The candidate is no longer discoverable in this agent\'s provider folder. Discover again.');
  try {
    const anchor = await fs.stat(await fs.realpath(source.root));
    const identity = { root: await fs.realpath(source.root), dev: anchor.dev, ino: anchor.ino, conventions: source.conventions };
    if (selected.kind === 'mcp') {
      const { servers, fingerprint } = await mcpDefinitions(source);
      const { content, droppedEnvValues } = mcpServerContent(selected.nativeName, servers[selected.nativeName]);
      return { candidate: selected, content, fingerprint: canonicalHash({ identity, fingerprint }), droppedEnvValues };
    }
    const content = await readSkillBundle(source.root, `${skillsFolderOf(source.conventions)}/${selected.nativeName}`, selected.nativeName);
    return { candidate: selected, content, fingerprint: canonicalHash({ identity, content }), droppedEnvValues: [] };
  } catch (error) {
    throw new ManagedError('invalid', sourceProblem(error));
  }
}

/**
 * One server from an `mcpServers` object as MCP part content: literal env
 * values become names, and credentials or unsupported fields refuse it. Nothing is run.
 */
export function mcpServerContent(name: string, raw: unknown): { content: ManagedMcpContent; droppedEnvValues: string[] } {
  if (!record(raw) || (raw.env !== undefined && (!record(raw.env) || !Object.values(raw.env).every((v) => typeof v === 'string')))
    || (raw.env_vars !== undefined && (!Array.isArray(raw.env_vars) || !raw.env_vars.every((v) => typeof v === 'string')))) {
    throw new SourceError('The server has invalid environment fields; no values were returned.');
  }
  const { def, dropped } = envAsNames(raw);
  const adopted = adoptNativeMcpServer(name, def);
  if (!adopted.ok) throw new SourceError('The server contains unsupported fields, credentials or invalid configuration. Move credentials to the external environment and review its definition.');
  const { env: _values, ...payload } = adopted.payload;
  return { content: { kind: 'mcp', ...payload }, droppedEnvValues: dropped };
}

/** The complete skill bundle at `base` below `root`, or a refusal of the whole bundle. Nothing is run. */
export async function readSkillBundle(root: string, base: string, skillName: string): Promise<ManagedSkillContent> {
  const files: ManagedSkillContent['files'] = [];
  let count = 0, bytes = 0;
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) throw new SourceError('The skill exceeds the directory depth limit.');
    const folder = relative ? `${base}/${relative}` : base;
    const found = await entries(root, folder, MAX_ENTRIES);
    if (found.truncated) throw new SourceError('The skill exceeds the directory entry limit.');
    for (const name of found.names) {
      if (++count > MAX_ENTRIES) throw new SourceError('The skill exceeds the directory entry limit.');
      const member = relative ? `${relative}/${name}` : name;
      if (member.length > MAX_SKILL_PATH_CHARS || !safeName(name)) throw new SourceError('The skill contains an unsafe path; the complete bundle was refused.');
      const stat = await fs.lstat(await sourcePath(root, `${base}/${member}`));
      if (stat.isDirectory()) { await walk(member, depth + 1); continue; }
      if (!stat.isFile()) throw new SourceError('The skill contains a link or non-file member; the complete bundle was refused.');
      if (files.length >= MAX_SKILL_FILES) throw new SourceError('The skill exceeds the file limit.');
      const read = await readFile(root, `${base}/${member}`, Math.min(MAX_SKILL_FILE_BYTES, MAX_SKILL_BUNDLE_BYTES - bytes));
      bytes += read.bytes.length;
      const inspected = read.bytes.toString('utf8');
      if (redactSecretValues(inspected) !== inspected) throw new SourceError('The complete skill bundle contains credentials; nothing was imported.');
      const text = !read.bytes.includes(0) && Buffer.from(read.bytes.toString('utf8')).equals(read.bytes);
      files.push({ path: member, content: read.bytes.toString(text ? 'utf8' : 'base64'), ...(!text && { encoding: 'base64' as const }), ...(read.executable && { executable: true }) });
    }
  };
  await walk('', 0);
  const checked = validatePayload('skill', { skillName, files });
  if (!checked.ok) throw new SourceError('The complete skill bundle contains credentials, unsupported launch settings or invalid files; nothing was imported.');
  return { kind: 'skill', ...checked.payload };
}
