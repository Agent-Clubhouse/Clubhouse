import { describe, expect, it } from 'vitest';
import type { FederatedRequest } from '../../shared/dispatcher-federation-requests';
import { captureFederationInput, createFederationTurnContext, withFederationInput } from './dispatcher-federation-context';
const input = (id: string) => ({ id } as FederatedRequest);

describe('runtime-delivered federation ancestry', () => {
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
  it('combines delivered items and drops refused input and closed sessions', () => {
    const context = createFederationTurnContext();
    context.prepare(input('one')).accepted('prompt');
    context.prepare(input('refused')).refused();
    context.prepare(input('two')).accepted('woke'); context.start();
    expect(context.inputs()).toEqual([input('one'), input('two')]);
    context.prepare(input('pending')).accepted('queued');
    context.clear(); context.start(); expect(context.inputs()).toEqual([]);
  });
});
