import { useUIStore } from '../../stores/uiStore';
import { useChromeStore } from '../../chrome/chromeStore';
import { requestLeaveAgentSettings } from '../agents/agentSettingsPages';
import { useDispatcherStore } from './dispatcherStore';

/**
 * Opening and closing the Dispatcher's view (#2538). The view is a uiStore
 * flag, not a project or tab, so the active project and its agent stay as
 * they were, and closing it goes back to them.
 */

/** Show the Dispatcher's view. Does nothing while it's turned off. */
export function openDispatcher(): void {
  if (!useDispatcherStore.getState().project) return;
  requestLeaveAgentSettings(() => {
    useChromeStore.getState().closeNewAgent();
    const ui = useUIStore.getState();
    // The view covers the pane, so leave Settings, Help or an app view first.
    if (ui.explorerTab === 'settings') ui.toggleSettings();
    else if (ui.explorerTab === 'help') ui.toggleHelp();
    else if (ui.explorerTab.startsWith('plugin:app:')) ui.setExplorerTab('agents');
    useUIStore.getState().setDispatcherOpen(true);
  });
}

export function closeDispatcher(): void {
  useUIStore.getState().setDispatcherOpen(false);
}

/** Its setup (#3047), opened again from the chat or its menu: in its own view. */
export function openDispatcherSetup(): void {
  useDispatcherStore.getState().setSetupOpen(true);
  openDispatcher();
}

/** Settings > Dispatcher (#2535), where its CLI, Behavior and runtime are set. */
export function openDispatcherSettings(): void {
  closeDispatcher();
  const ui = useUIStore.getState();
  ui.setSettingsContext('app');
  ui.setSettingsSubPage('dispatcher');
  if (ui.explorerTab !== 'settings') ui.toggleSettings();
}

/** "Set up Auto" (#3045): Settings > Smart selection (#3186), where the Auto mapping is chosen per provider. */
export function openAutoSettings(): void {
  closeDispatcher();
  const ui = useUIStore.getState();
  ui.setSettingsContext('app');
  ui.setSettingsSubPage('smart-selection');
  if (ui.explorerTab !== 'settings') ui.toggleSettings();
}
