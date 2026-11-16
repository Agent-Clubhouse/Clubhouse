/**
 * Pin and Mark inactive shared by linked copies of a project across Annex
 * Network computers. Linked copies show one sidebar row, so every computer
 * shows the same pins and inactive marks for them, within normal sync latency.
 *
 * Records are per project reference and field, newest write wins, and a write
 * on a linked project goes to every current copy with one clock. A group's
 * value is the winning record among its copies, so it survives copies joining
 * and leaving. Activity, the idle window, Terminal and Wake stay per machine;
 * only an explicit Mark active is recorded as activity on every copy.
 * Projects that aren't linked keep using each computer's own state.
 */
import {
  isNetworkMachine, parseNetworkProjectRef, projectRefKey, sidebarProjectId, sidebarProjectRef,
  type NetworkProjectRef,
} from './project-links';
import type { ProjectState, ProjectStateOp } from './project-state';

/** `activated`: an explicit Mark active, at that moment; its value is always true. */
export type LinkedProjectField = 'pinned' | 'inactive' | 'activated';
export interface LinkedProjectStateRecord {
  project: NetworkProjectRef;
  field: LinkedProjectField;
  value: boolean;
  /** A monotonic millisecond clock. Values from before sharing have zero, below every explicit edit. */
  at: number;
  by: string;
}
export const LINKED_PROJECT_STATE_CAPABILITIES_PATH = '/api/v1/network/linked-project-state-capabilities';
export const LINKED_PROJECT_STATE_SYNC_PATH = '/api/v1/network/linked-project-state';
export const LINKED_PROJECT_STATE_PAGE_SIZE = 200;
export const LINKED_PROJECT_STATE_MAX_RECORDS = 200_000;
const FIELDS: readonly LinkedProjectField[] = ['pinned', 'inactive', 'activated'];
const DAY_MS = 24 * 60 * 60 * 1000;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export const linkedStateKey = (project: NetworkProjectRef, field: LinkedProjectField): string => JSON.stringify([projectRefKey(project), field]);
export const linkedStateRecordKey = (r: LinkedProjectStateRecord): string => linkedStateKey(r.project, r.field);

/**
 * The one merge rule (maintainer, 2026-11-15), for two writes of the same field;
 * positive when `a` wins. The newest explicit edit wins. Values from before
 * sharing all have clock zero, and fold as pinned if any copy is pinned and
 * inactive only if every copy is; the same preference breaks any other tie,
 * then the writer.
 */
export function compareLinkedStateWrites(a: LinkedProjectStateRecord, b: LinkedProjectStateRecord): number {
  const preferred = (r: LinkedProjectStateRecord) => Number(r.field === 'inactive' ? !r.value : r.value);
  return a.at - b.at || preferred(a) - preferred(b) || compare(a.by, b.by);
}

export function parseLinkedStateRecords(raw: unknown, max = LINKED_PROJECT_STATE_MAX_RECORDS): LinkedProjectStateRecord[] {
  if (!Array.isArray(raw) || raw.length > max) throw new Error('Too many linked project state records.');
  return raw.map((r) => {
    if (!object(r) || Object.keys(r).some((k) => !['project', 'field', 'value', 'at', 'by'].includes(k))
      || !FIELDS.includes(r.field as LinkedProjectField) || typeof r.value !== 'boolean' || (r.field === 'activated' && r.value !== true)
      || !Number.isSafeInteger(r.at) || (r.at as number) < 0 || (r.at as number) >= Number.MAX_SAFE_INTEGER
      || !isNetworkMachine(r.by)) throw new Error('Invalid linked project state record.');
    return { project: parseNetworkProjectRef(r.project), field: r.field as LinkedProjectField, value: r.value, at: r.at as number, by: r.by.toLowerCase() };
  });
}

/** Bound received clocks, as for project links: one skewed writer can't block the good records on its page. */
export function parseIncomingLinkedStateRecords(raw: unknown, max = LINKED_PROJECT_STATE_MAX_RECORDS, now = Date.now()): LinkedProjectStateRecord[] {
  return parseLinkedStateRecords(raw, max).filter((r) => r.at <= now + DAY_MS);
}

