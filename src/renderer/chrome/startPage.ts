import { useProjectStore } from '../stores/projectStore';
import { useUIStore } from '../stores/uiStore';
import { useQuickAgentStore } from '../stores/quickAgentStore';
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
  useChromeStore.getState().setProjectScope(projectId);
  useUIStore.getState().setExplorerTab('agents', projectId);
}

/**
 * ⌘⇧N. In the new shell it opens the start page composer for the selected
 * project (spec §4.3, §5.3). The legacy shell, a satellite host, or no local
 * project keeps the Quick Agent dialog.
 */
export function openNewQuickAgent(): void {
  const ui = useUIStore.getState();
  if (!isNewChromeEnabled() || ui.activeHostId) {
    ui.openQuickAgentDialog();
    return;
  }
  const { projects, activeProjectId } = useProjectStore.getState();
  const { lastProjectId } = useChromeStore.getState();
  const has = (id: string | null | undefined): id is string => !!id && projects.some((p) => p.id === id);
  const projectId = has(activeProjectId) ? activeProjectId : has(lastProjectId) ? lastProjectId : projects[0]?.id;
  if (!projectId) {
    ui.openQuickAgentDialog();
    return;
  }
  openStartPage(projectId);
  useChromeStore.getState().requestComposer();
}

