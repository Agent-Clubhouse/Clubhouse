import { describe, it, expect, vi, beforeEach } from 'vitest';

const { made } = vi.hoisted(() => ({
  made: [] as Array<{ errorCallback?: (err: unknown) => void; server: { mdns: import('events').EventEmitter } }>,
}));

vi.mock('bonjour-service', async () => {
  const { EventEmitter: Emitter } = await import('events');
  class FakeBonjour {
    errorCallback?: (err: unknown) => void;
    server = { mdns: new Emitter() };
    constructor(_opts: unknown, errorCallback?: (err: unknown) => void) {
      this.errorCallback = errorCallback;
      made.push(this);
    }
  }
  return { default: FakeBonjour };
});
vi.mock('./log-service', () => ({ appLog: vi.fn() }));

import { createBonjour, resetMdnsLogForTests } from './annex-mdns';
import { appLog } from './log-service';

function sendError(code: string): Error {
  return Object.assign(new Error(`send ${code} 224.0.0.251:5353`), { code });
}

describe('annex mDNS (#1921)', () => {
  beforeEach(() => {
    made.length = 0;
    vi.clearAllMocks();
    resetMdnsLogForTests();
  });

  it('gives bonjour an error callback, so a failed send is logged at warn instead of thrown', () => {
    const onError = vi.fn();
    createBonjour('advertise', onError);
    expect(made[0].errorCallback).toBeTypeOf('function');
    expect(() => made[0].errorCallback!(sendError('EADDRNOTAVAIL'))).not.toThrow();
    expect(onError).toHaveBeenCalledWith({ fatal: false, code: 'EADDRNOTAVAIL' });
    expect(appLog).toHaveBeenCalledWith('core:annex', 'warn', 'mDNS send failed', expect.objectContaining({
      meta: expect.objectContaining({ role: 'advertise', code: 'EADDRNOTAVAIL' }),
    }));
  });

  it('listens for the socket error a failed bind emits, which would otherwise throw, and calls it fatal', () => {
    const onError = vi.fn();
    createBonjour('discover', onError);
    expect(() => made[0].server.mdns.emit('error', sendError('EADDRINUSE'))).not.toThrow();
    expect(onError).toHaveBeenCalledWith({ fatal: true, code: 'EADDRINUSE' });
  });

  it('reports socket warnings without calling them fatal', () => {
    const onError = vi.fn();
    createBonjour('discover', onError);
    made[0].server.mdns.emit('warning', sendError('ENETUNREACH'));
    expect(onError).toHaveBeenCalledWith({ fatal: false, code: 'ENETUNREACH' });
  });

  it('logs the same error once a minute, however often it happens', () => {
    createBonjour('advertise');
    for (let i = 0; i < 20; i++) made[0].errorCallback!(sendError('EADDRNOTAVAIL'));
    expect(appLog).toHaveBeenCalledTimes(1);
  });

  it('never throws out of a socket callback, even when its handler does', () => {
    createBonjour('advertise', () => { throw new Error('handler failed'); });
    expect(() => made[0].errorCallback!(sendError('EHOSTDOWN'))).not.toThrow();
  });
});
