import { afterEach, describe, expect, it } from 'vitest';
import { clearSessionCaptures, sessionCaptureFor, trackSessionCapture, whenSessionCapturesSettled } from './session-capture-barrier';

afterEach(() => clearSessionCaptures());

const later = (ms: number, log: string[], name: string, fail = false) =>
  new Promise<void>((resolve, reject) => setTimeout(() => { log.push(name); if (fail) reject(new Error(name)); else resolve(); }, ms));

describe('session capture barrier', () => {
  it('waits for every agent\'s write, including one started while waiting', async () => {
    const log: string[] = [];
    trackSessionCapture('a', later(10, log, 'a'));
    trackSessionCapture('b', later(5, log, 'b').then(() => trackSessionCapture('c', later(10, log, 'c'))));
    await whenSessionCapturesSettled();
    expect(log.sort()).toEqual(['a', 'b', 'c']);
    expect(sessionCaptureFor('a')).toBeUndefined();
  });

  it('chains writes for one agent, so the agent\'s wait covers both', async () => {
    const log: string[] = [];
    trackSessionCapture('a', later(15, log, 'first'));
    trackSessionCapture('a', later(1, log, 'second'));
    await sessionCaptureFor('a');
    expect(log).toEqual(['second', 'first']);
  });

  it('never rejects when a write fails', async () => {
    const log: string[] = [];
    trackSessionCapture('a', later(1, log, 'boom', true));
    await expect(sessionCaptureFor('a')).resolves.toBeUndefined();
    await expect(whenSessionCapturesSettled()).resolves.toBeUndefined();
  });
});
