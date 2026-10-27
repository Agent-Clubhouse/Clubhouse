import { applyProjectStateOp, type ProjectState, type ProjectStateChange, type ProjectStateOp } from '../../shared/project-state';
import { startMainStateSync, type MainStateSync, type MainStateTarget } from '../sync/mainStateSync';

/**
 * Keeps the sidebar's pins, inactive marks and activity in step with main,
 * which owns them (#2458) so a phone can see and change them. The hydrate,
 * ordering and rebase rules are startMainStateSync's.
 */

export interface ProjectStateApi {
  hydrateState: (legacy: ProjectState) => Promise<ProjectState>;
  applyStateOp: (clientId: string, seq: number, op: ProjectStateOp) => Promise<void>;
  onStateChanged: (callback: (change: ProjectStateChange) => void) => () => void;
}

export type ProjectStateTarget = MainStateTarget<ProjectState>;
export type ProjectStateSync = MainStateSync<ProjectStateOp>;

export function startProjectStateSync(api: ProjectStateApi, target: ProjectStateTarget): ProjectStateSync {
  return startMainStateSync({ hydrate: api.hydrateState, apply: api.applyStateOp, onChanged: api.onStateChanged }, target, applyProjectStateOp);
}
