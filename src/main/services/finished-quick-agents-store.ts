/**
 * Finished quick agents (#2467), kept here rather than in renderer
 * localStorage so Annex can send the start page's "Finished, waiting on you"
 * list to a phone and a phone can dismiss from it. The rules are the shared
 * ops in shared/finished-quick-agents.ts.
 *
 * The lists were renderer-only before. Until the first window hands over what
 * it had (hydrateFinishedQuickAgents), the store isn't ready: Annex leaves the
 * lists out of the snapshot and refuses phone changes, so a phone can't
 * overwrite the migration. Ops are applied synchronously, in arrival order;
 * the file write follows.
 */

import { createSettingsStore } from './settings-store';
import { appLog } from './log-service';
import {
  applyFinishedQuickAgentOp,
  sanitizeFinishedQuickAgents,
  type FinishedQuickAgentOp,
  type FinishedQuickAgents,
  type FinishedQuickAgentsChange,
} from '../../shared/finished-quick-agents';

interface StoredFinishedQuickAgents {
  version: 1;
  /** A window has handed over its localStorage lists, or found none. */
  migrated: boolean;
  projects: FinishedQuickAgents;
}

const store = createSettingsStore<StoredFinishedQuickAgents>(
  'finished-quick-agents.json',
  { version: 1, migrated: false, projects: {} },
  (raw) => ({ version: 1, migrated: raw.migrated === true, projects: sanitizeFinishedQuickAgents(raw.projects) }),
);

/** Windows remembered for acks. A window reload is a new client; the oldest are dropped. */
const MAX_CLIENTS = 32;
const acked = new Map<string, number>();
const listeners = new Set<(change: FinishedQuickAgentsChange) => void>();

export function getFinishedQuickAgents(): FinishedQuickAgents {
  return Object.fromEntries(Object.entries(store.get().projects).map(([id, list]) => [id, [...list]]));
}

export function isFinishedQuickAgentsReady(): boolean {
  return store.get().migrated;
}

/** Called with every change, from any window or a phone. Returns the unsubscribe. */
export function onFinishedQuickAgentsChange(listener: (change: FinishedQuickAgentsChange) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The latest write, for tests to wait on. */
let lastWrite: Promise<void> = Promise.resolve();

function save(next: StoredFinishedQuickAgents): void {
  lastWrite = store.save(next).catch((err) => {
    appLog('core:finished-quick-agents', 'error', 'Failed to save finished quick agents', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  });
}

function notify(): void {
  const change: FinishedQuickAgentsChange = { state: getFinishedQuickAgents(), acked: Object.fromEntries(acked) };
  for (const listener of listeners) {
    try {
      listener(change);
    } catch (err) {
      // telemetry-exempt: logged; the change is saved, and the other listeners still run.
      appLog('core:finished-quick-agents', 'warn', 'Finished quick agents listener failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}

/**
 * A window starting up. The first one ever hands over the lists it kept in
 * localStorage (`legacy`), which become the stored lists; later ones get the
 * stored lists back and drop theirs.
 */
export function hydrateFinishedQuickAgents(legacy: unknown): FinishedQuickAgents {
  const current = store.get();
  if (!current.migrated) {
    save({ ...current, projects: sanitizeFinishedQuickAgents(legacy), migrated: true });
    appLog('core:finished-quick-agents', 'info', 'Moved finished quick agents from the renderer into main');
    notify();
  }
  return getFinishedQuickAgents();
}

/**
 * Apply one op. `source` is the window it came from and the op's sequence
 * there, acknowledged in the broadcast so that window can drop it from its
 * pending list. Returns whether the lists changed.
 */
export function applyFinishedQuickAgentChange(op: FinishedQuickAgentOp, source?: { clientId: string; seq: number }): boolean {
  const current = store.get();
  const next = applyFinishedQuickAgentOp(current.projects, op);
  const changed = next !== current.projects;
  if (source) {
    acked.delete(source.clientId);
    acked.set(source.clientId, source.seq);
    while (acked.size > MAX_CLIENTS) acked.delete(acked.keys().next().value as string);
  }
  if (changed) save({ ...current, projects: next });
  // A window's op is acknowledged even when it changed nothing here.
  if (changed || source) notify();
  return changed;
}

/** For tests: resolves once the latest write has finished. */
export function flushFinishedQuickAgentsForTests(): Promise<void> {
  return lastWrite;
}

/** For tests. */
export function resetFinishedQuickAgentsForTests(): void {
  acked.clear();
  listeners.clear();
}
