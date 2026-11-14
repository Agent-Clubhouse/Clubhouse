/** Read-only, bounded setup evidence. Never scans provider/global configuration or materializes parts. */
import { constants, type BigIntStats } from 'fs';
import type { DurableAgentConfig } from '../../shared/types';
import * as fs from 'fs/promises';
import * as path from 'path';
import { isDisposedAgent } from '../../shared/agent-helpers';
import type { ManagedPartContent } from '../../shared/managed-agents-types';
import { peekDurableConfigs } from './agent-config';
import { getDispatcherState } from './dispatcher/dispatcher-service';
import { peekProjects } from './project-store';
import { resolveOrchestrator } from './agent-system';
import { managedAgents } from './managed-agents';
import { instructionsFileRel, renderManagedInstructions, resolveManagedSetup } from './managed-agents/delivery';

export const CONFIG_MAX_BYTES = 256 * 1024;
export const CONFIG_TEXT_BYTES = 32 * 1024;
export const CONFIG_MAX_PARTS = 100;

function prefix(text: string, max = CONFIG_TEXT_BYTES): string {
  const bytes = Buffer.from(text);
  return bytes.length <= max ? text : new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, max)).replace(/\uFFFD$/, '');
}

/** Bound individual strings and collections as well as the final JSON envelope. */
function bounded(value: unknown): unknown {
  if (typeof value === 'string') return prefix(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(bounded);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, bounded(child)]));
  return value;
}

/** Only the registered provider's instruction file, with no links or non-file reads. */
async function ownInstructions(root: string, relative: string): Promise<{ text: string; truncated: boolean }> {
  const anchor = await fs.realpath(root);
  const verified = new Map<string, BigIntStats>([[anchor, await fs.lstat(anchor, { bigint: true })]]);
  let file = anchor;
  for (const segment of relative.split(/[\\/]/)) {
    if (!segment || segment === '.' || segment === '..') throw new Error('Unsafe instructions path.');
    file = path.join(file, segment);
    const stat = await fs.lstat(file, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error('Instructions links are not read.');
    verified.set(file, stat);
  }
  const expected = verified.get(file)!;
  if (!expected.isFile()) throw new Error('Instructions must be an ordinary file.');
  const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
  const verifyPaths = async () => {
    for (const [member, before] of verified) {
      const current = await fs.lstat(member, { bigint: true });
      const actual = await fs.realpath(member);
      const within = path.relative(anchor, actual);
      if (current.isSymbolicLink() || !same(before, current) || path.isAbsolute(within) || within === '..' || within.startsWith(`..${path.sep}`)) {
        throw new Error('Instructions path changed while reading.');
      }
    }
  };
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || !same(expected, stat)) throw new Error('Instructions file changed while opening.');
    // O_NOFOLLOW covers only the leaf. Pin that leaf's identity and recheck
    // every ancestor after open before any bytes can leave the descriptor.
    await verifyPaths();
    const bytes = Buffer.alloc(CONFIG_TEXT_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const next = await handle.read(bytes, size, bytes.length - size, size);
      if (!next.bytesRead) break;
      size += next.bytesRead;
    }
    await verifyPaths();
    return { text: prefix(bytes.subarray(0, size).toString('utf8')), truncated: size > CONFIG_TEXT_BYTES || stat.size > BigInt(CONFIG_TEXT_BYTES) };
  } finally { await handle.close(); }
}

export interface AgentConfigTarget {
  agent: DurableAgentConfig;
  project: { id: string; path: string; name: string; displayName?: string };
}

/** Resolve exactly one snapshot. Even an id must not bypass an unknown project. */
export async function resolveAgentConfigTarget(reference: string, project?: string): Promise<AgentConfigTarget> {
  const projects = await peekProjects();
  const agents = (await Promise.all(projects.map(async (p) => (await peekDurableConfigs(p.path))
    .filter((agent) => !isDisposedAgent(agent)).map((agent) => ({ agent, project: p }))))).flat();
  const dispatcher = getDispatcherState();
  if (dispatcher.config && dispatcher.path && !agents.some(({ agent }) => agent.id === dispatcher.config!.id)) agents.push({ agent: dispatcher.config, project: { id: 'dispatcher', path: dispatcher.path, name: 'Dispatcher' } });
  const projectMatches = project === undefined ? projects : projects.filter((p) => [p.id, p.path, p.name, p.displayName].some((value) => value?.toLowerCase() === project.toLowerCase()));
  if (project !== undefined && projectMatches.length !== 1) throw new Error('No unique registered project matches that reference.');
  const ids = agents.filter(({ agent }) => agent.id === reference);
  const matches = ids.length ? ids : agents.filter(({ agent, project: p }) => agent.name.toLowerCase() === reference.toLowerCase()
    && (project === undefined || projectMatches[0].path === p.path));
  if (matches.length !== 1) throw new Error(matches.length ? 'Agent name is ambiguous; use its id.' : 'No registered agent matches that reference.');
  return structuredClone(matches[0]);
}

