/**
 * Project pins, inactive marks, activity and the idle window (#2458), kept here
 * rather than in renderer localStorage so Annex can send them to a phone and a
 * phone can change them. The rules are the shared ops in shared/project-state.ts.
 *
 * The state was renderer-only before. Until the first window hands over what it
 * had (hydrateProjectState), the store isn't ready: Annex leaves it out of the
 * snapshot and refuses phone changes, so a phone can't overwrite the
 * migration. Ops are applied synchronously, in arrival order; the file write
 * follows.
 */

import { createSettingsStore } from './settings-store';
import { appLog } from './log-service';
import {
  applyProjectStateOp,
  DEFAULT_PROJECT_STATE,
  sanitizeProjectState,
  type ProjectState,
  type ProjectStateChange,
  type ProjectStateOp,
} from '../../shared/project-state';

interface StoredProjectState extends ProjectState {
  version: 1;
  /** A window has handed over its localStorage state, or found none. */
  migrated: boolean;
}

const store = createSettingsStore<StoredProjectState>(
  'project-state.json',
  { version: 1, migrated: false, ...DEFAULT_PROJECT_STATE },
  (raw) => ({ version: 1, migrated: raw.migrated === true, ...sanitizeProjectState(raw) }),
);

/** Windows remembered for acks. A window reload is a new client; the oldest are dropped. */
const MAX_CLIENTS = 32;
const acked = new Map<string, number>();
const listeners = new Set<(change: ProjectStateChange) => void>();

const pick = (s: StoredProjectState): ProjectState => ({
  pinnedProjectIds: [...s.pinnedProjectIds],
  inactiveProjectIds: [...s.inactiveProjectIds],
  projectActivity: { ...s.projectActivity },
  idleDays: s.idleDays,
});

export function getProjectState(): ProjectState {
  return pick(store.get());
}

export function isProjectStateReady(): boolean {
  return store.get().migrated;
}

/** Called with every change, from any window or a phone. Returns the unsubscribe. */
export function onProjectStateChange(listener: (change: ProjectStateChange) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The latest write, for tests to wait on. */
let lastWrite: Promise<void> = Promise.resolve();

function save(next: StoredProjectState): void {
  lastWrite = store.save(next).catch((err) => {
    appLog('core:project-state', 'error', 'Failed to save project state', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  });
}

function notify(): void {
  const change: ProjectStateChange = { state: getProjectState(), acked: Object.fromEntries(acked) };
  for (const listener of listeners) {
    try {
      listener(change);
    } catch (err) {
      // telemetry-exempt: logged; the change is saved, and the other listeners still run.
      appLog('core:project-state', 'warn', 'Project state listener failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}

/**
 * A window starting up. The first one ever hands over the state it kept in
 * localStorage (`legacy`), which becomes the stored state; later ones get the
 * stored state back and drop theirs.
 */
export function hydrateProjectState(legacy: unknown): ProjectState {
  const current = store.get();
  if (!current.migrated) {
    save({ ...current, ...sanitizeProjectState(legacy), migrated: true });
    appLog('core:project-state', 'info', 'Moved project state from the renderer into main');
    notify();
  }
  return getProjectState();
}

/**
 * Apply one op. `source` is the window it came from and the op's sequence
 * there, acknowledged in the broadcast so that window can drop it from its
 * pending list. Returns whether the state changed.
 */
export function applyProjectStateChange(op: ProjectStateOp, source?: { clientId: string; seq: number }): boolean {
  const current = store.get();
  const base = pick(current);
  const next = applyProjectStateOp(base, op);
  const changed = next !== base;
  // Linked copies share explicit Pin and Mark inactive; a refused mark isn't one.
  const refused = op.type === 'setInactive' && op.inactive && base.pinnedProjectIds.includes(op.projectId);
  if (linkedWriter && (op.type === 'setPinned' || op.type === 'setInactive') && !refused) {
    try { linkedWriter(op, base); }
    catch (err) { // telemetry-exempt: logged; this computer's own state still changes
      appLog('core:project-state', 'warn', 'Linked project state write failed', { meta: { error: err instanceof Error ? err.message : String(err) } });
    }
  }
  if (source) {
    acked.delete(source.clientId);
    acked.set(source.clientId, source.seq);
    while (acked.size > MAX_CLIENTS) acked.delete(acked.keys().next().value as string);
  }
  if (changed) save({ ...current, ...next });
  // A window's op is acknowledged even when it changed nothing here.
  if (changed || source) notify();
  return changed;
}

let linkedWriter: ((op: ProjectStateOp, before: ProjectState) => void) | null = null;
/**
 * Linked copies of a project share Pin and Mark inactive
 * (linked-project-state-service.ts): told of every explicit one accepted here,
 * from a window or a phone, with the state before it.
 */
export function setLinkedProjectStateWriter(writer: ((op: ProjectStateOp, before: ProjectState) => void) | null): void {
  linkedWriter = writer;
}

/**
 * Replace the state with `project(state)`, as linked copies' shared values
 * arrive or links change. Nothing happens before the state has moved into
 * main. Returns whether it changed; a change is saved and broadcast.
 */
export function reprojectProjectState(project: (state: ProjectState) => ProjectState): boolean {
  const current = store.get();
  if (!current.migrated) return false;
  const base = pick(current);
  const next = project(base);
  if (next === base) return false;
  save({ ...current, ...next });
  notify();
  return true;
}

/** For tests: resolves once the latest write has finished. */
export function flushProjectStateForTests(): Promise<void> {
  return lastWrite;
}

/** For tests. */
export function resetProjectStateForTests(): void {
  acked.clear();
  listeners.clear();
  linkedWriter = null;
}
