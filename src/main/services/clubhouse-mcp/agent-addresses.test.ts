import { describe, it, expect, vi } from 'vitest';

const SELF = Array.from({ length: 16 }, () => '01').join(':');
const OTHER = Array.from({ length: 16 }, () => 'ab').join(':');

vi.mock('../annex-identity', () => ({ getIdentity: vi.fn(() => ({ fingerprint: SELF.toUpperCase() })) }));
vi.mock('../annex-peers', () => ({ getPeer: vi.fn((fp: string) => (fp === OTHER ? { alias: 'Studio' } : undefined)) }));

import { localizeAgentArgs } from './agent-addresses';
import type { ToolGrant } from './tool-grants';

const grant = { actions: ['agent.message'], target: 'agent_arg', from: { args: ['agent_id', 'agent_ids'] } } as unknown as ToolGrant;

describe('machine-qualified agents in tool calls (#3063)', () => {
  it('makes this machine\'s addresses bare ids, singly and in lists, and leaves other arguments alone', () => {
    expect(localizeAgentArgs(grant, { agent_id: `durable_a@${SELF}`, agent_ids: ['durable_b', `durable_c@${SELF}`], message: 'hi@there' })).toEqual({
      args: { agent_id: 'durable_a', agent_ids: ['durable_b', 'durable_c'], message: 'hi@there' },
    });
  });

  it('keeps plain ids as they are', () => {
    expect(localizeAgentArgs(grant, { agent_id: 'durable_a' })).toEqual({ args: { agent_id: 'durable_a' } });
  });

  it('refuses an agent on another machine, naming the machine', () => {
    expect(localizeAgentArgs(grant, { agent_id: `durable_a@${OTHER}` })).toEqual({
      otherMachine: OTHER,
      message: "That agent is on another machine (Studio). Agents on other machines can't be reached from here yet.",
    });
    expect(localizeAgentArgs(grant, { agent_ids: ['durable_b', `durable_a@${OTHER}`] })).toMatchObject({ otherMachine: OTHER });
  });

  it('does nothing for a tool whose grant names no agent argument', () => {
    const none = { actions: ['project.read'], target: 'project' } as unknown as ToolGrant;
    const args = { agent_id: `durable_a@${OTHER}` };
    expect(localizeAgentArgs(none, args)).toEqual({ args });
    expect(localizeAgentArgs(undefined, args)).toEqual({ args });
  });
});
