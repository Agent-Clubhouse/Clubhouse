/**
 * Pin and Mark inactive shared by linked copies of a project
 * (shared/linked-project-state.ts), wired into this computer's project state.
 *
 * An explicit Pin or Mark inactive accepted here, from a window or a phone, is
 * written as records for every copy in the group. Whenever records arrive,
 * links change or the state changes, this computer's values from before
 * sharing are offered at clock zero and every linked copy is given its group's
 * values in project-state.json, so the sidebar, the idle rule and phones read
 * them as before. A copy that leaves its group keeps the last shared value.
 */
import { sidebarProjectRef, type NetworkProjectRef } from '../../shared/project-links';
import { groupOfRef, legacyLinkedStateRecords, linkedStateWrite, projectLinkedState } from '../../shared/linked-project-state';
import type { ProjectState, ProjectStateChange, ProjectStateOp } from '../../shared/project-state';
import { linkedProjectStateStore, type LinkedProjectStateStore } from './linked-project-state-store';
import { projectLinksStore } from './project-links-store';
import { getIdentity } from './annex-identity';
import {
  getProjectState, isProjectStateReady, onProjectStateChange, reprojectProjectState, setLinkedProjectStateWriter,
} from './project-state-store';
import { appLog } from './log-service';

export interface LinkedProjectStateOptions {
  linked: LinkedProjectStateStore;
  links: { groups(): NetworkProjectRef[][]; onChange(listener: (change: { recordsChanged: boolean }) => void): () => void };
  self(): string | null;
  now?(): number;
  projectState: {
    get(): ProjectState;
    ready(): boolean;
    reproject(project: (state: ProjectState) => ProjectState): boolean;
    onChange(listener: (change: ProjectStateChange) => void): () => void;
    setWriter(writer: ((op: ProjectStateOp) => void) | null): void;
  };
}
export interface LinkedProjectState {
  /** Whether a project id, as this computer shows it, is in a linked group. */
  isLinked(projectId: string): boolean;
  /** Resolves once the latest reconciliation has finished, for tests. */
  settled(): Promise<void>;
  stop(): void;
}

const warn = (message: string, err: unknown) => appLog('core:project-state', 'warn', message, {
  meta: { error: err instanceof Error ? err.message : String(err) },
});

export function startLinkedProjectState(options: LinkedProjectStateOptions): LinkedProjectState {
  const now = () => (options.now ?? Date.now)();
  const groupsOrEmpty = () => {
    try { return options.links.groups(); }
    catch { return []; /* telemetry-exempt: an unreadable link replica is logged by its store; nothing is linked meanwhile */ }
  };
  let queue: Promise<void> = Promise.resolve();
  let stopped = false;
  const reconcile = () => {
    queue = queue.then(async () => {
      const self = options.self();
      if (stopped || !self || !options.projectState.ready()) return;
      const groups = groupsOrEmpty();
      if (!groups.length) return;
      // Values from before sharing first, so the group's value counts them.
      await options.linked.write(legacyLinkedStateRecords(options.projectState.get(), groups, self));
      options.projectState.reproject((state) => projectLinkedState(state, groups, options.linked.index(), self, now()));
    }).catch((err) => warn('Linked project state could not be applied', err));
  };
  options.projectState.setWriter((op) => {
    const self = options.self();
    if (!self) return;
    const records = linkedStateWrite(options.linked.current(), groupsOrEmpty(), op, self, now());
    if (records.length) void options.linked.write(records).catch((err) => warn('Linked project state could not be saved', err));
  });
  // Pins and marks this computer changed are offered again; activity alone isn't.
  let seen = '';
  const offState = options.projectState.onChange(({ state }) => {
    const key = JSON.stringify([state.pinnedProjectIds, state.inactiveProjectIds]);
    if (key === seen) return;
    seen = key;
    reconcile();
  });
  const offLinked = options.linked.onChange(() => reconcile());
  const offLinks = options.links.onChange((change) => { if (change.recordsChanged) reconcile(); });
  reconcile();
  return {
    isLinked(projectId) {
      const self = options.self();
      if (!self) return false;
      try { return !!groupOfRef(groupsOrEmpty(), sidebarProjectRef(projectId, self)); }
      catch { return false; /* telemetry-exempt: an id that isn't a project reference can't be linked */ }
    },
    settled: () => queue.then(() => options.linked.settled()),
    stop() {
      stopped = true;
      offState(); offLinked(); offLinks();
      options.projectState.setWriter(null);
    },
  };
}

let running: LinkedProjectState | undefined;
/** Start sharing with the real stores, once, at startup. */
export function startLinkedProjectStateService(): LinkedProjectState {
  running ??= startLinkedProjectState({
    linked: linkedProjectStateStore(),
    links: projectLinksStore(),
    self: () => getIdentity()?.fingerprint.toLowerCase() ?? null,
    projectState: {
      get: getProjectState, ready: isProjectStateReady, reproject: reprojectProjectState,
      onChange: onProjectStateChange, setWriter: setLinkedProjectStateWriter,
    },
  });
  return running;
}
/** Whether a project id, as this computer shows it, is in a linked group; false before sharing starts. */
export function isLinkedProject(projectId: string): boolean {
  return running?.isLinked(projectId) ?? false;
}
