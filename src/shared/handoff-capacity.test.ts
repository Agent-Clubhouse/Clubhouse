import { describe, expect, it } from 'vitest';
import { CAPACITY_PROVIDERS, CAPACITY_WIRE_REQUIRED, capacityForWire, parseHandoffCapacity, type OnlineHandoffCapacity } from './handoff-capacity';
import { parseHandoffCapacity as parseBeforeAntigravity } from './__fixtures__/handoff-capacity-d2b';

const machine = Array(16).fill('aa').join(':');
/** A legacy (three-provider) response, as every peer before #3799 sends. */
const legacy = {
  machine, online: true, sampledAt: 1, lastSeen: 1, agents: { running: 2, sleeping: 3, idleDurable: 4 },
  load: 'medium', disk: 'ample', providers: { 'claude-code': 'unknown', 'copilot-cli': 'available', 'codex-cli': 'limited' },
  accepting_handoffs: true,
} as const;
/** The same, read by this version: Antigravity absent reads unknown. */
const capacity: OnlineHandoffCapacity = { ...legacy, providers: { ...legacy.providers, 'antigravity-cli': 'unknown' } };
const full: OnlineHandoffCapacity = { ...legacy, providers: { ...legacy.providers, 'antigravity-cli': 'limited' } };

describe('bands-only handoff capacity wire schema', () => {
  it('accepts only coarse allowlisted metrics and a minimal offline record', () => {
    expect(parseHandoffCapacity(legacy)).toEqual(capacity);
    expect(parseHandoffCapacity(full)).toEqual(full);
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
    { ...capacity, providers: { ...capacity.providers, 'copilot-cli': { remaining: 5 } } },
    { ...capacity, providers: { 'copilot-cli': 'available' } },
    // A required key missing, or a known optional key malformed.
    { ...legacy, providers: { 'claude-code': 'unknown', 'copilot-cli': 'available' } },
    { ...legacy, providers: { ...legacy.providers, 'antigravity-cli': 'plenty' } },
    { ...legacy, providers: { ...legacy.providers, 'antigravity-cli': null } },
    // Too many unknown extras.
    { ...legacy, providers: { ...legacy.providers, ...Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`x-${i}`, 'available'])) } },
    { machine, online: false, lastSeen: null, accepting_handoffs: false, load: 'low' },
    { machine, online: false, lastSeen: null, accepting_handoffs: true },
  ])('rejects detailed, unrecognized or misleading fields without reflecting them', (raw) => {
    expect(() => parseHandoffCapacity(raw)).toThrow('Invalid capacity response.');
  });
});

describe('capacity provider keys across versions (#3799)', () => {
  it('freezes the legacy keys apart from the tracked set', () => {
    expect(CAPACITY_WIRE_REQUIRED).toEqual(['claude-code', 'copilot-cli', 'codex-cli']);
    expect(CAPACITY_PROVIDERS).toEqual(['claude-code', 'copilot-cli', 'codex-cli', 'antigravity-cli']);
  });

  it('ignores a bounded number of unknown extra keys and never copies them', () => {
    const parsed = parseHandoffCapacity({ ...legacy, providers: { ...legacy.providers, 'gemini-cli': 'available' } });
    expect(parsed).toEqual(capacity);
    expect(JSON.stringify(parsed)).not.toContain('gemini-cli');
  });

  it('projects to exactly the legacy keys, in the legacy byte order, unless the peer agreed', () => {
    const projected = capacityForWire(full, false);
    expect(JSON.stringify(projected)).toBe(JSON.stringify(legacy));
    expect(capacityForWire(full, true)).toBe(full);
    const offline = { machine, online: false as const, lastSeen: null as number | null, accepting_handoffs: false as const };
    expect(capacityForWire(offline, false)).toBe(offline);
  });

  it('every response to a peer without the feature parses on the pre-#3799 parser', () => {
    for (const value of ['available', 'limited', 'unavailable', 'unknown'] as const) {
      const sample: OnlineHandoffCapacity = { ...full, providers: { ...full.providers, 'antigravity-cli': value } };
      const wire = JSON.parse(JSON.stringify(capacityForWire(sample, false)));
      expect(parseBeforeAntigravity(wire)).toEqual(legacy);
    }
  });

  it('a full response would be refused by the pre-#3799 parser, which is why it is gated', () => {
    expect(() => parseBeforeAntigravity(JSON.parse(JSON.stringify(full)))).toThrow('Invalid capacity response.');
  });

  it('round-trips: legacy and full responses both parse on this version', () => {
    for (const agreed of [false, true]) {
      expect(parseHandoffCapacity(JSON.parse(JSON.stringify(capacityForWire(full, agreed)))).online).toBe(true);
    }
    expect(parseHandoffCapacity(JSON.parse(JSON.stringify(capacityForWire(full, false))))).toEqual({ ...full, providers: { ...full.providers, 'antigravity-cli': 'unknown' } });
  });
});
