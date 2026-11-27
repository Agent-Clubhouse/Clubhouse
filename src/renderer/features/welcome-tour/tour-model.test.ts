import { describe, expect, it } from 'vitest';
import { WELCOME_TOUR_VERSION, normalizeWelcomeTourState, type WelcomeTourState } from '../../../shared/welcome-tour';
import {
  clampPosition,
  decideTourAtLaunch,
  isLastPosition,
  nextPosition,
  previousPosition,
  stepScenes,
  tourSteps,
  variantForReopen,
  type TourShape,
} from './tour-model';

const fresh: WelcomeTourState = { seenVersion: 0, variant: null, variantVersion: 0 };

describe('decideTourAtLaunch: the audience seeds (#2814)', () => {
  const base = { state: fresh, lastSeenVersion: null, currentVersion: '1.0.0', projectCount: 0 };

  it('new: no projects and no earlier version', () => {
    expect(decideTourAtLaunch(base)).toEqual({ show: true, variant: 'new', reason: 'fresh' });
  });

  it('new: a fresh packaged install, where What\'s New already recorded this version', () => {
    expect(decideTourAtLaunch({ ...base, lastSeenVersion: '1.0.0' })).toMatchObject({ show: true, variant: 'new' });
  });

  it('upgraded from 0.42 with projects', () => {
    expect(decideTourAtLaunch({ ...base, lastSeenVersion: '0.42.3', projectCount: 3 })).toMatchObject({ show: true, variant: 'upgrade' });
  });

  it('upgraded from an earlier version with no projects left', () => {
    expect(decideTourAtLaunch({ ...base, lastSeenVersion: '0.43.0-beta.8' })).toEqual({ show: true, variant: 'upgrade', reason: 'earlier_version' });
  });

  it('projects with no version recorded (What\'s New never ran) are upgrading', () => {
    expect(decideTourAtLaunch({ ...base, projectCount: 1 })).toEqual({ show: true, variant: 'upgrade', reason: 'has_projects' });
  });

  it('upgraded from 0.42 with no projects and What\'s New never dismissed: an earlier run\'s files say so', () => {
    expect(decideTourAtLaunch({ ...base, earlierRun: true })).toEqual({ show: true, variant: 'upgrade', reason: 'earlier_run' });
    expect(decideTourAtLaunch({ ...base, earlierRun: false })).toMatchObject({ variant: 'new' });
  });

  it('already introduced: nothing, whatever else is saved', () => {
    const seen = { seenVersion: WELCOME_TOUR_VERSION, variant: 'upgrade' as const, variantVersion: WELCOME_TOUR_VERSION };
    expect(decideTourAtLaunch({ ...base, state: seen, projectCount: 5, lastSeenVersion: '0.40.0' })).toEqual({ show: false, reason: 'seen' });
  });

  it('unreadable tour state, or an unreadable version record, is upgrading', () => {
    expect(decideTourAtLaunch({ ...base, state: null })).toEqual({ show: true, variant: 'upgrade', reason: 'unreadable' });
    expect(decideTourAtLaunch({ ...base, lastSeenVersion: undefined })).toEqual({ show: true, variant: 'upgrade', reason: 'unreadable' });
  });

  it('a relaunch mid-tour keeps the audience it was decided for', () => {
    const started = { seenVersion: 0, variant: 'new' as const, variantVersion: WELCOME_TOUR_VERSION };
    // A project added during the tour doesn't make a new person an upgrader.
    expect(decideTourAtLaunch({ ...base, state: started, projectCount: 1 })).toEqual({ show: true, variant: 'new', reason: 'resumed' });
  });

  it('a raised tour version shows it again, decided afresh', () => {
    const old = { seenVersion: WELCOME_TOUR_VERSION - 1, variant: 'new' as const, variantVersion: WELCOME_TOUR_VERSION - 1 };
    expect(decideTourAtLaunch({ ...base, state: old, projectCount: 2 })).toMatchObject({ show: true, variant: 'upgrade' });
  });
});

