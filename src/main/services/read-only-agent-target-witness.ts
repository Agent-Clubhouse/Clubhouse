/** A synchronous last-await fence for the exact admitted durable agent and project. No recovery or writes. */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { AgentConfigTarget } from './agent-config-reader';
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

/** The target was strictly resolved already; bind that exact snapshot, never a subsequent name match. */
export function captureReadOnlyAgentTargetWitness(target: AgentConfigTarget): { current(): boolean } {
  const read = () => {
    const projects = inventory(getBaseDirPath(), 'projects.json');
    const rows = Array.isArray(projects.value) ? projects.value : record(projects.value) && projects.value.version === 1 ? projects.value.projects : null;
    if (!Array.isArray(rows) || !rows.every((p) => record(p) && typeof p.id === 'string' && typeof p.path === 'string')
      || new Set(rows.map((p) => p.id)).size !== rows.length
      || rows.filter((p) => p.id === target.project.id && p.path === target.project.path).length !== 1) throw new Error('Admitted project is no longer registered.');
    const agents = inventory(target.project.path, '.clubhouse/agents.json');
    if (!Array.isArray(agents.value) || !agents.value.every((a) => record(a) && typeof a.id === 'string' && typeof a.name === 'string')
      || new Set(agents.value.map((a) => a.id)).size !== agents.value.length) throw new Error('Agent inventory is unreadable.');
    const selected = agents.value.filter((a) => a.id === target.agent.id);
    if (selected.length !== 1 || selected[0].disposedAt || JSON.stringify(selected[0]) !== JSON.stringify(target.agent)) throw new Error('Admitted agent identity changed.');
    return projects.signature + '\0' + agents.signature;
  };
  const admitted = read();
  return { current: () => { try { return read() === admitted; } catch { return false; } } };
}
