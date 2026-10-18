import { afterEach, describe, expect, it } from 'vitest';
import { assertLaunchesOpen, closeLaunches, LaunchesClosedError, launchesOpen, reopenLaunches } from './launch-gate';

afterEach(() => reopenLaunches());

describe('launch gate', () => {
  it('refuses launches once closed, and allows them again after reopening', () => {
    expect(launchesOpen()).toBe(true);
    expect(() => assertLaunchesOpen()).not.toThrow();
    closeLaunches('quitting');
    expect(launchesOpen()).toBe(false);
    expect(() => assertLaunchesOpen()).toThrow(LaunchesClosedError);
    expect(() => assertLaunchesOpen()).toThrow('Clubhouse is quitting; not starting new agents');
    reopenLaunches();
    expect(() => assertLaunchesOpen()).not.toThrow();
  });
});
