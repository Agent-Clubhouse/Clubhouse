import { useUIStore } from '../../stores/uiStore';
import { useChromeStore } from '../../chrome/chromeStore';
import { requestLeaveAgentSettings } from '../agents/agentSettingsPages';
import { useDispatcherStore, visibleDispatcherAgentId } from './dispatcherStore';
import { useDispatcherDebugStore } from './dispatcherDebug';

/**
 * Opening and closing the Dispatcher's view (#2538). The view is a uiStore
 * flag, not a project or tab, so the active project and its agent stay as
 * they were, and closing it goes back to them.
 */

/** A page of the main window that the Dispatcher's popout (#3235) asks it to open. */
export type DispatcherNavTarget = 'dispatcher-settings' | 'dispatcher-setup' | 'auto-settings';

/**
 * In a popout these pages belong to the main window: bring it forward and have
 * it open them there. False in the main window.
 */
function openInMainWindow(target: DispatcherNavTarget): boolean {
  if (!window.clubhouse.window?.isPopout?.()) return false;
  const agentId = visibleDispatcherAgentId();
  if (agentId) void window.clubhouse.window.focusMain(agentId, target);
  return true;
}

/** What the main window does when a popout asks for one of these pages. */
export function openDispatcherNavTarget(target: string): void {
  if (target === 'dispatcher-settings') openDispatcherSettings();
  else if (target === 'dispatcher-setup') openDispatcherSetup();
  else if (target === 'auto-settings') openAutoSettings();
  else openDispatcher();
}

/**
 * Show the Dispatcher's view. Does nothing while it's turned off. `work` shows
 * its controller's chat instead, with the debug view on (#3188).
 */
export function openDispatcher(opts: { work?: boolean } = {}): void {
  if (!useDispatcherStore.getState().project) return;
  requestLeaveAgentSettings(() => {
    useChromeStore.getState().closeNewAgent();
    const ui = useUIStore.getState();
    // The view covers the pane, so leave Settings, Help or an app view first.
    if (ui.explorerTab === 'settings') ui.toggleSettings();
    else if (ui.explorerTab === 'help') ui.toggleHelp();
    else if (ui.explorerTab.startsWith('plugin:app:')) ui.setExplorerTab('agents');
    useDispatcherDebugStore.getState().setWorkOpen(!!opts.work);
    useUIStore.getState().setDispatcherOpen(true);
  });
}

export function closeDispatcher(): void {
  useUIStore.getState().setDispatcherOpen(false);
}

/** Its setup (#3047), opened again from the chat or its menu: in its own view. */
export function openDispatcherSetup(): void {
  if (openInMainWindow('dispatcher-setup')) return;
  useDispatcherStore.getState().setSetupOpen(true);
  openDispatcher();
}

/** Settings > Dispatcher (#2535), where its CLI, Behavior and runtime are set. */
export function openDispatcherSettings(): void {
  if (openInMainWindow('dispatcher-settings')) return;
  closeDispatcher();
  const ui = useUIStore.getState();
  ui.setSettingsContext('app');
  ui.setSettingsSubPage('dispatcher');
  if (ui.explorerTab !== 'settings') ui.toggleSettings();
}

/** "Set up Auto" (#3045): Settings > Smart selection (#3186), where the Auto mapping is chosen per provider. */
export function openAutoSettings(): void {
  if (openInMainWindow('auto-settings')) return;
  closeDispatcher();
  const ui = useUIStore.getState();
  ui.setSettingsContext('app');
  ui.setSettingsSubPage('smart-selection');
  if (ui.explorerTab !== 'settings') ui.toggleSettings();
}
