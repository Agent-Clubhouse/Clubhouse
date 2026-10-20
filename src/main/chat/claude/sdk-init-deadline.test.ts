import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../services/log-service', () => ({ appLog: vi.fn() }));
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSdkTransport, SDK_INIT_TIMEOUT_MS } from './sdk-transport';
import { ClaudeChatDriver } from './driver';
import { ClaudeStartupTimeoutError, type ClaudeTransportOptions } from './transport';
import { clearDriverHealth, PROBE_DEADLINE_MS, probeDriver } from '../../services/agent-runtime/chat-driver-health';

// The Agent SDK is replaced by a fake query: no CLI, no account, no model request.

const OPTS: ClaudeTransportOptions = { binary: '/fake/claude', cwd: '/tmp', permissionMode: 'default' };

/** A query whose event stream stays open until close(); `init` is what initializationResult() returns. */
function fakeQuery(init: () => Promise<unknown>) {
  let finish!: () => void;
  const ended = new Promise<void>((r) => { finish = r; });
  return {
    [Symbol.asyncIterator]: () => ({ next: () => ended.then(() => ({ done: true as const, value: undefined })) }),
    initializationResult: vi.fn(init),
    close: vi.fn(() => finish()),
  };
}

const never = () => new Promise<never>(() => {});
const healthy = async () => ({ commands: [], models: [], claude_code_version: '2.1.300-fake' });

function loaderFor(queries: Array<ReturnType<typeof fakeQuery>>) {
  return async () => ({ query: (() => queries.shift()) as unknown as (a: unknown) => Query });
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
afterEach(() => {
  vi.useRealTimers();
  clearDriverHealth();
});

describe('Claude SDK initialization deadline', () => {
  it('times out a never-settling initialize, closes the query and ends the transport', async () => {
    const q = fakeQuery(never);
    const transport = new ClaudeSdkTransport(OPTS, loaderFor([q]));
    const started = transport.start();
    const outcome = started.then(() => 'resolved', (err: unknown) => err);

    await vi.advanceTimersByTimeAsync(SDK_INIT_TIMEOUT_MS - 1);
    expect(q.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    const err = await outcome;
    expect(err).toBeInstanceOf(ClaudeStartupTimeoutError);
    expect((err as ClaudeStartupTimeoutError).code).toBe('rpc_timeout');
    expect(q.close).toHaveBeenCalledTimes(1);
    // The event stream ends once the query is closed.
    const events: unknown[] = [];
    for await (const ev of transport.events) events.push(ev);
    expect(events.some((e) => (e as { kind: string }).kind === 'initialized')).toBe(false);
    await transport.close();
  });

  it('bounds close() when the query does not end after closing', async () => {
    const q = fakeQuery(never);
    q.close.mockImplementation(() => {});
    const transport = new ClaudeSdkTransport(OPTS, loaderFor([q]));
    const started = transport.start().catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(SDK_INIT_TIMEOUT_MS);
    expect(await started).toBeInstanceOf(ClaudeStartupTimeoutError);
    let closed = false;
    void transport.close().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(closed).toBe(true);
  });

  it('leaves a normal initialize alone', async () => {
    const q = fakeQuery(healthy);
    const transport = new ClaudeSdkTransport(OPTS, loaderFor([q]));
    await transport.start();
    await vi.advanceTimersByTimeAsync(SDK_INIT_TIMEOUT_MS * 2);
    expect(q.close).not.toHaveBeenCalled();
    q.close();
    await transport.close();
  });

  it('fails the driver probe with a classified timeout, closing the transport', async () => {
    const q = fakeQuery(never);
    const driver = new ClaudeChatDriver('claude_agent_sdk', {
      createTransport: (_id, opts) => new ClaudeSdkTransport(opts, loaderFor([q])),
    });
    const probe = driver.probe('/fake/claude');
    await vi.advanceTimersByTimeAsync(SDK_INIT_TIMEOUT_MS);
    expect(await probe).toMatchObject({ handshakeOk: false, errorCode: 'rpc_timeout', error: expect.stringContaining(`${SDK_INIT_TIMEOUT_MS}ms`) });
    expect(q.close).toHaveBeenCalled();
  });

  it('releases every caller sharing the stalled probe, caches nothing, and a later healthy probe runs fresh', async () => {
    const stalled = fakeQuery(never);
    const ok = fakeQuery(healthy);
    const queries = [stalled, ok];
    const driver = new ClaudeChatDriver('claude_agent_sdk', {
      createTransport: (_id, opts) => new ClaudeSdkTransport(opts, loaderFor(queries)),
    });
    // A real file, so a successful probe would be cached: the failure must not be.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-sdk-deadline-'));
    const bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, 'v1');
    const burst = Array.from({ length: 5 }, () => probeDriver(driver, bin));
    await vi.advanceTimersByTimeAsync(SDK_INIT_TIMEOUT_MS);
    const results = await Promise.all(burst);
    expect(results.every((r) => !r.handshakeOk && r.errorCode === 'rpc_timeout')).toBe(true);
    expect(stalled.initializationResult).toHaveBeenCalledTimes(1);

    // Not left in flight or cached: the next probe starts a new query.
    const retry = probeDriver(driver, bin);
    await vi.advanceTimersByTimeAsync(0);
    expect(ok.initializationResult).toHaveBeenCalledTimes(1);
    ok.close();
    expect(await retry).toMatchObject({ handshakeOk: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('bounds a driver probe that never settles at all, for every shared caller', async () => {
    let calls = 0;
    const driver = new ClaudeChatDriver('claude_agent_sdk');
    driver.probe = () => { calls++; return never(); };
    const burst = Array.from({ length: 3 }, () => probeDriver(driver, '/fake/claude'));
    await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS);
    const results = await Promise.all(burst);
    expect(results.every((r) => !r.handshakeOk && r.errorCode === 'rpc_timeout')).toBe(true);
    expect(calls).toBe(1);
    void probeDriver(driver, '/fake/claude');
    expect(calls).toBe(2);
  });
});
