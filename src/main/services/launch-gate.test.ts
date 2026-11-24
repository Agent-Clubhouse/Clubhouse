import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentWorkOpen, assertLaunchesOpen, captureLaunchAdmission, closeAgentWork,
  closeLaunches, hasAgentWorkInFlight, LaunchesClosedError, launchesOpen,
  reopenLaunches, runAgentWork, whenAgentWorkOpen,
} from './launch-gate';

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

  it('keeps an open capture current through reads and an already-open reopen', () => {
    const current = captureLaunchAdmission();
    expect(current()).toBe(true);
    expect(current()).toBe(true);
    reopenLaunches();
    expect(current()).toBe(true);
    expect(() => assertLaunchesOpen()).not.toThrow();
  });

  it('does not revive a pre-close capture when a canceled shutdown reopens launches', () => {
    const old = captureLaunchAdmission();
    closeLaunches('restarting');
    expect(old()).toBe(false);
    reopenLaunches();
    expect(launchesOpen()).toBe(true);
    expect(old()).toBe(false);
    expect(captureLaunchAdmission()()).toBe(true);
  });

  it('never admits a capture made while closed, including after reopening', () => {
    closeLaunches('quitting');
    const closed = captureLaunchAdmission();
    expect(closed()).toBe(false);
    reopenLaunches();
    expect(closed()).toBe(false);
    expect(captureLaunchAdmission()()).toBe(true);
  });

  it('keeps old captures invalid across repeated closes and later reopenings', () => {
    const first = captureLaunchAdmission();
    closeLaunches('restarting');
    const closed = captureLaunchAdmission();
    closeLaunches('quitting');
    reopenLaunches();
    const fresh = captureLaunchAdmission();
    expect(first()).toBe(false);
    expect(closed()).toBe(false);
    expect(fresh()).toBe(true);
    closeLaunches('restarting');
    reopenLaunches();
    expect(first()).toBe(false);
    expect(closed()).toBe(false);
    expect(fresh()).toBe(false);
    expect(captureLaunchAdmission()()).toBe(true);
  });

  it.each(['success', 'failure'] as const)('refuses a held %s callback after close and reopen', async (outcome) => {
    const admitted = captureLaunchAdmission();
    const effect = vi.fn();
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const held = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const completed = held.then(
      () => { if (admitted()) effect('start'); },
      () => { if (admitted()) effect('stop'); },
    );
    closeLaunches('restarting');
    reopenLaunches();
    if (outcome === 'success') resolve();
    else reject(new Error('late failure'));
    await completed;
    expect(effect).not.toHaveBeenCalled();
    const fresh = captureLaunchAdmission();
    if (fresh()) effect('fresh explicit request');
    expect(effect).toHaveBeenCalledExactlyOnceWith('fresh explicit request');
  });

  it('observes launch admission without canceling work already in flight', async () => {
    const admitted = captureLaunchAdmission();
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const work = runAgentWork('existing-work', () => held);
    try {
      closeLaunches('quitting');
      expect(admitted()).toBe(false);
      expect(agentWorkOpen()).toBe(true);
      expect(hasAgentWorkInFlight('existing-work')).toBe(true);
    } finally {
      finish();
      await work;
    }
    expect(hasAgentWorkInFlight('existing-work')).toBe(false);
  });

  it('leaves the separate agent-work gate and reopen waiters unchanged', async () => {
    const admitted = captureLaunchAdmission();
    closeAgentWork();
    expect(agentWorkOpen()).toBe(false);
    expect(admitted()).toBe(true);
    const released = vi.fn();
    const waiting = whenAgentWorkOpen().then(released);
    await Promise.resolve();
    expect(released).not.toHaveBeenCalled();
    reopenLaunches();
    await waiting;
    expect(released).toHaveBeenCalledOnce();
    expect(agentWorkOpen()).toBe(true);
    expect(admitted()).toBe(true);
  });
});
