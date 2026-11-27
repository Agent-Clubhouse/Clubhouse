import { WELCOME_TOUR_VERSION, type WelcomeTourState, type WelcomeTourVariant } from '../../../shared/welcome-tour';

/**
 * What the 1.0 welcome tour shows, and to whom (#2814). Pure, so each audience
 * is a unit test: the store and the shell only read from here.
 */

export type TourStep = 'welcome' | 'managed' | 'dispatcher' | 'helpers' | 'alsonew' | 'start';

export type TourScene =
  | 'welcome-new' | 'welcome-upgrade'
  | 'switched' | 'compose' | 'skills' | 'updates' | 'share'
  | 'dispatcher'
  | 'orch' | 'smart-routing'
  | 'alsonew'
  | 'start';

export const STEP_NAMES: Record<TourStep, string> = {
  welcome: 'Welcome',
  managed: 'Managed agents',
  dispatcher: 'The Dispatcher',
  helpers: 'Orchestrators',
  alsonew: 'Also new',
  start: 'Get started',
};

/**
 * New users end on Get started, the same page the empty app shows. It's left
 * out once there is a project, since then there's nothing to start.
 */
export function tourSteps(variant: WelcomeTourVariant, hasProjects: boolean): TourStep[] {
  const steps: TourStep[] = ['welcome', 'managed', 'dispatcher', 'helpers', 'alsonew'];
  if (variant === 'new' && !hasProjects) steps.push('start');
  return steps;
}

/** The scenes in one step. Upgraders get a first managed agents scene on what happened to their agents. */
export function stepScenes(step: TourStep, variant: WelcomeTourVariant, smartRouting: boolean): TourScene[] {
  switch (step) {
    case 'welcome': return [variant === 'new' ? 'welcome-new' : 'welcome-upgrade'];
    case 'managed': return variant === 'upgrade' ? ['switched', 'compose', 'skills', 'updates', 'share'] : ['compose', 'skills', 'updates', 'share'];
    case 'dispatcher': return ['dispatcher'];
    case 'helpers': return smartRouting ? ['orch', 'smart-routing'] : ['orch'];
    case 'alsonew': return ['alsonew'];
    case 'start': return ['start'];
  }
}

/** Where the tour is: a step and a scene inside it. */
export interface TourPosition {
  step: number;
  scene: number;
}

export interface TourShape {
  variant: WelcomeTourVariant;
  hasProjects: boolean;
  smartRouting: boolean;
}

/** Next scene, then the next step's first. Null past the last scene: the tour is done. */
export function nextPosition(shape: TourShape, at: TourPosition): TourPosition | null {
  const steps = tourSteps(shape.variant, shape.hasProjects);
  const scenes = stepScenes(steps[at.step], shape.variant, shape.smartRouting);
  if (at.scene < scenes.length - 1) return { step: at.step, scene: at.scene + 1 };
  if (at.step < steps.length - 1) return { step: at.step + 1, scene: 0 };
  return null;
}

/** Previous scene, then the previous step's last. Null at the very start. */
export function previousPosition(shape: TourShape, at: TourPosition): TourPosition | null {
  if (at.scene > 0) return { step: at.step, scene: at.scene - 1 };
  if (at.step === 0) return null;
  const steps = tourSteps(shape.variant, shape.hasProjects);
  const scenes = stepScenes(steps[at.step - 1], shape.variant, shape.smartRouting);
  return { step: at.step - 1, scene: scenes.length - 1 };
}

export function isLastPosition(shape: TourShape, at: TourPosition): boolean {
  return nextPosition(shape, at) === null;
}

/** Keep a position inside the tour after its shape changed (a project was added, say). */
export function clampPosition(shape: TourShape, at: TourPosition): TourPosition {
  const steps = tourSteps(shape.variant, shape.hasProjects);
  const step = Math.min(Math.max(at.step, 0), steps.length - 1);
  const scenes = stepScenes(steps[step], shape.variant, shape.smartRouting);
  return { step, scene: Math.min(Math.max(at.scene, 0), scenes.length - 1) };
}

// ── Who sees it at launch ─────────────────────────────────────────────────

export interface TourLaunchInput {
  /** Null when welcome-tour.json was there but couldn't be read. */
  state: WelcomeTourState | null;
  /** The What's New record of the last version run. Undefined when it couldn't be read. */
  lastSeenVersion: string | null | undefined;
  currentVersion: string;
  projectCount: number;
}

export type TourLaunchDecision =
  | { show: false; reason: 'seen' }
  | { show: true; variant: WelcomeTourVariant; reason: 'resumed' | 'unreadable' | 'has_projects' | 'earlier_version' | 'fresh' };

/**
 * Decided once at startup, from saved state, with one result (#2814):
 * - Already finished or skipped this tour version: nothing.
 * - Opened before for this version and not finished: the same audience again.
 * - Anything unreadable: upgrading, which never hides existing work.
 * - Projects saved, or an earlier version recorded: upgrading.
 * - Otherwise: new.
 */
export function decideTourAtLaunch(input: TourLaunchInput): TourLaunchDecision {
  const { state } = input;
  if (state && state.seenVersion >= WELCOME_TOUR_VERSION) return { show: false, reason: 'seen' };
  if (state?.variant && state.variantVersion === WELCOME_TOUR_VERSION) return { show: true, variant: state.variant, reason: 'resumed' };
  if (!state || input.lastSeenVersion === undefined) return { show: true, variant: 'upgrade', reason: 'unreadable' };
  if (input.projectCount > 0) return { show: true, variant: 'upgrade', reason: 'has_projects' };
  if (input.lastSeenVersion !== null && input.lastSeenVersion !== input.currentVersion) return { show: true, variant: 'upgrade', reason: 'earlier_version' };
  return { show: true, variant: 'new', reason: 'fresh' };
}

/** Reopened from Help or What's New: the audience it was decided for, or a best guess from what's here now. */
export function variantForReopen(state: WelcomeTourState | null, projectCount: number): WelcomeTourVariant {
  return state?.variant ?? (projectCount > 0 ? 'upgrade' : 'new');
}
