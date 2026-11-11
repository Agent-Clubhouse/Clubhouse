/**
 * Wake on a connection between two agents on this computer (#3215): a
 * per-direction switch, off by default, through the real tool registry, agent
 * tools, grant check, connection store and permissions store. Only the
 * agents' runtimes, the wake itself and the Ask first request are faked.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ base: '' }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => state.base }, BrowserWindow: { getAllWindows: () => [] } }));
state.base = fs.mkdtempSync(path.join(os.tmpdir(), 'local-wake-'));

// What the gate decides is covered in mcp-call-gate.test.ts and test/mcp-off.
vi.mock('./mcp-call-gate', async (original) => ({ ...await original<typeof import('./mcp-call-gate')>(), mcpCallAccess: () => 'open' }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../dispatcher/dispatcher-settings', () => ({ isDispatcherEnabled: () => true }));
const running = vi.hoisted(() => new Set<string>());
vi.mock('../agent-registry', () => ({
  agentRegistry: { get: (id: string) => (running.has(id) ? { runtime: 'pty', projectPath: '/p' } : undefined) },
  getAgentNonce: vi.fn(),
  getAgentProjectPath: () => '/p',
}));
const lifecycle = vi.hoisted(() => ({ sleepAgent: vi.fn(), wakeWiredAgent: vi.fn() }));
vi.mock('./tools/agent-lifecycle', () => lifecycle);
const ask = vi.hoisted(() => ({ askFirst: vi.fn() }));
vi.mock('./ask-first', () => ask);

import { registerAgentTools } from './tools/agent-tools';
import { buildToolName, callTool, getScopedToolList, refusalReasonOf, _resetForTesting as resetTools } from './tool-registry';
import { mcpAdapter } from './mcp-adapter';
import { bindingManager } from './binding-manager';
import { setDispatcherAgent, setDispatcherChatAgent, _resetDispatcherGateForTesting } from './dispatcher-gate';
import { setMcpCaller, _resetMcpCallGateForTesting } from './mcp-call-gate';
import { updateAgentGrantChanges } from '../agent-grants-store';
import { removeConnectionDirections, setConnectionDirections, setConnectionTools, getConnectionDirection } from '../connection-grants-store';
import { markBindingRemovedByUser } from '../persisted-bindings';
import { applyConnectionTools, readLocalDirectionTools, setLocalWake, startConnectionGrants } from '../connection-grants';
import { AUTOMATIC_CONNECTION_SWITCHES, EVERY_SWITCH_ON, type StartingSwitches } from '../../../shared/connection-grants';
import type { McpBinding } from './types';

const wire = (agentId: string, targetId: string): McpBinding => ({ agentId, targetId, targetKind: 'agent', label: targetId, targetName: targetId, projectName: 'app' });
const suffixes = (agentId: string, targetId: string) =>
  getScopedToolList(agentId).filter((t) => t.name.startsWith(`${buildToolName(wire(agentId, targetId), '')}`)).map((t) => t.name.split('__').pop());
const call = (agentId: string, targetId: string, suffix: string, args: Record<string, unknown> = {}) => callTool(agentId, buildToolName(wire(agentId, targetId), suffix), args);
const WAKE_ON = { kind: 'connected' as const, wakeOn: true };
let stop: () => void = () => {};

beforeEach(async () => {
  resetTools();
  mcpAdapter._resetForTesting();
  bindingManager._resetForTesting?.();
  _resetDispatcherGateForTesting();
  _resetMcpCallGateForTesting();
  for (const id of ['a', 'b', 'dispatcher', 'chat']) await removeConnectionDirections(id);
  for (const id of ['a', 'b']) await updateAgentGrantChanges(id, () => undefined);
  stop = startConnectionGrants();
  registerAgentTools();
  setMcpCaller('a', '/p', {});
  setMcpCaller('b', '/p', {});
  setMcpCaller('dispatcher', '/p', {});
  setDispatcherAgent('dispatcher', true);
  running.clear();
  running.add('a');
  lifecycle.wakeWiredAgent.mockReset().mockResolvedValue({ content: [{ type: 'text', text: 'running' }] });
  lifecycle.sleepAgent.mockReset().mockResolvedValue({ content: [{ type: 'text', text: 'sleeping' }] });
  ask.askFirst.mockReset().mockResolvedValue({ kind: 'asked', text: 'Asked the user first.', created: true });
  // Two orchestrators, a to b and back, as a link the Dispatcher made or a canvas wire draws.
  bindingManager.bind('a', wire('a', 'b'));
  bindingManager.bind('b', wire('b', 'a'));
});
afterEach(() => { stop(); _resetDispatcherGateForTesting(); });

describe('wake on a local connection (#3215)', () => {
  it('is off by default: a sleeping target lists get_status but not wake_agent, and a call is refused', async () => {
    expect(suffixes('a', 'b')).toContain('get_status');
    expect(suffixes('a', 'b')).not.toContain('wake_agent');
    const refused = await call('a', 'b', 'wake_agent');
    expect(refused.isError).toBe(true);
    expect(refusalReasonOf(refused)).toBe('tool_denied');
    expect(refused.content[0].text).toContain('Wake it');
    expect(lifecycle.wakeWiredAgent).not.toHaveBeenCalled();
  });

  it('stays off for a direction saved before the switch existed', async () => {
    await setConnectionTools({ agentId: 'a' }, { agentId: 'b' }, ['clear_agent', 'compact_agent']);
    expect(suffixes('a', 'b')).not.toContain('wake_agent');
    expect((await call('a', 'b', 'wake_agent')).isError).toBe(true);
  });

  it('turned on: a sleeping target lists wake_agent and get_status, and the call wakes it', async () => {
    await setLocalWake('a', 'b', true);
    expect(suffixes('a', 'b')).toEqual(expect.arrayContaining(['get_status', 'wake_agent']));
    const result = await call('a', 'b', 'wake_agent', { message: 'review the plan' });
    expect(result.isError).toBeFalsy();
    expect(lifecycle.wakeWiredAgent).toHaveBeenCalledWith(expect.objectContaining({ callerId: 'a', targetId: 'b' }));
    expect(lifecycle.wakeWiredAgent.mock.calls[0][0].mission).toContain('review the plan');
  });

  it('is per direction: a to b on leaves b to a off', async () => {
    await setLocalWake('a', 'b', true);
    running.clear();
    running.add('b');
    expect(suffixes('b', 'a')).not.toContain('wake_agent');
    expect((await call('b', 'a', 'wake_agent')).isError).toBe(true);
  });

  it('keeps the other tools as they were, and turning it off again closes it', async () => {
    await setConnectionTools({ agentId: 'a' }, { agentId: 'b' }, ['compact_agent']);
    await setLocalWake('a', 'b', true);
    expect(getConnectionDirection({ agentId: 'a' }, { agentId: 'b' })).toMatchObject({ disabledTools: ['compact_agent'], enabledTools: ['wake_agent'] });
    await setLocalWake('a', 'b', false);
    expect(getConnectionDirection({ agentId: 'a' }, { agentId: 'b' })?.disabledTools).toEqual(['compact_agent']);
    expect(suffixes('a', 'b')).not.toContain('wake_agent');
  });

  it('a running target lists no wake_agent even with the switch on', async () => {
    await setLocalWake('a', 'b', true);
    running.add('b');
    expect(suffixes('a', 'b')).not.toContain('wake_agent');
  });

  it('still needs the agent.wake grant: Ask first asks, Off refuses', async () => {
    await setLocalWake('a', 'b', true);
    await updateAgentGrantChanges('a', () => ({ changes: [{ action: 'agent.wake', target: WAKE_ON, mode: 'ask' }] }));
    expect(suffixes('a', 'b')).toContain('wake_agent');
    const asked = await call('a', 'b', 'wake_agent');
    expect(refusalReasonOf(asked)).toBe('ask_first');
    expect(ask.askFirst).toHaveBeenCalledWith('a', expect.stringMatching(/__wake_agent$/), {}, [{ action: 'agent.wake', where: 'an agent you are connected to' }]);
    expect(lifecycle.wakeWiredAgent).not.toHaveBeenCalled();

    await updateAgentGrantChanges('a', () => ({ changes: [{ action: 'agent.wake', target: WAKE_ON, mode: 'off' }] }));
    expect(suffixes('a', 'b')).not.toContain('wake_agent');
    const refused = await call('a', 'b', 'wake_agent');
    expect(refusalReasonOf(refused)).toBe('no_grant');
    expect(refused.content[0].text).toContain('agent.wake');
    expect(lifecycle.wakeWiredAgent).not.toHaveBeenCalled();
  });

  it('points the sender at wake_agent only when it can call it', async () => {
    const hint = async () => JSON.parse((await call('a', 'b', 'get_status')).content[0].text!).message as string;
    const refused = async () => (await call('a', 'b', 'send_message', { message: 'hi' })).content[0].text!;
    expect(await hint()).toBe('Agent is sleeping. Start it from Clubhouse or a group project wake_agent tool.');
    expect(await refused()).toContain('Start it from Clubhouse');
    await setLocalWake('a', 'b', true);
    expect(await hint()).toBe('Agent is sleeping. Call its wake_agent tool to start it.');
    expect(await refused()).toContain('Call its wake_agent tool');
    // The switch is on but the grant is Off: not pointed at a tool it can't use.
    await updateAgentGrantChanges('a', () => ({ changes: [{ action: 'agent.wake', target: WAKE_ON, mode: 'off' }] }));
    expect(await hint()).toBe('Agent is sleeping. Start it from Clubhouse or a group project wake_agent tool.');
    expect(await refused()).toContain('Start it from Clubhouse');
  });

  it('never offers sleep to an agent that is not the Dispatcher, switch or not', async () => {
    await setLocalWake('a', 'b', true);
    running.add('b');
    expect(suffixes('a', 'b')).not.toContain('sleep_agent');
    expect(refusalReasonOf(await call('a', 'b', 'sleep_agent'))).toBe('group_off');
    expect(lifecycle.sleepAgent).not.toHaveBeenCalled();
  });

  it('leaves the Dispatcher as it was: wake_agent offered with no switch and nothing saved', async () => {
    bindingManager.bind('dispatcher', wire('dispatcher', 'b'));
    expect(getConnectionDirection({ agentId: 'dispatcher' }, { agentId: 'b' })).toBeUndefined();
    expect(suffixes('dispatcher', 'b')).toEqual(expect.arrayContaining(['get_status', 'wake_agent']));
    expect((await call('dispatcher', 'b', 'wake_agent')).isError).toBeFalsy();
    expect(lifecycle.wakeWiredAgent).toHaveBeenCalledWith(expect.objectContaining({ callerId: 'dispatcher', targetId: 'b' }));
    running.add('b');
    expect(suffixes('dispatcher', 'b')).toContain('sleep_agent');
  });

  it('refuses wake_agent to the Dispatcher\'s chat, which wakes nothing but the Dispatcher, switch or not', async () => {
    setMcpCaller('chat', '/p', {});
    setDispatcherChatAgent('chat', true);
    bindingManager.bind('chat', wire('chat', 'b'));
    expect(suffixes('chat', 'b')).not.toContain('wake_agent');
    expect(refusalReasonOf(await call('chat', 'b', 'wake_agent'))).toBe('tool_denied');
    await setLocalWake('chat', 'b', true);
    expect(suffixes('chat', 'b')).not.toContain('wake_agent');
    expect(refusalReasonOf(await call('chat', 'b', 'wake_agent'))).toBe('no_grant');
    expect(lifecycle.wakeWiredAgent).not.toHaveBeenCalled();
  });

  it('the user removing a pair drops what the Dispatcher set on it, and leaves what the user set (#3215)', async () => {
    await setConnectionDirections([{ from: { agentId: 'a' }, to: { agentId: 'b' }, disabledTools: [], enabledTools: ['wake_agent'] }], () => {});
    await setConnectionTools({ agentId: 'b' }, { agentId: 'a' }, [], ['wake_agent']);
    for (const [from, to] of [['a', 'b'], ['b', 'a']]) {
      bindingManager.unbind(from, to);
      markBindingRemovedByUser(from, to);
    }
    await vi.waitFor(() => expect(getConnectionDirection({ agentId: 'a' }, { agentId: 'b' })).toBeUndefined());
    expect(getConnectionDirection({ agentId: 'b' }, { agentId: 'a' })).toMatchObject({ enabledTools: ['wake_agent'] });
  });

  it('reads a direction back: wake off until turned on, clear and compact as saved', async () => {
    expect(readLocalDirectionTools('a', 'b')).toEqual({
      allowed: ['get_status', 'read_output', 'check_connectivity', 'send_message', 'send_file', 'clear_agent', 'compact_agent'],
      disabled: ['wake_agent'],
    });
    await setConnectionTools({ agentId: 'a' }, { agentId: 'b' }, ['clear_agent', 'compact_agent']);
    await setLocalWake('a', 'b', true);
    expect(readLocalDirectionTools('a', 'b')).toEqual({
      allowed: ['get_status', 'read_output', 'check_connectivity', 'send_message', 'send_file', 'wake_agent'],
      disabled: ['clear_agent', 'compact_agent'],
    });
  });
});

describe('wake on by default (the maintainer\'s defaults, 2026-11-09)', () => {
  /** What a source gives a connection it makes: its starting lists, with nothing saved (#3214). */
  const start = (from: string, to: string, switches: StartingSwitches) =>
    bindingManager.restoreDisabledTools(from, to, [...switches.disabledTools], { starting: true, enabledTools: [...switches.enabledTools] });

  it('a connection Clubhouse makes starts with wake on and nothing saved: a sleeping target lists wake_agent, and the call wakes it', async () => {
    start('a', 'b', AUTOMATIC_CONNECTION_SWITCHES.orchestratorLink);
    expect(getConnectionDirection({ agentId: 'a' }, { agentId: 'b' })).toBeUndefined();
    expect(suffixes('a', 'b')).toEqual(expect.arrayContaining(['get_status', 'wake_agent']));
    expect((await call('a', 'b', 'wake_agent')).isError).toBeFalsy();
    expect(lifecycle.wakeWiredAgent).toHaveBeenCalledWith(expect.objectContaining({ callerId: 'a', targetId: 'b' }));
  });

  it('a wire the user draws starts with wake on', async () => {
    await applyConnectionTools('a', 'b', ['clear_agent', 'compact_agent'], { start: true });
    expect(suffixes('a', 'b')).toContain('wake_agent');
    expect((await call('a', 'b', 'wake_agent')).isError).toBeFalsy();
  });

  it('still needs the agent.wake grant: Ask first asks, Off refuses', async () => {
    start('a', 'b', AUTOMATIC_CONNECTION_SWITCHES.helperToParent);
    await updateAgentGrantChanges('a', () => ({ changes: [{ action: 'agent.wake', target: WAKE_ON, mode: 'ask' }] }));
    expect(suffixes('a', 'b')).toContain('wake_agent');
    expect(refusalReasonOf(await call('a', 'b', 'wake_agent'))).toBe('ask_first');
    expect(ask.askFirst).toHaveBeenCalled();

    await updateAgentGrantChanges('a', () => ({ changes: [{ action: 'agent.wake', target: WAKE_ON, mode: 'off' }] }));
    expect(suffixes('a', 'b')).not.toContain('wake_agent');
    expect(refusalReasonOf(await call('a', 'b', 'wake_agent'))).toBe('no_grant');
    expect(lifecycle.wakeWiredAgent).not.toHaveBeenCalled();
  });

  it('turned off by the user, it stays off over the start', async () => {
    start('a', 'b', AUTOMATIC_CONNECTION_SWITCHES.orchestratorLink);
    await setLocalWake('a', 'b', false);
    start('a', 'b', AUTOMATIC_CONNECTION_SWITCHES.orchestratorLink);
    expect(suffixes('a', 'b')).not.toContain('wake_agent');
    expect(refusalReasonOf(await call('a', 'b', 'wake_agent'))).toBe('tool_denied');
  });

  it('never offers sleep to an agent that is not the Dispatcher, every tool on or not', async () => {
    start('a', 'b', EVERY_SWITCH_ON);
    running.add('b');
    expect(suffixes('a', 'b')).toEqual(expect.arrayContaining(['clear_agent', 'compact_agent']));
    expect(suffixes('a', 'b')).not.toContain('sleep_agent');
    expect(refusalReasonOf(await call('a', 'b', 'sleep_agent'))).toBe('group_off');
    expect(lifecycle.sleepAgent).not.toHaveBeenCalled();
  });

  it('the Dispatcher starts with read, message and wake, but no clear or compact', async () => {
    bindingManager.bind('dispatcher', wire('dispatcher', 'b'));
    start('dispatcher', 'b', AUTOMATIC_CONNECTION_SWITCHES.dispatcherToAgent);
    expect(readLocalDirectionTools('dispatcher', 'b').disabled).toEqual(['clear_agent', 'compact_agent']);
    expect(suffixes('dispatcher', 'b')).toEqual(expect.arrayContaining(['get_status', 'wake_agent']));
    expect((await call('dispatcher', 'b', 'wake_agent')).isError).toBeFalsy();
    running.add('b');
    expect(suffixes('dispatcher', 'b')).toEqual(expect.arrayContaining(['sleep_agent', 'send_message']));
    expect(suffixes('dispatcher', 'b')).not.toContain('clear_agent');
    expect(suffixes('dispatcher', 'b')).not.toContain('compact_agent');
  });
});