/** Newest per reference and field, sorted by key. Returns `current` itself when nothing wins. */
export function mergeLinkedStateRecords(current: LinkedProjectStateRecord[], incoming: readonly LinkedProjectStateRecord[]): LinkedProjectStateRecord[] {
  const byKey = new Map(current.map((r) => [linkedStateRecordKey(r), r]));
  let changed = false;
  for (const r of incoming) {
    const key = linkedStateRecordKey(r), previous = byKey.get(key);
    if (!previous || compareLinkedStateWrites(r, previous) > 0) { byKey.set(key, r); changed = true; }
  }
  if (!changed) return current;
  // No collection, as for project links: an offline replica would bring old values back.
  if (byKey.size > LINKED_PROJECT_STATE_MAX_RECORDS) throw new Error('Too many linked project state records.');
  return [...byKey.entries()].sort(([a], [b]) => compare(a, b)).map(([, r]) => r);
}

export type LinkedStateIndex = ReadonlyMap<string, LinkedProjectStateRecord>;
export const indexLinkedState = (records: readonly LinkedProjectStateRecord[]): LinkedStateIndex => new Map(records.map((r) => [linkedStateRecordKey(r), r]));

/** The winning write of `field` among a group's copies, if any copy has one. */
export function groupLinkedState(index: LinkedStateIndex, group: readonly NetworkProjectRef[], field: LinkedProjectField): LinkedProjectStateRecord | undefined {
  let best: LinkedProjectStateRecord | undefined;
  for (const p of group) {
    const r = index.get(linkedStateKey(p, field));
    if (r && (!best || compareLinkedStateWrites(r, best) > 0)) best = r;
  }
  return best;
}

export const groupOfRef = (groups: readonly NetworkProjectRef[][], ref: NetworkProjectRef): NetworkProjectRef[] | undefined =>
  groups.find((g) => g.some((p) => projectRefKey(p) === projectRefKey(ref)));

/**
 * Whether a group is inactive now: its newest inactive record says so and it
 * isn't pinned. Concurrent edits can leave both set; pinned wins while it
 * lasts, and the newest inactive record applies again once it's unpinned.
 */
export function groupIsInactive(index: LinkedStateIndex, group: readonly NetworkProjectRef[]): boolean | undefined {
  const mark = groupLinkedState(index, group, 'inactive');
  if (!mark) return undefined;
  return mark.value && groupLinkedState(index, group, 'pinned')?.value !== true;
}

/**
 * The records an explicit Pin or Mark inactive writes, or none when it changes
 * nothing. One clock for every copy of the group (just the project when it
 * isn't linked, so an edit made before linking still counts as the newer one).
 * Pinning also clears inactive, so a group is never pinned and inactive
 * by one edit. Marking active a project that was inactive (here, `wasInactive`,
 * or by the group's records) records that moment as activity for every copy;
 * one idle only by time records none. Clocks only go up, so of two edits the
 * later wins whatever their values.
 */
export function linkedStateWrite(
  records: readonly LinkedProjectStateRecord[], groups: readonly NetworkProjectRef[][], op: ProjectStateOp, self: string, now: number,
  wasInactive = false,
): LinkedProjectStateRecord[] {
  if (op.type !== 'setPinned' && op.type !== 'setInactive') return [];
  let target: NetworkProjectRef;
  try { target = sidebarProjectRef(op.projectId, self); } catch { return []; }
  const group = groupOfRef(groups, target) ?? [target];
  const index = indexLinkedState(records);
  const activated = op.type === 'setInactive' && !op.inactive && (wasInactive || groupIsInactive(index, group) === true);
  const changes: Array<[LinkedProjectField, boolean]> = op.type === 'setPinned'
    ? (op.pinned ? [['pinned', true], ['inactive', false]] : [['pinned', false]])
    : (op.inactive ? [['inactive', true]] : [['inactive', false], ...(activated ? [['activated', true] as [LinkedProjectField, boolean]] : [])]);
  // Every copy already has the value: nothing to write, not even the activity.
  const settled = !activated && changes.every(([field, value]) =>
    group.every((p) => index.get(linkedStateKey(p, field))?.value === value && index.get(linkedStateKey(p, field))!.at > 0));
  if (settled) return [];
  const at = records.reduce((clock, r) => Math.max(clock, r.at + 1), Math.max(1, now));
  if (!Number.isSafeInteger(at) || at >= Number.MAX_SAFE_INTEGER) throw new Error('Linked project state clock is out of range.');
  return group.flatMap((project) => changes.map(([field, value]) => ({ project, field, value, at, by: self })));
}

/**
 * Clock-zero records for what this computer had before sharing, for every
 * linked copy it has a say in: its own projects, pinned or not, and another
 * machine's row it pinned or marked. Merging them is a no-op once any
 * explicit edit exists, so they can be offered again safely. A field this
 * computer already has a clock-zero record for in `saved` isn't offered
 * again while the group's value for it is from before sharing too: by then
 * its state shows the group's value, and offering that would replace the
 * value it had before sharing. Once the group has an explicit value, the
 * copy keeps that one (unlink keeps the value), so it's offered as before.
 */
