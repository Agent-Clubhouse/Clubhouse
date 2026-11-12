import { describe, expect, it } from 'vitest';
import { parseHandoffCapacity, type OnlineHandoffCapacity } from './handoff-capacity';

const machine = Array(16).fill('aa').join(':');
const capacity: OnlineHandoffCapacity = {
  machine, online: true, sampledAt: 1, lastSeen: 1, agents: { running: 2, sleeping: 3, idleDurable: 4 },
  load: 'medium', disk: 'ample', providers: { 'claude-code': 'unknown', 'copilot-cli': 'available', 'codex-cli': 'limited' },
  accepting_handoffs: true,
};

describe('bands-only handoff capacity wire schema', () => {
  it('accepts only coarse allowlisted metrics and a minimal offline record', () => {
    expect(parseHandoffCapacity(capacity)).toEqual(capacity);
    expect(parseHandoffCapacity({ machine, online: false, lastSeen: null, accepting_handoffs: false })).toEqual({
      machine, online: false, lastSeen: null, accepting_handoffs: false,
    });
  });

  it.each([
    { ...capacity, hostname: 'private-host' },
    { ...capacity, username: 'private-user' },
    { ...capacity, path: '/private/project' },
    { ...capacity, processes: ['private-command'] },
    { ...capacity, cpuPercent: 33 },
    { ...capacity, load: 0.3 },
    { ...capacity, disk: { freeBytes: 123 } },
    { ...capacity, agents: { ...capacity.agents, names: ['private-agent'] } },
    { ...capacity, providers: { ...capacity.providers, 'other-provider': 'available' } },
    { ...capacity, providers: { ...capacity.providers, 'copilot-cli': { remaining: 5 } } },
    { ...capacity, providers: { 'copilot-cli': 'available' } },
    { machine, online: false, lastSeen: null, accepting_handoffs: false, load: 'low' },
    { machine, online: false, lastSeen: null, accepting_handoffs: true },
  ])('rejects detailed, unrecognized or misleading fields without reflecting them', (raw) => {
    expect(() => parseHandoffCapacity(raw)).toThrow('Invalid capacity response.');
  });
});