describe('normalizeWelcomeTourState', () => {
  it('keeps known fields and drops the rest', () => {
    expect(normalizeWelcomeTourState({ seenVersion: 1, variant: 'upgrade', variantVersion: 1, extra: true })).toEqual({ seenVersion: 1, variant: 'upgrade', variantVersion: 1 });
  });

  it('reads anything malformed as the default', () => {
    expect(normalizeWelcomeTourState(null)).toEqual(fresh);
    expect(normalizeWelcomeTourState({ seenVersion: -2, variant: 'other', variantVersion: 1.5 })).toEqual(fresh);
  });
});

describe('steps and scenes', () => {
  it('new users get six steps ending on Get started; upgraders five, with no Get started', () => {
    expect(tourSteps('new', false)).toEqual(['welcome', 'managed', 'dispatcher', 'helpers', 'alsonew', 'start']);
    expect(tourSteps('upgrade', true)).toEqual(['welcome', 'managed', 'dispatcher', 'helpers', 'alsonew']);
    expect(tourSteps('upgrade', false)).not.toContain('start');
  });

  it('Get started is left out once there is a project', () => {
    expect(tourSteps('new', true)).not.toContain('start');
  });

  it('upgraders get the switched scene first in Managed agents', () => {
    expect(stepScenes('managed', 'new', false)).toEqual(['compose', 'skills', 'updates', 'share']);
    expect(stepScenes('managed', 'upgrade', false)).toEqual(['switched', 'compose', 'skills', 'updates', 'share']);
  });

  it('each audience has its own welcome', () => {
    expect(stepScenes('welcome', 'new', false)).toEqual(['welcome-new']);
    expect(stepScenes('welcome', 'upgrade', false)).toEqual(['welcome-upgrade']);
  });

  it('Orchestrators adds Smart routing only when it is on for the tour', () => {
    expect(stepScenes('helpers', 'new', false)).toEqual(['orch']);
    expect(stepScenes('helpers', 'upgrade', true)).toEqual(['orch', 'smart-routing']);
  });
});

describe('moving through the tour', () => {
  const shape: TourShape = { variant: 'upgrade', hasProjects: true, smartRouting: false };

  it('walks every scene in order, then ends', () => {
    const seen: string[] = [];
    let at: { step: number; scene: number } | null = { step: 0, scene: 0 };
    while (at) {
      const step = tourSteps(shape.variant, shape.hasProjects)[at.step];
      seen.push(stepScenes(step, shape.variant, shape.smartRouting)[at.scene]);
      if (isLastPosition(shape, at)) expect(nextPosition(shape, at)).toBeNull();
      at = nextPosition(shape, at);
    }
    expect(seen).toEqual(['welcome-upgrade', 'switched', 'compose', 'skills', 'updates', 'share', 'dispatcher', 'orch', 'alsonew']);
  });

  it('Back goes to the previous step\'s last scene, and stops at the start', () => {
    expect(previousPosition(shape, { step: 2, scene: 0 })).toEqual({ step: 1, scene: 4 });
    expect(previousPosition(shape, { step: 1, scene: 2 })).toEqual({ step: 1, scene: 1 });
    expect(previousPosition(shape, { step: 0, scene: 0 })).toBeNull();
  });

  it('clamps a position that no longer fits', () => {
    expect(clampPosition(shape, { step: 9, scene: 9 })).toEqual({ step: 4, scene: 0 });
    expect(clampPosition(shape, { step: 1, scene: 7 })).toEqual({ step: 1, scene: 4 });
  });
});

describe('variantForReopen', () => {
  it('uses the audience the tour was decided for', () => {
    expect(variantForReopen({ seenVersion: 1, variant: 'new', variantVersion: 1 }, 4)).toBe('new');
  });

  it('guesses from projects when nothing was decided', () => {
    expect(variantForReopen(null, 0)).toBe('new');
    expect(variantForReopen(fresh, 2)).toBe('upgrade');
  });
});
