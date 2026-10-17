import { describe, expect, it, vi } from 'vitest';
import { ATTR } from './attributes';
import { createPersistSignals } from './persist-signals';

function fakeTel() {
  return { count: vi.fn(), event: vi.fn() };
}

describe('persistence signals', () => {
  it('counts writes and their duration by store and result', async () => {
    const tel = fakeTel();
    const persist = createPersistSignals(tel);
    await persist.timed('agents', async () => 'done');
    expect(tel.count).toHaveBeenCalledWith('clubhouse.persist.writes', 1, [ATTR.persistStore('agents'), ATTR.persistResult('ok')]);
    expect(tel.count).toHaveBeenCalledWith('clubhouse.persist.write.duration', expect.any(Number), [ATTR.persistStore('agents')]);
  });

  it('records a failed write and rethrows the original error', async () => {
    const tel = fakeTel();
    const persist = createPersistSignals(tel);
    const err = new Error('ENOSPC');
    await expect(persist.timed('projects', async () => {
      throw err;
    })).rejects.toBe(err);
    expect(tel.count).toHaveBeenCalledWith('clubhouse.persist.writes', 1, [ATTR.persistStore('projects'), ATTR.persistResult('failed')]);
  });

  it('emits recovery events', () => {
    const tel = fakeTel();
    createPersistSignals(tel).recovery('canvas', 'restored_from_backup');
    expect(tel.event).toHaveBeenCalledWith('clubhouse.persist.recovery', [ATTR.persistStore('canvas'), ATTR.persistAction('restored_from_backup')]);
  });

  it('counts every guard block but sends the event once per store and reason', () => {
    const tel = fakeTel();
    const persist = createPersistSignals(tel);
    for (let i = 0; i < 5; i++) persist.guardBlocked('canvas', 'not_hydrated');
    persist.guardBlocked('canvas', 'verify_empty');
    expect(tel.count).toHaveBeenCalledTimes(6);
    expect(tel.event).toHaveBeenCalledTimes(2);
  });

  it('never throws into the write path, even if telemetry does', async () => {
    const tel = { count: vi.fn(() => { throw new Error('x'); }), event: vi.fn(() => { throw new Error('y'); }) };
    const persist = createPersistSignals(tel);
    await expect(persist.timed('settings', async () => 1)).resolves.toBe(1);
    expect(() => persist.recovery('settings', 'reset_to_default')).not.toThrow();
    expect(() => persist.guardBlocked('canvas', 'not_hydrated')).not.toThrow();
    expect(() => persist.barrierWait('agents', 10)).not.toThrow();
  });
});
