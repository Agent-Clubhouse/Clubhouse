import { create } from 'zustand';
import { WELCOME_TOUR_VERSION, type WelcomeTourState, type WelcomeTourVariant } from '../../../shared/welcome-tour';
import { rendererLog } from '../../plugins/renderer-logger';
import { useProjectStore } from '../../stores/projectStore';
import { useUIStore } from '../../stores/uiStore';
import { useChromeStore } from '../../chrome/chromeStore';
import { isNewChromeEnabled } from '../../chrome/chromeFlag';
import {
  clampPosition,
  decideTourAtLaunch,
  nextPosition,
  previousPosition,
  stepScenes,
  tourSteps,
  variantForReopen,
  type TourPosition,
  type TourShape,
} from './tour-model';

/**
 * The welcome tour's open state (#2814). It covers the pane like the
 * Dispatcher's view: opening anything else closes it (WelcomeTour.tsx), and
 * closing it in any way counts as seen. The only thing it saves is its own
 * state in welcome-tour.json. It never changes a setting or an agent.
 */

export type TourCloseReason = 'skip' | 'done' | 'navigate';

interface WelcomeTourStoreState extends TourShape {
  open: boolean;
  position: TourPosition;
  /** The saved state as last read or written. Null until read. */
  saved: WelcomeTourState | null;
  openTour: (shape: TourShape) => void;
  closeTour: (reason: TourCloseReason) => void;
  next: () => void;
  back: () => void;
  goToStep: (step: number) => void;
  goToScene: (scene: number) => void;
}

function log(level: 'info' | 'warn', message: string, meta?: Record<string, unknown>): void {
  try {
    rendererLog('core:welcome-tour', level, message, meta ? { meta } : undefined);
  } catch {
    // telemetry-exempt: logging never breaks the tour.
  }
}

async function persist(state: WelcomeTourState): Promise<void> {
  try {
    const saved = await window.clubhouse.app.saveWelcomeTour(state);
    useWelcomeTourStore.setState({ saved });
  } catch (err) {
    // telemetry-exempt: logged; the tour still works, and shows again at the next launch.
    log('warn', 'Could not save the welcome tour state', { error: err instanceof Error ? err.name : 'unknown' });
  }
}

export const useWelcomeTourStore = create<WelcomeTourStoreState>((set, get) => ({
  open: false,
  variant: 'new',
  hasProjects: false,
  smartRouting: false,
  position: { step: 0, scene: 0 },
  saved: null,

  openTour: (shape) => {
    set({ ...shape, open: true, position: { step: 0, scene: 0 } });
    const prev = get().saved;
    if (prev?.variant !== shape.variant || prev.variantVersion !== WELCOME_TOUR_VERSION) {
      void persist({ seenVersion: prev?.seenVersion ?? 0, variant: shape.variant, variantVersion: WELCOME_TOUR_VERSION });
    }
  },

  closeTour: (reason) => {
    const { open, variant, saved, position } = get();
    if (!open) return;
    set({ open: false });
    log('info', 'Welcome tour closed', { reason, variant, step: tourSteps(variant, get().hasProjects)[position.step] });
    if ((saved?.seenVersion ?? 0) < WELCOME_TOUR_VERSION) {
      void persist({ seenVersion: WELCOME_TOUR_VERSION, variant, variantVersion: WELCOME_TOUR_VERSION });
    }
  },

  next: () => {
    const s = get();
    const to = nextPosition(s, s.position);
    if (to) set({ position: to });
    else s.closeTour('done');
  },

  back: () => {
    const s = get();
    const to = previousPosition(s, s.position);
    if (to) set({ position: to });
  },

  goToStep: (step) => set((s) => ({ position: clampPosition(s, { step, scene: 0 }) })),

  goToScene: (scene) => set((s) => {
    const scenes = stepScenes(tourSteps(s.variant, s.hasProjects)[s.position.step], s.variant, s.smartRouting);
    return { position: { step: s.position.step, scene: Math.min(Math.max(scene, 0), scenes.length - 1) } };
  }),
}));

/** Clear the pane for the tour: leave Settings, Help or an app view, and close the Dispatcher and New agent. */
function clearPane(): void {
  useChromeStore.getState().closeNewAgent();
  const ui = useUIStore.getState();
  ui.setDispatcherOpen(false);
  if (ui.explorerTab === 'settings') ui.toggleSettings();
  else if (ui.explorerTab === 'help') ui.toggleHelp();
  else if (ui.explorerTab.startsWith('plugin:app:')) ui.setExplorerTab('agents');
}

/**
 * Whether two or more Smart routing candidates are signed in, at least one with
 * a plan Clubhouse can read. Filled in by the Smart routing scene's gate; until
 * then the Orchestrators step has one scene.
 */
async function readSmartRouting(): Promise<boolean> {
  return false;
}

async function readSaved(): Promise<{ state: WelcomeTourState | null }> {
  try {
    const { state, unreadable } = await window.clubhouse.app.getWelcomeTour();
    useWelcomeTourStore.setState({ saved: state });
    return { state: unreadable ? null : state };
  } catch (err) {
    // telemetry-exempt: logged; unreadable state shows the upgrading tour, which never hides work.
    log('warn', 'Could not read the welcome tour state', { error: err instanceof Error ? err.name : 'unknown' });
    return { state: null };
  }
}

async function readLastSeenVersion(): Promise<string | null | undefined> {
  try {
    const settings = await window.clubhouse.app.getUpdateSettings() as { lastSeenVersion?: unknown } | null;
    const v = settings?.lastSeenVersion;
    return typeof v === 'string' ? v : v === null || v === undefined ? null : undefined;
  } catch {
    // telemetry-exempt: an unreadable version record counts as upgrading, which never hides work.
    return undefined;
  }
}

/**
 * At launch, after the project list loads: open the tour if this person hasn't
 * seen this version of it. Only the new layout has it, so a classic session
 * leaves it for the first launch in the new one. Resolves whether it opened, so
 * What's New can wait for another launch. Never throws.
 */
export async function startWelcomeTourIfDue(): Promise<boolean> {
  try {
    if (!isNewChromeEnabled()) return false;
    const [{ state }, lastSeenVersion, currentVersion] = await Promise.all([
      readSaved(),
      readLastSeenVersion(),
      window.clubhouse.app.getVersion(),
    ]);
    const projectCount = useProjectStore.getState().projects.length;
    const decision = decideTourAtLaunch({ state, lastSeenVersion, currentVersion, projectCount });
    if (!decision.show) return false;
    const smartRouting = await readSmartRouting();
    clearPane();
    useWelcomeTourStore.getState().openTour({ variant: decision.variant, hasProjects: projectCount > 0, smartRouting });
    log('info', 'Welcome tour opened at launch', { variant: decision.variant, reason: decision.reason });
    return true;
  } catch (err) {
    // telemetry-exempt: logged; the app goes on without the tour this launch.
    log('warn', 'Could not decide whether to show the welcome tour', { error: err instanceof Error ? err.name : 'unknown' });
    return false;
  }
}

/** Reopen the tour from Help or Settings › What's new, at its first step. */
export async function openWelcomeTour(): Promise<void> {
  const saved = useWelcomeTourStore.getState().saved ?? (await readSaved()).state;
  const projectCount = useProjectStore.getState().projects.length;
  const smartRouting = await readSmartRouting();
  clearPane();
  useWelcomeTourStore.getState().openTour({ variant: variantForReopen(saved, projectCount), hasProjects: projectCount > 0, smartRouting });
}

export type { WelcomeTourVariant };
