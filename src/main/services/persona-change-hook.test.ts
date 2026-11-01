/** Persona change listeners (#2537) hear every change once the hook is done. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  notifyPersonaChanged,
  notifyProjectDefaultPersonaChanged,
  onPersonaChanged,
  setPersonaChangeHook,
} from './persona-change-hook';

afterEach(() => {
  setPersonaChangeHook(null);
});

describe('onPersonaChanged', () => {
  it('runs listeners after the hook, for both kinds of change', async () => {
    const order: string[] = [];
    setPersonaChangeHook(async () => { order.push('hook'); });
    const stop = onPersonaChanged((change) => { order.push(`listener:${change.kind}`); });
    await notifyPersonaChanged('p', 'a', undefined);
    await notifyProjectDefaultPersonaChanged('p', 'old');
    stop();
    await notifyPersonaChanged('p', 'a', undefined);
    expect(order).toEqual(['hook', 'listener:agent', 'hook', 'listener:project-default', 'hook']);
  });

  it('still tells listeners when the hook fails, and passes the failure on', async () => {
    setPersonaChangeHook(async () => { throw new Error('boom'); });
    const listener = vi.fn();
    const stop = onPersonaChanged(listener);
    await expect(notifyPersonaChanged('p', 'a', undefined)).rejects.toThrow('boom');
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });

  it('a listener that throws does not fail the change', async () => {
    const stop = onPersonaChanged(() => { throw new Error('bad listener'); });
    await expect(notifyPersonaChanged('p', 'a', undefined)).resolves.toBeUndefined();
    stop();
  });
});
