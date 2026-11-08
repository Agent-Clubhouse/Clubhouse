import { describe, expect, it } from 'vitest';
import { describeAction } from './describe';
import { DEFAULT_SUBSCRIPTION_NOTE, isSubscriptionShape, subscriptionStep, suggestSubscriptionName } from './subscription';
import type { EventTrigger } from './types';

const names = { agent: (id: string) => ({ pm: 'pm', lead: 'release-lead' } as Record<string, string>)[id], project: (id: string) => (id === 'p1' ? 'web' : undefined) };
const pushed: EventTrigger = { kind: 'event', event: 'git.remote_updated', source: { kind: 'project', projectId: 'p1' }, branch: 'main' };

describe('subscriptions (#3042)', () => {
  it('suggests a name that says who is told and when', () => {
    expect(suggestSubscriptionName(pushed, 'pm', names)).toBe('Tell pm when web is pushed, pulled or fetched (main)');
    expect(suggestSubscriptionName({ kind: 'event', event: 'agent.slept', source: { kind: 'agent', agentId: 'lead' }, delayMinutes: 30 }, 'pm', names))
      .toBe('Tell pm 30 minutes after release-lead goes to sleep');
    expect(suggestSubscriptionName({ kind: 'event', event: 'agent.idle', source: { kind: 'agent', agentId: 'lead' }, delayMinutes: 60 }, 'pm', names))
      .toBe('Tell pm when release-lead goes idle for 1 hour');
  });

  it('is an event trigger and one message step to the subscriber', () => {
    const steps = [subscriptionStep('pm', '  ')];
    expect(steps).toEqual([{ kind: 'message', agentId: 'pm', text: DEFAULT_SUBSCRIPTION_NOTE }]);
    expect(isSubscriptionShape({ trigger: pushed, steps }, 'pm')).toBe(true);
    expect(isSubscriptionShape({ trigger: pushed, steps }, 'lead')).toBe(false);
    expect(isSubscriptionShape({ trigger: { kind: 'once', at: 1 }, steps }, 'pm')).toBe(false);
    expect(isSubscriptionShape({ trigger: pushed, steps: [...steps, { kind: 'notify', text: 'x' }] }, 'pm')).toBe(false);
  });

  it('reads as "Tell" in the list, the Dispatcher included', () => {
    const steps = [subscriptionStep('pm', 'Tag it.')];
    expect(describeAction({ trigger: pushed, steps, subscription: true }, names)).toBe('When web is pushed, pulled or fetched (main) → Tell pm');
    expect(describeAction({ trigger: pushed, steps }, names)).toBe('When web is pushed, pulled or fetched (main) → Message pm');
    expect(describeAction({ trigger: pushed, steps: [subscriptionStep('disp', undefined)], subscription: true, owner: { kind: 'dispatcher' } }, names))
      .toBe('When web is pushed, pulled or fetched (main) → Tell the Dispatcher');
  });
});
