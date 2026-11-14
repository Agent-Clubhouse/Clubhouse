/** Person-owned project display links shared by Annex Network computers (#3479). */
export interface NetworkProjectRef { machine: string; projectId: string }
export interface ProjectLinkRecord {
  projects: [NetworkProjectRef, NetworkProjectRef];
  linked: boolean;
  /** A monotonic millisecond clock. Legacy choices have zero, below every new edit. */
  at: number;
  by: string;
}
export type ProjectLinksOp = { type: 'link' | 'keepSeparate'; a: string; b: string }
  | { type: 'unlink' | 'split'; a: string };
export interface ProjectLinksView { revision: number; links: string[][]; keptSeparate: string[] }
export const PROJECT_LINKS_CAPABILITIES_PATH = '/api/v1/network/project-links-capabilities';
export const PROJECT_LINKS_SYNC_PATH = '/api/v1/network/project-links';
export const PROJECT_LINKS_PAGE_SIZE = 200;
export const PROJECT_LINKS_MAX_RECORDS = 200_000;
const FP = /^[0-9a-f]{2}(?::[0-9a-f]{2}){15,31}$/i;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && ![...v].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export const projectRefKey = (ref: NetworkProjectRef): string => JSON.stringify([ref.machine, ref.projectId]);
export const projectLinkPairKey = (a: NetworkProjectRef, b: NetworkProjectRef): string => JSON.stringify([projectRefKey(a), projectRefKey(b)].sort(compare));
function ref(raw: unknown): NetworkProjectRef {
  if (!object(raw) || Object.keys(raw).some((k) => k !== 'machine' && k !== 'projectId')
    || typeof raw.machine !== 'string' || !FP.test(raw.machine) || !text(raw.projectId)) throw new Error('Invalid project reference.');
  return { machine: raw.machine.toLowerCase(), projectId: raw.projectId };
}
export function sidebarProjectRef(id: string, self: string): NetworkProjectRef {
  if (!id.startsWith('remote||')) return ref({ machine: self, projectId: id });
  const end = id.indexOf('||', 'remote||'.length);
  if (end < 0) throw new Error('Invalid remote project reference.');
  return ref({ machine: id.slice('remote||'.length, end), projectId: id.slice(end + 2) });
}
export const sidebarProjectId = (p: NetworkProjectRef, self: string): string => p.machine === self ? p.projectId : `remote||${p.machine}||${p.projectId}`;
export function parseProjectLinkRecords(raw: unknown, max = PROJECT_LINKS_MAX_RECORDS): ProjectLinkRecord[] {
  if (!Array.isArray(raw) || raw.length > max) throw new Error('Too many project link records.');
  return raw.map((r) => {
    if (!object(r) || Object.keys(r).some((k) => !['projects', 'linked', 'at', 'by'].includes(k))
      || !Array.isArray(r.projects) || r.projects.length !== 2 || typeof r.linked !== 'boolean'
      || !Number.isSafeInteger(r.at) || (r.at as number) < 0 || (r.at as number) >= Number.MAX_SAFE_INTEGER
      || typeof r.by !== 'string' || !FP.test(r.by)) throw new Error('Invalid project link record.');
    const projects = r.projects.map(ref).sort((a, b) => compare(projectRefKey(a), projectRefKey(b))) as [NetworkProjectRef, NetworkProjectRef];
    if (projectRefKey(projects[0]) === projectRefKey(projects[1])) throw new Error('A project cannot link to itself.');
    return { projects, linked: r.linked, at: r.at as number, by: r.by.toLowerCase() };
  });
}
/** Bound received clocks without invalidating saved records if the local clock later moves back. */
export function parseIncomingProjectLinkRecords(raw: unknown, max = PROJECT_LINKS_MAX_RECORDS, now = Date.now()): ProjectLinkRecord[] {
  const records = parseProjectLinkRecords(raw, max);
  // One skewed writer cannot block the good records that share its page.
  return records.filter((r) => r.at <= now + 24 * 60 * 60 * 1000);
}
/** IPC preserves messages but strips custom Error properties. Retry only these known temporary failures. */
export function transientProjectLinksError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Annex identity is not ready for project links.')
    || /\b(?:EAGAIN|EBUSY|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENOTCONN|ENETDOWN)\b/.test(message)
    || message === 'Network request failed' || message === 'Failed to fetch';
}
/** Latest per pair. An equal-clock separation wins, including conflicting untimed legacy choices. */
export function compareProjectLinkChanges(a: ProjectLinkRecord, b: ProjectLinkRecord): number {
  return a.at - b.at || Number(b.linked) - Number(a.linked) || compare(a.by, b.by);
}
export function mergeProjectLinkRecords(current: ProjectLinkRecord[], incoming: readonly ProjectLinkRecord[]): ProjectLinkRecord[] {
  const pairs = new Map(current.map((r) => [projectLinkPairKey(...r.projects), r]));
  let changed = false;
  for (const r of incoming) {
    const key = projectLinkPairKey(...r.projects), previous = pairs.get(key);
    if (!previous || compareProjectLinkChanges(r, previous) > 0) { pairs.set(key, r); changed = true; }
  }
  if (!changed) return current;
  // Tombstones intentionally have no GC yet. Deleting them without network-wide
  // acknowledgement would let an offline replica resurrect an old link. The
  // record cap refuses further growth instead of silently dropping history.
  if (pairs.size > PROJECT_LINKS_MAX_RECORDS) throw new Error('Too many project link records.');
  return [...pairs.entries()].sort(([a], [b]) => compare(a, b)).map(([, r]) => r);
}
/**
 * Disjoint display groups. Concurrent overlapping merges must never reunite a
 * pair explicitly kept separate; newer positive edges are considered first.
 * A later explicit Link merges whole groups and replaces their separating pairs.
 */
