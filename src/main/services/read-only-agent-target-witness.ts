/** A synchronous last-await fence for the exact admitted durable agent and project. No recovery or writes. */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { AgentConfigTarget } from './agent-config-reader';
import type { DurableAgentConfig } from '../../shared/types';
import { getBaseDirPath } from './base-dir';

const MAX_INVENTORY_BYTES = 4 * 1024 * 1024;
type RecordValue = Record<string, unknown>;
const record = (v: unknown): v is RecordValue => !!v && typeof v === 'object' && !Array.isArray(v);

function inventory(root: string, relative: string): { value: unknown; signature: string } {
  const anchor = fs.realpathSync(root);
  const chain = new Map<string, fs.BigIntStats>([[anchor, fs.lstatSync(anchor, { bigint: true })]]);
  let file = anchor;
  for (const part of relative.split('/')) {
    if (!part || part === '.' || part === '..') throw new Error('Invalid inventory path.');
    file = path.join(file, part);
    const stat = fs.lstatSync(file, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error('Linked inventory is not an identity witness.');
    chain.set(file, stat);
  }
  const leaf = chain.get(file)!;
  if (!leaf.isFile() || leaf.size > BigInt(MAX_INVENTORY_BYTES)) throw new Error('Inventory witness unavailable.');
  const same = (a: fs.BigIntStats, b: fs.BigIntStats) => a.dev === b.dev && a.ino === b.ino;
  const verify = () => {
    for (const [member, original] of chain) {
      const current = fs.lstatSync(member, { bigint: true });
      const relative = path.relative(anchor, fs.realpathSync(member));
      if (current.isSymbolicLink() || !same(original, current) || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('Inventory path changed.');
    }
  };
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || !same(leaf, before) || before.size > BigInt(MAX_INVENTORY_BYTES)) throw new Error('Inventory changed while opening.');
    verify();
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < bytes.length) { const n = fs.readSync(fd, bytes, size, bytes.length - size, size); if (!n) break; size += n; }
    const after = fs.fstatSync(fd, { bigint: true });
    verify();
    if (size > MAX_INVENTORY_BYTES || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('Inventory changed while reading.');
    const digest = createHash('sha256').update(bytes.subarray(0, size)).digest('hex');
    const identity = [...chain.values()].map((stat) => `${stat.dev}:${stat.ino}`).join('/');
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))), signature: `${identity}:${after.size}:${after.mtimeNs}:${after.ctimeNs}:${digest}` };
  } finally { fs.closeSync(fd); }
}

/** Bind the complete primary list actually read, including disposed/empty membership. */
export function captureReadOnlyAgentInventoryWitness(projectPath: string, expected: readonly DurableAgentConfig[]): { current(): boolean } {
  const read = () => {
    try {
      const agents = inventory(projectPath, '.clubhouse/agents.json');
      if (!Array.isArray(agents.value) || JSON.stringify(agents.value) !== JSON.stringify(expected)) throw new Error('Helper inventory changed.');
      return agents.signature;
    } catch (error) {
      if (expected.length || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Strict peeks treat a readable project with neither primary nor backup as
      // verified empty. Pin that absence; later creation must invalidate it.
      const root = fs.realpathSync(projectPath);
      const project = fs.lstatSync(root, { bigint: true });
      if (!project.isDirectory()) throw new Error('Project unavailable.');
      const folder = path.join(root, '.clubhouse');
      let identity = `${project.dev}:${project.ino}:no-config-folder`;
      try {
        const config = fs.lstatSync(folder, { bigint: true });
        if (!config.isDirectory() || config.isSymbolicLink()) throw new Error('Unsafe config folder.');
        identity = `${project.dev}:${project.ino}:${config.dev}:${config.ino}`;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      for (const name of ['agents.json', 'agents.json.bak']) {
        try { fs.lstatSync(path.join(folder, name)); throw new Error('Agent inventory is present.'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      return `${identity}:empty`;
    }
  };
  const admitted = read();
  return { current: () => { try { return read() === admitted; } catch { return false; } } };
}

function registeredProject(project: AgentConfigTarget['project']): string {
    const projects = inventory(getBaseDirPath(), 'projects.json');
    const rows = Array.isArray(projects.value) ? projects.value : record(projects.value) && projects.value.version === 1 ? projects.value.projects : null;
    if (!Array.isArray(rows) || !rows.every((p) => record(p) && typeof p.id === 'string' && typeof p.path === 'string')
      || new Set(rows.map((p) => p.id)).size !== rows.length
      || rows.filter((p) => p.id === project.id && p.path === project.path).length !== 1) throw new Error('Admitted project is no longer registered.');
    return projects.signature;
}

/** Quick runs have a retained run identity, not a fabricated durable agents.json row. */
export function captureReadOnlyProjectWitness(project: AgentConfigTarget['project']): { current(): boolean } {
  const admitted = registeredProject(project);
  return { current: () => { try { return registeredProject(project) === admitted; } catch { return false; } } };
}

/** The target was strictly resolved already; bind that exact snapshot, never a subsequent name match. */
export function captureReadOnlyAgentTargetWitness(target: AgentConfigTarget): { current(): boolean } {
  const read = () => {
    const project = registeredProject(target.project);
    const agents = inventory(target.project.path, '.clubhouse/agents.json');
    if (!Array.isArray(agents.value) || !agents.value.every((a) => record(a) && typeof a.id === 'string' && typeof a.name === 'string')
      || new Set(agents.value.map((a) => a.id)).size !== agents.value.length) throw new Error('Agent inventory is unreadable.');
    const selected = agents.value.filter((a) => a.id === target.agent.id);
    if (selected.length !== 1 || selected[0].disposedAt || JSON.stringify(selected[0]) !== JSON.stringify(target.agent)) throw new Error('Admitted agent identity changed.');
    return project + '\0' + agents.signature;
  };
  const admitted = read();
  return { current: () => { try { return read() === admitted; } catch { return false; } } };
}
