import { describe, expect, it } from 'vitest';
import type { FederatedRequest } from '../../shared/dispatcher-federation-requests';
import { captureFederationInput, createFederationTurnContext, withFederationInput, onFederationTurnInput, prepareFederationInput } from './dispatcher-federation-context';
import { publishAppEvent } from './app-event-bus';
const input = (id: string) => ({ id } as FederatedRequest);

describe('runtime-delivered federation ancestry', () => {
  it('removes auto-tracking listeners when an agent is deleted before its identity is reused', () => {
    let starts = 0; const stop = onFederationTurnInput((id) => { if (id === 'deleted-agent') starts++; });
    try {
      prepareFederationInput('deleted-agent', input('old'))?.accepted('prompt');
      publishAppEvent({ type: 'agent.deleted', agentId: 'deleted-agent', projectPath: '/fake' });
      prepareFederationInput('deleted-agent', input('new'))?.accepted('prompt');
      publishAppEvent({ type: 'turn.started', agentId: 'deleted-agent', via: 'hook', prompt: true });
      expect(starts).toBe(1);
    } finally { publishAppEvent({ type: 'agent.deleted', agentId: 'deleted-agent', projectPath: '/fake' }); stop(); }
  });
  it('does not leave input metadata on long-lived async tasks created during a wake', async () => {
    let later!: () => void;
    let seen: FederatedRequest | undefined;
    let task!: Promise<void>;
    await withFederationInput(input('wake'), async () => {
      expect(captureFederationInput()).toEqual(input('wake'));
      task = new Promise<void>((resolve) => { later = resolve; }).then(() => { seen = captureFederationInput(); });
    });
    later(); await task;
    expect(seen).toBeUndefined();
  });
  it('tracks a prompt before synchronous tool calls and removes it after its turn', () => {
    const context = createFederationTurnContext();
    const delivery = context.prepare(input('remote'));
    expect(context.inputs()).toEqual([input('remote')]);
    context.start();
    expect(context.inputs()).toEqual([input('remote')]);
    context.end(); delivery.accepted('prompt');
    context.start();
    expect(context.inputs()).toEqual([]);
  });
  it('keeps steered inputs in the current turn and queued inputs in the next', () => {
    const context = createFederationTurnContext(); context.start();
    context.prepare(input('steer')).accepted('steer');
    context.prepare(input('queue')).accepted('queued');
    expect(context.inputs()).toEqual([input('steer')]);
    context.end(); context.start();
    expect(context.inputs()).toEqual([input('queue')]);
    context.end(); context.start(); expect(context.inputs()).toEqual([]);
  });
  it('preserves causation through Stop and a following tool continuation', () => {
    const context = createFederationTurnContext();
    context.prepare(input('remote')).accepted('prompt'); context.start(false, 'hook');
    context.end(); context.start(false, 'hook');
    expect(context.inputs()).toEqual([input('remote')]);
    context.start(true, 'hook'); expect(context.inputs()).toEqual([]);
  });
  it('expires stuck terminal readiness after inactivity while preserving continuation ancestry', () => {
    let now = 1_000; const context = createFederationTurnContext(() => now);
    context.prepare(input('remote')).accepted('prompt'); context.start(false, 'hook');
    expect(context.isOpen()).toBe(true); now += 5 * 60_000 + 1;
    expect(context.isOpen()).toBe(false); expect(context.inputs()).toEqual([input('remote')]);
    context.start(false, 'hook'); expect(context.inputs()).toEqual([input('remote')]);
  });
  it('caps and expires pending input, and replaces hookless prompt history instead of ratcheting', () => {
    let now = 1_000; const context = createFederationTurnContext(() => now);
    for (let i = 0; i < 200; i++) context.prepare(input(`queued-${i}`), 'queued', true).accepted('queued');
    expect(context.inputs()).toHaveLength(30);
    now += 5 * 60_000 + 1; expect(context.isOpen()).toBe(false); expect(context.inputs()).toHaveLength(30);
    context.start(false, 'hook'); expect(context.inputs()).toHaveLength(30);
    context.clear();
    for (let i = 0; i < 200; i++) context.prepare(input(`prompt-${i}`)).accepted('prompt');
    expect(context.inputs()).toEqual([input('prompt-199')]);
    now += 7 * 24 * 60 * 60_000 + 1; expect(context.inputs()).toEqual([]);
  });
  it('combines delivered items and drops refused input and closed sessions', () => {
    const context = createFederationTurnContext();
    context.prepare(input('one')).accepted('prompt');
    context.prepare(input('refused'), 'prompt', true).refused();
    context.prepare(input('two'), 'prompt', true).accepted('woke'); context.start();
    expect(context.inputs()).toEqual([input('one'), input('two')]);
    context.prepare(input('pending')).accepted('queued');
    context.clear(); context.start(); expect(context.inputs()).toEqual([]);
  });
});
