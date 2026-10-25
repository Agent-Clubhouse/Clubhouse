import { describe, it, expect, vi } from 'vitest';
import { listenPreferringPort } from './annex-listen';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('listenPreferringPort', () => {
  it('binds the remembered port when it is free', async () => {
    const listen = vi.fn(async (port: number) => port);
    await expect(listenPreferringPort(listen, 53123)).resolves.toBe(53123);
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it.each(['EADDRINUSE', 'EACCES'])('falls back to an OS-chosen port on %s', async (code) => {
    const listen = vi.fn(async (port: number) => {
      if (port === 53123) throw errno(code);
      return 61000;
    });
    await expect(listenPreferringPort(listen, 53123)).resolves.toBe(61000);
    expect(listen.mock.calls).toEqual([[53123], [0]]);
  });

  it('passes other listen errors on without retrying', async () => {
    const listen = vi.fn(async () => { throw errno('EADDRNOTAVAIL'); });
    await expect(listenPreferringPort(listen, 53123)).rejects.toThrow('EADDRNOTAVAIL');
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 70000, 1.5, Number.NaN])('asks for any port when nothing usable was remembered (%s)', async (preferred) => {
    const listen = vi.fn(async () => 61000);
    await expect(listenPreferringPort(listen, preferred)).resolves.toBe(61000);
    expect(listen.mock.calls).toEqual([[0]]);
  });

  it('works against a real server whose remembered port is taken', async () => {
    const net = await import('net');
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const taken = (blocker.address() as { port: number }).port;
    const server = net.createServer();
    const listen = (port: number) => new Promise<number>((resolve, reject) => {
      const onError = (err: Error) => { server.close(); reject(err); };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve((server.address() as { port: number }).port);
      });
    });
    try {
      const bound = await listenPreferringPort(listen, taken);
      expect(bound).toBeGreaterThan(0);
      expect(bound).not.toBe(taken);
    } finally {
      server.close();
      blocker.close();
    }
  });
});
