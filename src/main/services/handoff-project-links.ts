import { sharedHandoffProjectsLinked } from './project-links-store';
import { createSettingsStore, type SettingsStore } from './settings-store';
import { currentSettingsOrigin, auditChanged } from './settings-audit';
function parse(raw: unknown): string[][] {
  if (!Array.isArray(raw) || raw.length > 200 || Buffer.byteLength(JSON.stringify(raw)) > 128 * 1024) throw new Error('Invalid linked projects.');
  const seen = new Set<string>();
  for (const group of raw) {
    if (!Array.isArray(group) || group.length < 2 || group.length > 200) throw new Error('Invalid linked projects.');
    for (const id of group) {
      if (typeof id !== 'string' || !id || id.length > 512 || [...id].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || seen.has(id)) throw new Error('Invalid linked projects.');
      seen.add(id);
    }
  }
  if (seen.size > 2000) throw new Error('Too many linked projects.');
  return structuredClone(raw);
}
let disk: SettingsStore<{ groups: string[][] }> | undefined;
let committed: string[][] | undefined;
let unreadable = false;
let unavailable = false;
let pending: Promise<unknown> = Promise.resolve();
function store() {
  return disk ??= createSettingsStore<{ groups: string[][] }>('handoff-project-links.json', { groups: [] }, (value) => ({ groups: parse(value.groups) }), {
    atomic: true, mode: 0o600, rollBackFailedSaves: true,
    onLoad: (result) => {
      if ('error' in result) unreadable = (result.error as NodeJS.ErrnoException)?.code !== 'ENOENT';
      else { try { parse(JSON.parse(result.raw).groups); } catch { unreadable = true; /* telemetry-exempt: corrupt routing hints never choose a project */ } }
    },
  });
}
export function handoffProjectsLinked(localProject: string, sourceMachine: string, sourceProject: string, localSource = false): boolean {
  try {
    const shared = sharedHandoffProjectsLinked(localProject, sourceMachine, sourceProject, localSource);
    if (shared !== undefined) return shared;
  } catch { return false; /* telemetry-exempt: unreadable shared routing fails closed */ }
  if (unavailable) return false;
  if (!committed) { const value = store().get(); if (unreadable) return false; committed = parse(value.groups); }
  const remote = `remote||${sourceMachine}||${sourceProject}`;
  return committed.some((group) => group.includes(localProject) && (group.includes(remote) || localSource && group.includes(sourceProject)));
}
/** Mirrors the person's existing #3066 project groups, never an agent or peer claim. */
export async function setHandoffProjectLinks(raw: unknown): Promise<void> {
  const origin = currentSettingsOrigin();
  if (origin.surface !== 'ui' || origin.actorId) throw new Error('Only the person can link receiving projects.');
  const groups = parse(raw);
  const work = async () => {
    const previous = store().get().groups; if (unreadable) throw new Error('Linked-project routing is unreadable.');
    if (JSON.stringify(committed ?? previous) === JSON.stringify(groups)) { unavailable = false; return; }
    try { await store().save({ groups }); } catch (error) { unavailable = true; throw error; }
    committed = groups; unavailable = false;
    await auditChanged('app', 'handoff.project_links');
  };
  const result = pending.then(work, work); pending = result; return result;
}
export function _resetHandoffProjectLinksForTesting(): void { disk = undefined; committed = undefined; unreadable = false; unavailable = false; pending = Promise.resolve(); }
