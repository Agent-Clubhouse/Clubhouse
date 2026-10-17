import { useProjectStore } from '../stores/projectStore';
import { useUIStore } from '../stores/uiStore';
import { useQuickAgentStore } from '../stores/quickAgentStore';
import { useAgentStore } from '../stores/agentStore';
import { useChromeStore, type NewAgentOptions } from './chromeStore';
import { isNewChromeEnabled } from './chromeFlag';

/**
 * Open a project's start page: the project header selected with the Agents tab
 * (docs/chrome-redesign-spec.md §2).
 */
export function openStartPage(projectId: string): void {
  const projects = useProjectStore.getState();
  if (projects.activeProjectId !== projectId) projects.setActiveProject(projectId);
  useQuickAgentStore.getState().selectCompleted(null);
  // As a header click: no agent selected, so the project-switch restore keeps the scope.
  useAgentStore.getState().setActiveAgent(null, projectId);
  useChromeStore.getState().setProjectScope(projectId);
  useUIStore.getState().setExplorerTab('agents', projectId);
}

/** Whether the New agent page can open: the new shell, on the local host, with a project. */
export function canOpenNewAgentPage(): boolean {
  return isNewChromeEnabled() && !useUIStore.getState().activeHostId && useProjectStore.getState().projects.length > 0;
}

/**
 * Open the New agent page (#2031) with `kind` chosen and, optionally, a
 * project. Returns false, doing nothing, where it can't open (the legacy shell,
 * a satellite host, no projects); the caller decides what to do instead.
 *
 * `onCreated` gets the new agent's id; `onClosed` fires once when the page goes
 * away, with that id or null. With `stayInView` the view underneath stays put
 * after creating, instead of opening the agent.
 */
export function openNewAgentPage(kind: 'durable' | 'quick', projectId?: string, options: NewAgentOptions = {}): boolean {
  if (!canOpenNewAgentPage()) return false;
  useChromeStore.getState().openNewAgent(kind, projectId, options);
  return true;
}

/** The New agent page, or the Quick Agent dialog where the page can't open. For the app's own entry points. */
export function openNewAgentOrDialog(kind: 'durable' | 'quick', projectId?: string): void {
  if (!openNewAgentPage(kind, projectId)) useUIStore.getState().openQuickAgentDialog();
}

/** ⌘⇧N: the New agent page with Durable chosen, like the sidebar's New button (#2031). */
export function openNewAgentFromShortcut(): void {
  openNewAgentOrDialog('durable');
}