export function legacyLinkedStateRecords(
  state: ProjectState, groups: readonly NetworkProjectRef[][], self: string, saved: readonly LinkedProjectStateRecord[] = [],
): LinkedProjectStateRecord[] {
  const pinned = new Set(state.pinnedProjectIds), inactive = new Set(state.inactiveProjectIds);
  const offered = new Set(saved.filter((r) => r.at === 0 && r.by === self).map(linkedStateRecordKey));
  const index = indexLinkedState(saved);
  const out: LinkedProjectStateRecord[] = [];
  for (const group of groups) {
    const offer = (project: NetworkProjectRef, field: LinkedProjectField, value: boolean) => {
      const explicit = (groupLinkedState(index, group, field)?.at ?? 0) > 0;
      if (explicit || !offered.has(linkedStateKey(project, field))) out.push({ project, field, value, at: 0, by: self });
    };
    for (const project of group) {
      const id = sidebarProjectId(project, self);
      const own = project.machine === self;
      if (own || pinned.has(id)) offer(project, 'pinned', pinned.has(id));
      if (own || inactive.has(id)) offer(project, 'inactive', inactive.has(id));
    }
  }
  return out;
}

/**
 * This computer's state with every linked copy given its group's values,
 * under the id it shows (a local id, or `remote||machine||id`). Only copies
 * this computer lists (`listed`) are written, so a removed project or machine
 * stays forgotten here while its group's records stay. Projects that aren't
 * linked, and fields no copy has a record for, are left as they are. A pinned
 * group is never inactive. Newly pinned copies go after the pinned ones,
 * oldest pin first. A copy no longer in any group gets back this computer's
 * own Mark inactive from before sharing, unless an explicit edit replaced it
 * (on the copy, or on its group while linked: see legacyLinkedStateRecords).
 * Returns `state` itself when nothing changes.
 */
export function projectLinkedState(
  state: ProjectState, groups: readonly NetworkProjectRef[][], index: LinkedStateIndex, self: string, now: number,
  listed: (ref: NetworkProjectRef) => boolean = () => true,
): ProjectState {
  const pinned = new Set(state.pinnedProjectIds), inactive = new Set(state.inactiveProjectIds);
  const unpin = new Set<string>(), pins: Array<[string, number]> = [];
  let inactiveChanged = false, activity: Record<string, number> | undefined;
  for (const group of groups) {
    const ids = group.filter(listed).map((p) => sidebarProjectId(p, self));
    const pin = groupLinkedState(index, group, 'pinned');
    if (pin) for (const id of ids) {
      if (pin.value && !pinned.has(id)) { pinned.add(id); pins.push([id, pin.at]); }
      else if (!pin.value && pinned.has(id)) { pinned.delete(id); unpin.add(id); }
    }
    const mark = groupIsInactive(index, group);
    if (mark !== undefined) for (const id of ids) {
      if (mark !== inactive.has(id)) { inactiveChanged = true; if (mark) inactive.add(id); else inactive.delete(id); }
    }
    const active = groupLinkedState(index, group, 'activated');
    if (active && active.at > 0) {
      const at = Math.min(active.at, now);
      for (const id of ids) if ((state.projectActivity[id] ?? Number.NEGATIVE_INFINITY) < at) (activity ??= { ...state.projectActivity })[id] = at;
    }
  }
  const grouped = new Set(groups.flat().map(projectRefKey));
  for (const r of index.values()) {
    if (r.field !== 'inactive' || !r.value || r.at !== 0 || r.by !== self || grouped.has(projectRefKey(r.project)) || !listed(r.project)) continue;
    const id = sidebarProjectId(r.project, self);
    if (!inactive.has(id) && !pinned.has(id)) { inactive.add(id); inactiveChanged = true; }
  }
  if (!unpin.size && !pins.length && !inactiveChanged && !activity) return state;
  pins.sort((a, b) => a[1] - b[1] || compare(a[0], b[0]));
  return {
    ...state,
    pinnedProjectIds: unpin.size || pins.length ? [...state.pinnedProjectIds.filter((id) => !unpin.has(id)), ...pins.map(([id]) => id)] : state.pinnedProjectIds,
    inactiveProjectIds: inactiveChanged ? [...state.inactiveProjectIds.filter((id) => inactive.has(id)), ...[...inactive].filter((id) => !state.inactiveProjectIds.includes(id))] : state.inactiveProjectIds,
    projectActivity: activity ?? state.projectActivity,
  };
}
