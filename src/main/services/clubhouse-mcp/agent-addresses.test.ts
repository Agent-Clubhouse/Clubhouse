import { describe, it, expect, vi } from 'vitest';

const SELF = Array.from({ length: 16 }, () => '01').join(':');
const OTHER = Array.from({ length: 16 }, () => 'ab').join(':');

vi.mock('../annex-identity', () => ({ getIdentity: vi.fn(() => ({ fingerprint: SELF.toUpperCase() })) }));

import { localizeAgentArgs } from './agent-addresses';
import * as annexIdentity from '../annex-identity';
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
      message: "That agent is on another machine. Agents on other machines can't be reached from here yet.",
    });
    expect(localizeAgentArgs(grant, { agent_ids: ['durable_b', `durable_a@${OTHER}`] })).toMatchObject({ otherMachine: OTHER });
  });

  it('does nothing for a tool whose grant names no agent argument', () => {
    const none = { actions: ['project.read'], target: 'project' } as unknown as ToolGrant;
    const args = { agent_id: `durable_a@${OTHER}` };
    expect(localizeAgentArgs(none, args)).toEqual({ args });
    expect(localizeAgentArgs(undefined, args)).toEqual({ args });
  });

  it('covers the other agent targets: wire calls, connections, group members and helpers', () => {
    expect(localizeAgentArgs('called_tool' as ToolGrant, { target: `durable_a@${SELF}`, tool: 'x' })).toEqual({ args: { target: 'durable_a', tool: 'x' } });
    const connect = { actions: ['connection.manage'], target: 'agent_arg' } as unknown as ToolGrant;
    expect(localizeAgentArgs(connect, { from: `a@${SELF}`, to: `b@${SELF}` })).toEqual({ args: { from: 'a', to: 'b' } });
    const group = { actions: ['agent.message'], target: 'group_members' } as unknown as ToolGrant;
    expect(localizeAgentArgs(group, { target_agent_id: `a@${OTHER}` })).toMatchObject({ otherMachine: OTHER });
    const helpers = { actions: ['agent.read'], target: 'my_helpers' } as unknown as ToolGrant;
    expect(localizeAgentArgs(helpers, { helper: `h@${SELF}` })).toEqual({ args: { helper: 'h' } });
  });

  it("reads this machine's identity only when a reference names a machine", () => {
    vi.mocked(annexIdentity.getIdentity).mockClear();
    localizeAgentArgs(grant, { agent_id: 'durable_a' });
    expect(annexIdentity.getIdentity).not.toHaveBeenCalled();
  });
});
