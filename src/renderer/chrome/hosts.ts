import { useUIStore } from '../stores/uiStore';
import { useProjectStore } from '../stores/projectStore';
import { parseNamespacedId } from '../stores/remoteProjectStore';
import { useChromeStore } from './chromeStore';

/**
 * Hosts in the new chrome (docs/chrome-redesign-spec.md §2, hosts option 1):
 * the sidebar shows one host at a time, chosen with the host switcher. Null is
 * the local host; otherwise a satellite id.
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
export function switchHost(hostId: string | null): void {
  const ui = useUIStore.getState();
  if (ui.activeHostId === hostId) return;
  ui.setActiveHost(hostId);
  useChromeStore.getState().setProjectScope(null);
  const projects = useProjectStore.getState();
  if (projects.activeProjectId && hostOf(projects.activeProjectId) !== hostId) projects.setActiveProject(null);
}