/** Convenience for trusted host callers; agent-facing callers authorize the resolved snapshot first. */
export async function readAgentConfig(reference: string, project?: string) {
  return readResolvedAgentConfig(await resolveAgentConfigTarget(reference, project));
}

/** Read only the same snapshot the caller authorized, without resolving a name or project again. */
export async function readResolvedAgentConfig({ agent, project: p }: AgentConfigTarget) {
  const result = {
    agent: { id: agent.id, name: prefix(agent.name, 200) },
    evidence: agent.managed ? 'desired_setup' : 'instruction_file',
    providerLoaded: 'not_confirmed',
    instructions: { text: '', provenance: agent.managed ? 'managed_parts' : 'custom', truncated: false },
    parts: [] as Array<Record<string, unknown>>,
    missing: [] as string[],
    omittedMissing: 0,
    totalParts: 0,
    omittedParts: 0,
    truncated: false,
    limits: { bytes: CONFIG_MAX_BYTES, textBytes: CONFIG_TEXT_BYTES, parts: CONFIG_MAX_PARTS },
  };
  if (agent.managed) {
    const service = managedAgents();
    const ids = [...agent.managed.blocks, ...agent.managed.skills, ...agent.managed.mcps];
    // Refuse oversized saved setups before resolving their content.
    if (ids.length > CONFIG_MAX_PARTS) throw new Error(`The setup exceeds the ${CONFIG_MAX_PARTS}-part read limit.`);
    const resolved = await resolveManagedSetup(service, agent.managed, agent);
    const instructions = await renderManagedInstructions(p.path, agent, resolved);
    result.instructions.text = prefix(instructions);
    result.instructions.truncated = Buffer.byteLength(instructions) > CONFIG_TEXT_BYTES;
    const parts = [...resolved.blocks, ...resolved.skills, ...resolved.mcps];
    result.totalParts = parts.length;
    result.truncated = parts.length > CONFIG_MAX_PARTS;
    for (const item of parts.slice(0, CONFIG_MAX_PARTS)) {
      const head = await service.headContent(item.id);
      if (!head || head.entry.headRevision !== item.revision) throw new Error('The part changed while reading configuration. Read it again.');
      const content: ManagedPartContent = head.content;
      const limited = bounded(content);
      const part = {
        id: item.id, name: prefix(head.entry.name, 200), kind: content.kind, revision: head.entry.headRevision,
        provenance: { kind: head.entry.source.kind === 'builtin' ? 'built-in' : ['user', 'copy'].includes(head.entry.source.kind) ? 'custom' : 'library', source: bounded(head.entry.source) },
        content: limited, contentTruncated: JSON.stringify(limited) !== JSON.stringify(content),
      };
      result.parts.push(part);
      if (Buffer.byteLength(JSON.stringify(result)) > CONFIG_MAX_BYTES) {
        // Keep the part inventory even when a large bundle's content cannot fit.
        part.content = { kind: content.kind, omitted: 'response_limit' };
        part.contentTruncated = true;
        result.truncated = true;
        if (Buffer.byteLength(JSON.stringify(result)) > CONFIG_MAX_BYTES) { result.parts.pop(); break; }
      }
      if (part.contentTruncated) result.truncated = true;
    }
    result.missing = resolved.missing.slice(0, CONFIG_MAX_PARTS).map((id) => prefix(id, 200));
    result.omittedMissing = resolved.missing.length - result.missing.length;
    result.truncated ||= result.omittedMissing > 0;
  } else if (agent.worktreePath) {
    const provider = await resolveOrchestrator(p.path, agent.orchestrator);
    try { Object.assign(result.instructions, await ownInstructions(agent.worktreePath, instructionsFileRel(provider))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  result.truncated ||= result.instructions.truncated;
  // Missing ids and omission counts are included in the final bound too.
  result.omittedParts = result.totalParts - result.parts.length;
  while (Buffer.byteLength(JSON.stringify(result)) > CONFIG_MAX_BYTES && result.parts.length) {
    result.parts.pop(); result.omittedParts++; result.truncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > CONFIG_MAX_BYTES) throw new Error('Configuration metadata exceeds the read limit.');
  return result;
}
