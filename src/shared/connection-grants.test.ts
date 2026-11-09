import { describe, expect, it } from 'vitest';
import {
  CONNECTION_SWITCHES, WAKE_TOOL, localDirectionTools, localToolsFromAllow, localWakeOn, normalizeConnectionDirection,
} from './connection-grants';

const A = { agentId: 'a' };
const B = { agentId: 'b' };

describe('wake on a direction (#3215)', () => {
  it('is off with no entry, with an entry saved before the switch, and when turned off', () => {
    expect(localWakeOn(undefined)).toBe(false);
    expect(localWakeOn({ disabledTools: [] })).toBe(false);
    expect(localWakeOn({ disabledTools: [WAKE_TOOL], enabledTools: [WAKE_TOOL] })).toBe(false);
    expect(localWakeOn({ disabledTools: [], enabledTools: [WAKE_TOOL] })).toBe(true);
  });

  it('is the last switch, labeled as across machines', () => {
    expect(CONNECTION_SWITCHES.at(-1)).toEqual({ tool: 'wake_agent', action: 'agent.wake', label: 'Wake it' });
  });

  it('reads back every switch, a direction with no entry taking its source\'s list', () => {
    expect(localDirectionTools(undefined, ['clear_agent'])).toEqual({
      allowed: ['get_status', 'read_output', 'check_connectivity', 'send_message', 'send_file', 'compact_agent'],
      disabled: ['clear_agent', 'wake_agent'],
    });
  });

  it('turns an allow list into a direction: every connection tool left out is off, wake only when named', () => {
    expect(localToolsFromAllow(['get_status', 'read_output', 'send_message', 'wake_agent'])).toEqual({
      disabledTools: ['check_connectivity', 'send_file', 'clear_agent', 'compact_agent'],
      enabledTools: ['wake_agent'],
    });
    expect(localToolsFromAllow([])).toEqual({ disabledTools: CONNECTION_SWITCHES.filter((t) => t.tool !== WAKE_TOOL).map((t) => t.tool), enabledTools: [] });
    const round = localToolsFromAllow(['send_message', 'wake_agent']);
    expect(localDirectionTools(round).allowed).toEqual(['send_message', 'wake_agent']);
  });

  it('keeps enabledTools and setBy through a save and read back, and drops a setBy it doesn\'t know', () => {
    const d = normalizeConnectionDirection({ from: A, to: B, disabledTools: [], enabledTools: [WAKE_TOOL, WAKE_TOOL, 7], setBy: 'dispatcher', updatedAt: 't' });
    expect(d).toEqual({ from: A, to: B, disabledTools: [], enabledTools: [WAKE_TOOL], setBy: 'dispatcher', updatedAt: 't' });
    expect(normalizeConnectionDirection({ from: A, to: B, disabledTools: [], setBy: 'agent', updatedAt: 't' })).toEqual({ from: A, to: B, disabledTools: [], updatedAt: 't' });
  });
});
