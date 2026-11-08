import { useUIStore } from '../stores/uiStore';
import { useProjectStore } from '../stores/projectStore';
import { parseNamespacedId } from '../stores/remoteProjectStore';
import { useChromeStore } from './chromeStore';

/**
 * Hosts in the new chrome: the machine the views show. The sidebar lists every
 * machine's agents together (#3065), and the host follows what's selected
 * there: a project or agent on another machine shows that machine, and
 * anything of this machine's (its projects, app views, a new agent) brings
 * this machine back. Null is this machine; otherwise a satellite id.
 */

/** The host a project or agent id belongs to: null for local, the satellite id for a remote one. */
export function hostOf(id: string): string | null {
  return parseNamespacedId(id)?.satelliteId ?? null;
}

/**
 * Show another host. The selection belongs to the old host, so it is cleared:
 * a satellite opens on its dashboard, and the local host reopens its most
 * recent project (ChromeBody's fallback).
 */
/**
 * Back to this machine, with one of its projects selected (`projectId`, else
 * the most recent, else the first), so a page that opens next doesn't see the
 * project change under it. Nothing to do when this machine is shown.
 */
export function returnToThisMachine(projectId?: string): void {
  if (useUIStore.getState().activeHostId === null) return;
  switchHost(null);
  const projects = useProjectStore.getState();
  const local = (id: string | null | undefined) => !!id && hostOf(id) === null && projects.projects.some((p) => p.id === id);
  const last = useChromeStore.getState().lastProjectId;
  const target = local(projectId) ? projectId : local(last) ? last : projects.projects[0]?.id;
  if (target) projects.setActiveProject(target);
}

export function switchHost(hostId: string | null): void {
  const ui = useUIStore.getState();
  if (ui.activeHostId === hostId) return;
  ui.setActiveHost(hostId);
  useChromeStore.getState().setProjectScope(null);
  const projects = useProjectStore.getState();
  if (projects.activeProjectId && hostOf(projects.activeProjectId) !== hostId) projects.setActiveProject(null);
}