export function projectLinkGroups(records: readonly ProjectLinkRecord[]): NetworkProjectRef[][] {
  const groups = new Map<string, Map<string, NetworkProjectRef>>();
  const owner = new Map<string, string>();
  const separate = new Set(records.filter((r) => !r.linked).map((r) => projectLinkPairKey(...r.projects)));
  const positives = records.filter((r) => r.linked).sort((a, b) => compareProjectLinkChanges(b, a) || compare(projectLinkPairKey(...a.projects), projectLinkPairKey(...b.projects)));
  for (const { projects: [a, b] } of positives) {
    for (const p of [a, b]) {
      const key = projectRefKey(p);
      if (!owner.has(key)) { owner.set(key, key); groups.set(key, new Map([[key, p]])); }
    }
    const ak = owner.get(projectRefKey(a))!, bk = owner.get(projectRefKey(b))!;
    if (ak === bk) continue;
    const ga = groups.get(ak)!, gb = groups.get(bk)!;
    if ([...ga.values()].some((x) => [...gb.values()].some((y) => separate.has(projectLinkPairKey(x, y))))) continue;
    for (const [key, p] of gb) { ga.set(key, p); owner.set(key, ak); }
    groups.delete(bk);
  }
  return [...groups.values()].filter((g) => g.size > 1).map((g) => [...g.values()].sort((a, b) => compare(projectRefKey(a), projectRefKey(b))))
    .sort((a, b) => compare(projectRefKey(a[0]), projectRefKey(b[0])));
}
export function projectLinksView(records: readonly ProjectLinkRecord[], self: string, revision: number): ProjectLinksView {
  return {
    revision,
    links: projectLinkGroups(records).map((g) => g.map((p) => sidebarProjectId(p, self))),
    keptSeparate: records.filter((r) => !r.linked).map((r) => r.projects.map((p) => sidebarProjectId(p, self)).sort(compare).join('\n')).sort(compare),
  };
}
export function parseProjectLinksOp(raw: unknown): ProjectLinksOp {
  if (!object(raw) || !['link', 'keepSeparate', 'unlink', 'split'].includes(raw.type as string)
    || Object.keys(raw).some((k) => !['type', 'a', 'b'].includes(k)) || !text(raw.a)
    || (['link', 'keepSeparate'].includes(raw.type as string) ? !text(raw.b) : raw.b !== undefined)) throw new Error('Invalid project link change.');
  return raw as unknown as ProjectLinksOp;
}
export function applyProjectLinksOp(records: ProjectLinkRecord[], op: ProjectLinksOp, self: string, now: number): ProjectLinkRecord[] {
  const a = sidebarProjectRef(op.a, self), groups = projectLinkGroups(records);
  const groupOf = (p: NetworkProjectRef) => groups.find((g) => g.some((x) => projectRefKey(x) === projectRefKey(p))) ?? [p];
  let pairs: Array<[NetworkProjectRef, NetworkProjectRef]> = [];
  const linked = op.type === 'link';
  if ('b' in op) {
    const b = sidebarProjectRef(op.b, self);
    if (projectRefKey(a) === projectRefKey(b)) return records;
    if (linked) {
      const ga = groupOf(a), gb = groupOf(b);
      if (ga === gb) return records;
      pairs = ga.flatMap((x) => gb.map((y): [NetworkProjectRef, NetworkProjectRef] => [x, y]));
    } else pairs = [[a, b]];
  } else {
    const group = groupOf(a);
    pairs = op.type === 'unlink' ? group.filter((p) => projectRefKey(p) !== projectRefKey(a)).map((p) => [a, p])
      : group.flatMap((p, i) => group.slice(i + 1).map((q): [NetworkProjectRef, NetworkProjectRef] => [p, q]));
  }
  const at = records.reduce((clock, r) => Math.max(clock, r.at + 1), Math.max(1, now));
  if (!Number.isSafeInteger(at) || at >= Number.MAX_SAFE_INTEGER) throw new Error('Project link clock is out of range.');
  const changes = parseProjectLinkRecords(pairs.map((projects) => ({ projects, linked, at, by: self })));
  return mergeProjectLinkRecords(records, changes);
}
/** Import without assigning a fresh timestamp to an old choice, preserving later network edits. */
export function legacyProjectLinkRecords(raw: unknown, self: string): ProjectLinkRecord[] {
  if (!object(raw)) return [];
  const incoming: ProjectLinkRecord[] = [];
  const add = (a: string, b: string, linked: boolean) => {
    if (incoming.length >= PROJECT_LINKS_MAX_RECORDS) throw new Error('Too many legacy project links.');
    try { incoming.push(...parseProjectLinkRecords([{ projects: [sidebarProjectRef(a, self), sidebarProjectRef(b, self)], linked, at: 0, by: self }])); }
    catch { /* telemetry-exempt: a malformed legacy reference cannot become a shared link */ }
  };
  if (Array.isArray(raw.links) && raw.links.length > 200) throw new Error('Too many legacy project groups.');
  if (Array.isArray(raw.links)) for (const group of raw.links) {
    if (!Array.isArray(group) || group.length > 200) continue;
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      if (typeof group[i] === 'string' && typeof group[j] === 'string') add(group[i], group[j], true);
    }
  }
  if (Array.isArray(raw.keptSeparate)) for (const key of raw.keptSeparate) {
    if (typeof key !== 'string') continue;
    const pair = key.split('\n');
    if (pair.length === 2) add(pair[0], pair[1], false);
  }
  return mergeProjectLinkRecords([], incoming);
}
