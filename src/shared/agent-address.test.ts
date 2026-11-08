import { describe, it, expect } from 'vitest';
import {
  addressFromNamespacedId,
  formatAgentAddress,
  localizeAgentReference,
  namespacedIdFromAddress,
  parseAgentAddress,
  routeOf,
} from './agent-address';

const M = Array.from({ length: 16 }, () => 'ab').join(':');
const SELF = Array.from({ length: 16 }, () => '01').join(':');

describe('machine-qualified agent addresses (#3063)', () => {
  it.each([
    ['durable_abc', { agentId: 'durable_abc' }],
    [`durable_abc@${M}`, { agentId: 'durable_abc', machine: M }],
    [`durable_abc@${M.toUpperCase()}`, { agentId: 'durable_abc', machine: M }],
    ['quick_1@not-a-machine', { agentId: 'quick_1@not-a-machine' }],
    ['@' + M, { agentId: '@' + M }],
    ['', { agentId: '' }],
  ])('reads %j', (reference, expected) => {
    expect(parseAgentAddress(reference)).toEqual(expected);
  });

  it('round-trips with and without a machine', () => {
    for (const address of [{ agentId: 'durable_abc' }, { agentId: 'durable_abc', machine: M }]) {
      expect(parseAgentAddress(formatAgentAddress(address))).toEqual(address);
    }
    expect(formatAgentAddress({ agentId: 'a', machine: M.toUpperCase() })).toBe(`a@${M}`);
  });

  it('routes a reference with no machine, or this machine, here, and anything else to its machine', () => {
    expect(routeOf({ agentId: 'a' }, SELF)).toEqual({ local: true });
    expect(routeOf({ agentId: 'a', machine: SELF }, SELF.toUpperCase())).toEqual({ local: true });
    expect(routeOf({ agentId: 'a', machine: M }, SELF)).toEqual({ local: false, machine: M });
    expect(routeOf({ agentId: 'a', machine: M }, undefined)).toEqual({ local: false, machine: M });
  });

  it('localizes a reference to this machine, and leaves others as they are', () => {
    expect(localizeAgentReference(`a@${SELF}`, SELF)).toBe('a');
    expect(localizeAgentReference('a', SELF)).toBe('a');
    expect(localizeAgentReference(`a@${M}`, SELF)).toBe(`a@${M}`);
  });

  it('converts to and from the renderer\'s namespaced ids', () => {
    expect(addressFromNamespacedId(`remote||${M}||durable_abc`)).toEqual({ agentId: 'durable_abc', machine: M });
    expect(addressFromNamespacedId('durable_abc')).toBeNull();
    expect(addressFromNamespacedId('remote||broken')).toBeNull();
    expect(namespacedIdFromAddress({ agentId: 'durable_abc', machine: M })).toBe(`remote||${M}||durable_abc`);
    expect(namespacedIdFromAddress({ agentId: 'durable_abc' })).toBe('durable_abc');
    expect(addressFromNamespacedId(namespacedIdFromAddress({ agentId: 'x', machine: M }))).toEqual({ agentId: 'x', machine: M });
  });
});
