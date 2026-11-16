import { useChromeStore, type AppLaunchParams } from './chromeStore';
import { useUIStore } from '../stores/uiStore';
import { returnToThisMachine } from './hosts';
import { closeDispatcher } from '../features/dispatcher/dispatcherNav';
import { reportChromeFeature } from './telemetry';

/**
 * Open an app view (a plugin's rail item, or a core view such as Group
 * Projects): this machine's, so a satellite is left; the New agent page and the
 * Dispatcher close. Every open goes through launchApp, so a plain open ends a
 * visit that Needs you started.
 */
export function openAppView(id: string, params?: AppLaunchParams): void {
  // App views are this machine's (#3065): nothing on screen would say they showed another one.
  returnToThisMachine();
  useChromeStore.getState().launchApp(id, params);
  useChromeStore.getState().closeNewAgent();
  closeDispatcher();
  useUIStore.getState().setExplorerTab(`plugin:app:${id}`);
  reportChromeFeature('app_item_open');
}
