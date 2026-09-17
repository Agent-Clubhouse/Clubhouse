import { describe, it, expect } from 'vitest';
import { deriveGoobersPanelState } from './panelState';
import type { GoobersConnectionState } from '../../../../shared/goobers-types';

function baseState(overrides: Partial<GoobersConnectionState> = {}): GoobersConnectionState {
  return {
    configured: true,
    instanceRoot: '/Users/cazzone/Repos/goobers-instance',
    rootIdentity: 'eaf74575d8de50fa5471027ba7fd15cb',
    daemon: {
      state: 'running',
      address: '127.0.0.1:8080',
      pid: 1234,
      version: 'portal-v0.1.0-21-ga1b2ae99',
      startedAt: new Date().toISOString(),
      lastTickAgeMillis: 500,
      draining: false,
    },
    connection: 'idle',
    stream: 'unavailable',
    instance: null,
    health: null,
    apiCompatible: true,
    lastError: null,
    lastUpdatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('deriveGoobersPanelState', () => {
  it('not-configured when instanceRoot is empty', () => {
    const state = baseState({ configured: false, instanceRoot: null });
    expect(deriveGoobersPanelState(state, false).kind).toBe('not-configured');
  });

  it('invalid-root on not-a-goobers-instance-root', () => {
    const state = baseState({ connection: 'error', lastError: { code: 'not-a-goobers-instance-root', message: 'not a Goobers instance root' } });
    expect(deriveGoobersPanelState(state, false).kind).toBe('invalid-root');
  });

  it('decommissioned-root on decommissioned-root code', () => {
    const state = baseState({ connection: 'error', lastError: { code: 'decommissioned-root', message: 'decommissioned' } });
    expect(deriveGoobersPanelState(state, false).kind).toBe('decommissioned-root');
  });

  it('binary-not-found on binary-not-found code', () => {
    const state = baseState({ lastError: { code: 'binary-not-found', message: 'not found' } });
    expect(deriveGoobersPanelState(state, true).kind).toBe('binary-not-found');
  });

  it('binary-not-found on binary-not-executable code', () => {
    const state = baseState({ lastError: { code: 'binary-not-executable', message: 'not executable' } });
    expect(deriveGoobersPanelState(state, true).kind).toBe('binary-not-found');
  });

  it('daemon-not-running when manageDaemon is true', () => {
    const state = baseState({ daemon: { ...baseState().daemon, state: 'not-running' } });
    expect(deriveGoobersPanelState(state, true).kind).toBe('daemon-not-running');
  });

  it('daemon-control-off when manageDaemon is false', () => {
    const state = baseState({ daemon: { ...baseState().daemon, state: 'not-running' } });
    expect(deriveGoobersPanelState(state, false).kind).toBe('daemon-control-off');
  });

  it('auth-required on auth-required code', () => {
    const state = baseState({ daemon: { ...baseState().daemon, state: 'running' }, lastError: { code: 'auth-required', message: 'auth' } });
    expect(deriveGoobersPanelState(state, true).kind).toBe('auth-required');
  });

  it('starting when daemon.state is starting', () => {
    const state = baseState({ daemon: { ...baseState().daemon, state: 'starting' } });
    expect(deriveGoobersPanelState(state, true).kind).toBe('starting');
  });

  it('recovering on recovering code, ahead of the plain starting branch, carrying the raw recovery breakdown (M20)', () => {
    const state = baseState({
      daemon: { ...baseState().daemon, state: 'starting' },
      lastError: { code: 'recovering', message: 'daemon is completing crash recovery' },
      recovery: { phase: 'worktree-reap-crash-orphan', since: '2026-09-16T22:58:49.213Z', checks: { apiListening: true, resumeComplete: false } },
    });
    const result = deriveGoobersPanelState(state, true);
    expect(result.kind).toBe('recovering');
    expect(result.error?.code).toBe('recovering');
    expect(result.raw.recovery?.phase).toBe('worktree-reap-crash-orphan');
  });

  it('recovery-stalled falls through to unknown-error, not recovering — requirement 4 (M20)', () => {
    const state = baseState({
      daemon: { ...baseState().daemon, state: 'unknown' },
      connection: 'error',
      lastError: { code: 'recovery-stalled', message: 'daemon has been in startup phase "x" for over 10 minutes without becoming ready' },
    });
    expect(deriveGoobersPanelState(state, true).kind).toBe('unknown-error');
  });

  it('start-failed on daemon-start-failed code', () => {
    const state = baseState({ daemon: { ...baseState().daemon, state: 'not-running' }, lastError: { code: 'daemon-start-failed', message: 'stderr...' } });
    expect(deriveGoobersPanelState(state, true).kind).toBe('start-failed');
  });

  it('start-unknown on daemon-start-unknown code (M17) — distinct from start-failed', () => {
    const state = baseState({
      connection: 'connecting',
      daemon: { ...baseState().daemon, state: 'unknown' },
      lastError: { code: 'daemon-start-unknown', message: 'daemon started but has not become ready after 60s', stderr: 'x', logPathHint: '/root/scheduler' },
    });
    const result = deriveGoobersPanelState(state, true);
    expect(result.kind).toBe('start-unknown');
    expect(result.kind).not.toBe('start-failed');
    expect(result.error?.stderr).toBe('x');
    expect(result.error?.logPathHint).toBe('/root/scheduler');
  });

  it('stopping when daemon.draining is true', () => {
    const state = baseState({ daemon: { ...baseState().daemon, state: 'stopping', draining: true } });
    expect(deriveGoobersPanelState(state, true).kind).toBe('stopping');
  });

  it('stop-failed on daemon-stop-failed code (M14)', () => {
    const state = baseState({ connection: 'error', lastError: { code: 'daemon-stop-failed', message: 'stderr...' } });
    expect(deriveGoobersPanelState(state, true).kind).toBe('stop-failed');
  });

  it('a successful drain (connection still connected, no error) is not mistaken for stop-failed', () => {
    const state = baseState({ connection: 'connected', daemon: { ...baseState().daemon, state: 'stopping', draining: true }, lastError: null });
    expect(deriveGoobersPanelState(state, true).kind).toBe('stopping');
  });

  it('port-mismatch when instance.rootIdentity.id differs from configured rootIdentity', () => {
    const state = baseState({
      connection: 'connected',
      daemon: { ...baseState().daemon, state: 'running' },
      instance: { apiVersion: 'v1', schemaVersion: 'v1', name: 'x', environment: 'dev', instanceRoot: '/x', ready: true, status: 'ready', concurrency: { activeRuns: 0, maxConcurrentRuns: 3 }, counts: { gaggles: 0, goobers: 0, workflows: 0, activeRuns: 0 }, warnings: [], fleetEnrolled: false, rootIdentity: { id: 'different-id' } },
    });
    expect(deriveGoobersPanelState(state, true).kind).toBe('port-mismatch');
  });

  it('port-mismatch on the identity-mismatch code goobers-liveness.ts actually emits', () => {
    const state = baseState({ connection: 'error', lastError: { code: 'identity-mismatch', message: 'mismatch' } });
    expect(deriveGoobersPanelState(state, true).kind).toBe('port-mismatch');
  });

  it('incompatible-api when apiCompatible is false and connected', () => {
    const state = baseState({ connection: 'connected', stream: 'live', apiCompatible: false });
    expect(deriveGoobersPanelState(state, true).kind).toBe('incompatible-api');
  });

  it('ready when connected, live stream, compatible', () => {
    const state = baseState({ connection: 'connected', stream: 'live', apiCompatible: true });
    expect(deriveGoobersPanelState(state, true).kind).toBe('ready');
  });

  it('degraded when connection is degraded', () => {
    const state = baseState({ connection: 'degraded', stream: 'live' });
    expect(deriveGoobersPanelState(state, true).kind).toBe('degraded');
  });

  it('degraded when instance.status is degraded even if connection is connected', () => {
    const state = baseState({
      connection: 'connected',
      stream: 'live',
      instance: { apiVersion: 'v1', schemaVersion: 'v1', name: 'x', environment: 'dev', instanceRoot: '/x', ready: true, status: 'degraded', concurrency: { activeRuns: 0, maxConcurrentRuns: 3 }, counts: { gaggles: 0, goobers: 0, workflows: 0, activeRuns: 0 }, warnings: [], fleetEnrolled: false },
    });
    expect(deriveGoobersPanelState(state, true).kind).toBe('degraded');
  });

  it('stream-reconnecting when stream is reconnecting', () => {
    const state = baseState({ connection: 'connected', stream: 'reconnecting' });
    expect(deriveGoobersPanelState(state, true).kind).toBe('stream-reconnecting');
  });

  it('polling-fallback when stream is polling', () => {
    const state = baseState({ connection: 'connected', stream: 'polling' });
    expect(deriveGoobersPanelState(state, true).kind).toBe('polling-fallback');
  });

  it('no-read-model when stream is unavailable while connected', () => {
    const state = baseState({ connection: 'connected', stream: 'unavailable' });
    expect(deriveGoobersPanelState(state, true).kind).toBe('no-read-model');
  });

  it('connecting when connection is connecting', () => {
    const state = baseState({ connection: 'connecting' });
    expect(deriveGoobersPanelState(state, true).kind).toBe('connecting');
  });

  it('unknown-error on an unrecognized error code (must not crash)', () => {
    const state = baseState({ connection: 'error', lastError: { code: 'some-brand-new-m3-error', message: 'unexpected' } });
    const result = deriveGoobersPanelState(state, true);
    expect(result.kind).toBe('unknown-error');
    expect(result.error?.code).toBe('some-brand-new-m3-error');
  });

  it('falls back to connecting for an unrecognized connection value shape (defensive default)', () => {
    const state = baseState({ connection: 'idle', daemon: { ...baseState().daemon, state: 'unknown' } });
    const result = deriveGoobersPanelState(state, true);
    expect(result.kind).toBe('connecting');
  });
});
