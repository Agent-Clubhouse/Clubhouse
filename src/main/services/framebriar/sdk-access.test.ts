/** Vendored access controller, simulated transport/storage. No hosted credentials or OS keyring. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCESS_TIMEOUT_MS, createAccess } from '../../vendor/framebriar/adapters/node/access.mjs';

const INVITE = 'i'.repeat(43);
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-17T19:00:00Z');
const grant = (overrides = {}) => ({
  v: 1, gameId: 'clubhouse', scopeVersion: 2,
  token: 't'.repeat(43), refreshToken: 'r'.repeat(43),
  expiresAt: new Date(NOW + 3_600_000).toISOString(),
  refreshExpiresAt: new Date(NOW + 30 * DAY).toISOString(), ...overrides,
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});

type Saved = { revision: string; session: unknown; notice: unknown };
function memoryStore() {
  let saved: Saved = { revision: 'missing', session: null, notice: null };
  let revision = 0;
  return {
    read: async () => structuredClone(saved),
    replace: async (expected: string, next: Omit<Saved, 'revision'>) => {
      if (expected !== saved.revision) return { ok: false };
      saved = { ...structuredClone(next), revision: String(++revision) };
      return { ok: true, revision: saved.revision };
    },
  };
}

const active: Array<ReturnType<typeof createAccess>> = [];
function access(fetchImpl: typeof fetch, retryDelay = vi.fn(async (_ms: number) => {}), store = memoryStore()) {
  const controller = createAccess({
    appId: 'clubhouse', endpoint: 'https://framebriar.test/api', store, fetchImpl,
    retryDelay, now: () => NOW, setTimer: () => undefined, clearTimer: () => {},
  });
  active.push(controller);
  return { controller, store, retryDelay };
}
afterEach(() => { active.splice(0).forEach((a) => a.dispose()); vi.useRealTimers(); });

describe('Framebriar SDK access drop', () => {
  it('retries transient failures twice after 2/5 seconds with one attempt id, then retains uncertainty', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline'));
    const { controller, store, retryDelay } = access(fetchImpl);
    await controller.start();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await controller.connect(INVITE)).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(retryDelay.mock.calls).toEqual([[2000], [5000]]);
    const requests = fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init!.body)));
    expect(requests[0]).toMatchObject({ v: 1, gameId: 'clubhouse', scopeVersion: 2, buildSha: null });
    expect(requests[0].attemptId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(new Set(requests.map((r) => r.attemptId)).size).toBe(1);
    expect(controller.status()).toMatchObject({ state: 'connection-uncertain', canCapture: false, enrolled: false });
    expect(await controller.getToken()).toBeUndefined();
    expect(JSON.stringify(await store.read())).not.toContain(INVITE);
    expect(JSON.stringify(await store.read())).not.toContain(requests[0].attemptId);

    // An explicit retry recovers the same attempt; a restart never redeems by itself.
    fetchImpl.mockResolvedValue(json(grant()));
    expect(await controller.connect(INVITE)).toBe(true);
    expect(JSON.parse(String(fetchImpl.mock.calls[3][1]!.body)).attemptId).toBe(requests[0].attemptId);
    expect(controller.status()).toMatchObject({ connected: true, expiresAt: grant().refreshExpiresAt });
    expect(await controller.getToken()).toBe(grant().token);
  });

  it('persists uncertainty across restart without automatically retrying the invitation', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline'));
    const { controller, store } = access(fetchImpl);
    await controller.connect(INVITE);
    controller.dispose();
    fetchImpl.mockClear();
    const restarted = access(fetchImpl, undefined, store).controller;
    await restarted.start();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(restarted.status()).toMatchObject({ notice: 'connection-uncertain', enrolled: false });
  });

  it('recovers a redeemed invitation after a temporary enrollment storage failure', async () => {
    const backing = memoryStore();
    let failSessionWrite = true;
    const store = {
      read: backing.read,
      replace: async (expected: string, next: Omit<Saved, 'revision'>) => {
        if (next.session && failSessionWrite) {
          failSessionWrite = false;
          throw new Error('Temporary secure-store failure');
        }
        return backing.replace(expected, next);
      },
    };
    let redeemedAttempt: string | undefined;
    let enrollments = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const { attemptId } = JSON.parse(String(init!.body));
      // A single-use issuer can recover the original attempt, but cannot spend another use.
      if (!redeemedAttempt) { redeemedAttempt = attemptId; enrollments++; }
      return attemptId === redeemedAttempt ? json(grant()) : json({}, 401);
    });
    const { controller } = access(fetchImpl, undefined, store);
    expect(await controller.connect(INVITE)).toBe(false);
    expect(controller.status()).toMatchObject({ state: 'storage-unavailable', connected: false });
    expect((await store.read()).session).toBeNull();

    expect(await controller.connect(INVITE)).toBe(true);
    expect(controller.status().connected).toBe(true);
    expect(await controller.getToken()).toBe(grant().token);
    expect((await store.read()).session).toBeTruthy();
    expect(enrollments).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const attempts = fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init!.body)).attemptId);
    expect(attempts[0]).toBe(attempts[1]);
  });

  it.each([401, 403])('does not retry a server refusal (%s)', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({}, status));
    const { controller, retryDelay } = access(fetchImpl);
    expect(await controller.connect(INVITE)).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(retryDelay).not.toHaveBeenCalled();
    expect(controller.status()).toMatchObject({ state: 'access-required', enrolled: false });
  });

  it('allows a 12-second cold start and gives redeem, refresh and disconnect 45 seconds each', async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const c = new AbortController();
      setTimeout(() => c.abort(), ms);
      return c.signal;
    });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce((_url, init) => new Promise((resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
      setTimeout(() => resolve(json(grant())), 12_000);
    })).mockImplementation(async (url) => json(String(url).endsWith('/disconnect') ? { v: 1, disconnected: true } : grant()));
    const { controller } = access(fetchImpl);
    const connecting = controller.connect(INVITE);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(controller.status().state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(await connecting).toBe(true);
    await controller.refresh();
    expect(await controller.disconnect()).toEqual({ forgotten: true, revoked: true });
    expect(ACCESS_TIMEOUT_MS).toBe(45_000);
    expect(timeout.mock.calls).toEqual([[45_000], [45_000], [45_000]]);
  });

  it('bounds a hanging redeem by 45 seconds and retries the same attempt', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const c = new AbortController();
      setTimeout(() => c.abort(), ms);
      return c.signal;
    });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
    })).mockResolvedValue(json(grant()));
    const { controller, retryDelay } = access(fetchImpl);
    const connecting = controller.connect(INVITE);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await connecting).toBe(true);
    expect(retryDelay.mock.calls).toEqual([[2000]]);
    const attempts = fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init!.body)).attemptId);
    expect(attempts[0]).toBe(attempts[1]);
  });

  it('stops retrying if the app shuts down during backoff', async () => {
    let resume!: () => void;
    const retryDelay = vi.fn(() => new Promise<void>((resolve) => { resume = resolve; }));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({}, 503));
    const { controller } = access(fetchImpl, retryDelay);
    const connecting = controller.connect(INVITE);
    await vi.waitFor(() => expect(retryDelay).toHaveBeenCalledOnce());
    controller.stop();
    resume();
    expect(await connecting).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(controller.status().connected).toBe(false);
  });

  it.each([
    { gameId: 'other-app' },
    { expiresAt: new Date(NOW + 3_600_001).toISOString() },
    { refreshExpiresAt: new Date(NOW + 30 * DAY + 1).toISOString() },
  ])('still rejects grants outside app/one-hour/30-day contracts: %j', async (invalid) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(grant(invalid)));
    const { controller, retryDelay } = access(fetchImpl);
    expect(await controller.connect(INVITE)).toBe(false);
    expect(await controller.getToken()).toBeUndefined();
    expect(retryDelay).not.toHaveBeenCalled();
  });
});
