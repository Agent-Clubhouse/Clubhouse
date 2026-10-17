import { useProjectStore } from '../stores/projectStore';
import { useUIStore } from '../stores/uiStore';
import { useQuickAgentStore } from '../stores/quickAgentStore';
import { useAgentStore } from '../stores/agentStore';
import { useChromeStore } from './chromeStore';
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

/**
 * The New agent page (#2031) with `kind` chosen, in the new shell on the local
 * host. Elsewhere (the legacy shell, a satellite, no projects yet) the Quick
 * Agent dialog stays the way in.
 */
export function openNewAgentPage(kind: 'durable' | 'quick', projectId?: string): void {
  const ui = useUIStore.getState();
  if (!isNewChromeEnabled() || ui.activeHostId || useProjectStore.getState().projects.length === 0) {
    ui.openQuickAgentDialog();
    return;
  }
  useChromeStore.getState().openNewAgent(kind, projectId);
}

/** ⌘⇧N: the New agent page with Durable chosen, like the sidebar's New button (#2031). */
export function openNewAgentFromShortcut(): void {
  openNewAgentPage('durable');
}
