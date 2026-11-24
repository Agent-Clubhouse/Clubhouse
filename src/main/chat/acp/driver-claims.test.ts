/**
 * The launch spec's opt-in provider facts: the steer claim, a level policy and
 * a login hint (#3797). Each is off by default; the last block pins that a
 * spec without them behaves as before.
 */

import { describe, expect, it } from 'vitest';
import type { ChatDriverId } from '../../../shared/chat/capabilities';
import type { ChatEventDraft } from '../../../shared/chat/events';
import type { ChatDriverSession, ChatDriverStartOptions } from '../../../shared/chat/runtime';
import { isLoginRequiredError } from '../../services/agent-runtime/login-error';
import type { AcpLevelPolicy } from './capabilities';
import { createAcpChatDriver, type AcpLaunchSpec } from './driver';
import { ACP_ERROR_CODES, type InitializeResponse, type SessionConfigOption, type SessionModeState } from './protocol';
import { ScriptedAcpAgent, type ScriptedAgentOptions } from './testing/scripted-agent';

const ID = 'acp_neutral_test' as ChatDriverId;
const INIT: InitializeResponse = { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } }, authMethods: [] };
const START: ChatDriverStartOptions = { agentId: 'a1', provider: 'acp-test', cwd: '/work', binaryPath: '/bin/agent', level: 'ask' };
const BASE: AcpLaunchSpec = { id: ID, provider: 'acp-test', args: ({ extraArgs }) => ['acp', ...extraArgs] };
const STEER: AcpLaunchSpec = { ...BASE, claims: { steer: true } };

const POLICY: AcpLevelPolicy = {
  mode: (level) => ({ plan: 'plan', ask: 'default', auto_edit: 'accept-edits' } as Record<string, string | undefined>)[level],
  processLevels: ['full_access'],
};
const MODES: SessionModeState = {
  currentModeId: 'default',
  availableModes: [{ id: 'default', name: 'Default' }, { id: 'accept-edits', name: 'Accept edits' }, { id: 'plan', name: 'Plan' }],
};
const LEVELS: AcpLaunchSpec = { ...BASE, levels: POLICY, args: ({ extraArgs, level }) => ['acp', ...(level === 'full_access' ? ['--skip'] : []), ...extraArgs] };

const tick = () => new Promise((r) => setTimeout(r, 0));

async function open(spec: AcpLaunchSpec, agentOpts: ScriptedAgentOptions = {}, start: Partial<ChatDriverStartOptions> = {}) {
  const agent = new ScriptedAcpAgent({ initialize: INIT, ...agentOpts });
  let args: string[] = [];
  const driver = createAcpChatDriver(spec, { connect: (command) => { args = command.args; return agent.connector; } });
  const session = await driver.start({ ...START, ...start });
  const drafts: ChatEventDraft[] = [];
  void (async () => { for await (const d of session.events) drafts.push(d); })();
  const of = <T extends ChatEventDraft['type']>(type: T) => drafts.filter((d): d is Extract<ChatEventDraft, { type: T }> => d.type === type);
  return { agent, session, drafts, of, args: () => args };
}

const text = (t: string) => [{ type: 'text' as const, text: t }];

async function steered(session: ChatDriverSession, agent: ScriptedAcpAgent) {
  expect(await session.send(text('first'), 'prompt')).toBe('prompt');
  const first = await agent.nextPrompt();
  expect(await session.send(text('also this'), 'steer')).toBe('steer');
  const second = await agent.nextPrompt();
  return { first, second };
}

describe('steer claim', () => {
  it('advertises steer and joins a written prompt to the running turn', async () => {
    const { session, agent, of } = await open(STEER);
    expect(session.capabilities.steer).toBe(true);
    expect(session.capabilities.queue).toBe('client');
    await steered(session, agent);
    expect(agent.promptsWritten).toBe(2);
    await tick();
    expect(of('turn_started')).toHaveLength(1);
  });

  // Answer order isn't documented; each order ends the turn once, on the last answer.
  it.each([
    ['both answered, first then second', ['first', 'second']],
    ['both answered, second then first', ['second', 'first']],
  ] as const)('%s: one turn_ended after the last answer', async (_name, order) => {
    const { session, agent, of } = await open(STEER);
    const prompts = await steered(session, agent);
    prompts[order[0]].end('end_turn');
    await tick();
    expect(of('turn_ended')).toHaveLength(0);
    prompts[order[1]].end('end_turn');
    await tick();
    expect(of('turn_started')).toHaveLength(1);
    expect(of('turn_ended').map((d) => d.data.stopReason)).toEqual(['end_turn']);
  });

  it('the turn ends with the last answer\'s stop reason', async () => {
    const { session, agent, of } = await open(STEER);
    const { first, second } = await steered(session, agent);
    first.end('end_turn');
    second.end('max_tokens');
    await tick();
    expect(of('turn_ended').map((d) => d.data.stopReason)).toEqual(['max_tokens']);
  });

  it('a refused steer is reported as maybe not delivered, with its text, and the turn goes on', async () => {
    const { session, agent, of } = await open(STEER);
    const { first, second } = await steered(session, agent);
    second.fail(ACP_ERROR_CODES.internalError, 'busy');
    await tick();
    expect(of('notice').map((d) => d.data)).toEqual([expect.objectContaining({ level: 'warn', code: 'steer_not_delivered', message: expect.stringContaining('"also this"') })]);
    expect(of('error').map((d) => d.data)).toEqual([expect.objectContaining({ fatal: false, message: expect.stringContaining('busy') })]);
    expect(of('turn_ended')).toHaveLength(0);
    first.end('end_turn');
    await tick();
    expect(of('turn_ended').map((d) => d.data.stopReason)).toEqual(['end_turn']);
    // Never resent.
    expect(agent.promptsWritten).toBe(2);
  });

  it('a steer refused last ends the turn as an error and is still reported', async () => {
    const { session, agent, of } = await open(STEER);
    const { first, second } = await steered(session, agent);
    first.end('end_turn');
    second.fail(ACP_ERROR_CODES.internalError, 'refused');
    await tick();
    expect(of('notice').map((d) => d.data.code)).toEqual(['steer_not_delivered']);
    expect(of('turn_ended').map((d) => d.data.stopReason)).toEqual(['error']);
    expect(agent.promptsWritten).toBe(2);
  });

  it('interrupt: the turn ends once both prompts are answered cancelled', async () => {
    const { session, agent, of } = await open(STEER);
    const { first, second } = await steered(session, agent);
    const cancelled = agent.cancelled();
    await session.interrupt();
    await cancelled;
    first.end('cancelled');
    await tick();
    expect(of('turn_ended')).toHaveLength(0);
    second.end('cancelled');
    await tick();
    expect(of('turn_ended').map((d) => d.data.stopReason)).toEqual(['cancelled']);
  });

  it('a disconnect with two prompts unanswered settles nothing', async () => {
    const { session, agent, of, drafts } = await open(STEER);
    await steered(session, agent);
    agent.disconnect({ code: 1, signal: null });
    await tick();
    await tick();
    expect(of('turn_ended')).toHaveLength(0);
    expect(of('notice')).toHaveLength(0);
    expect(drafts.at(-1)).toMatchObject({ type: 'error', data: { code: 'process_exited', fatal: true } });
    await expect(session.send(text('again'), 'steer')).rejects.toThrow(/not open/);
    expect(agent.promptsWritten).toBe(2);
  });

  it('a steer after the turn has ended starts a new turn and says so', async () => {
    const { session, agent, of } = await open(STEER);
    await session.send(text('first'), 'prompt');
    (await agent.nextPrompt()).end('end_turn');
    await tick();
    expect(await session.send(text('late'), 'steer')).toBe('prompt');
    await tick();
    expect(of('turn_started')).toHaveLength(2);
  });

  it('a queued or prompt delivery into a running turn is still refused', async () => {
    const { session, agent } = await open(STEER);
    await session.send(text('first'), 'prompt');
    await agent.nextPrompt();
    await expect(session.send(text('x'), 'prompt')).rejects.toThrow(/running ACP turn/);
    await expect(session.send(text('x'), 'queued')).rejects.toThrow(/running ACP turn/);
    expect(agent.promptsWritten).toBe(1);
  });
});

describe('level policy', () => {
  it('maps live levels to the modes the session offers', async () => {
    const { session, agent } = await open(LEVELS, { modes: MODES });
    expect(session.capabilities.liveLevels).toEqual(['plan', 'ask', 'auto_edit']);
    // Already in `default`: nothing sent.
    expect(agent.sentRequests('session/set_mode')).toEqual([]);
  });

  it('applies the start level before any prompt', async () => {
    const { agent, args } = await open(LEVELS, { modes: MODES }, { level: 'plan' });
    expect(agent.sentRequests('session/set_mode')).toEqual([{ sessionId: 'session-1', modeId: 'plan' }]);
    expect(args()).toEqual(['acp']);
  });

  it('only offers levels whose mode the session has', async () => {
    const { session } = await open(LEVELS, { modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] } });
    expect(session.capabilities.liveLevels).toEqual(['ask']);
  });

  it('refuses a start whose mode the session does not offer, and a level with no mode', async () => {
    await expect(open(LEVELS, { modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] } }, { level: 'plan' }))
      .rejects.toThrow(/doesn't offer mode "plan"/);
    await expect(open(LEVELS, { modes: MODES }, { level: 'auto' })).rejects.toThrow(/no mode for the Auto level/);
    await expect(open(LEVELS, {}, { level: 'auto_edit' })).rejects.toThrow(/doesn't offer mode "accept-edits"/);
  });

  it('a process level comes from the launch args and leaves no live levels', async () => {
    const { session, agent, args } = await open(LEVELS, { modes: MODES }, { level: 'full_access' });
    expect(args()).toEqual(['acp', '--skip']);
    expect(agent.sentRequests('session/set_mode')).toEqual([]);
    expect(session.capabilities.liveLevels).toEqual([]);
    await expect(session.setLevel('ask')).rejects.toThrow(/without a restart/);
  });

  it('setLevel switches the mode; a full-access switch needs a restart', async () => {
    const { session, agent } = await open(LEVELS, { modes: MODES });
    await session.setLevel('auto_edit');
    expect(agent.sentRequests('session/set_mode')).toEqual([{ sessionId: 'session-1', modeId: 'accept-edits' }]);
    await expect(session.setLevel('full_access')).rejects.toThrow(/without a restart/);
  });

  it('reports the agent\'s own mode change as a level', async () => {
    const { agent, of } = await open(LEVELS, { modes: MODES });
    agent.update('session-1', { sessionUpdate: 'current_mode_update', currentModeId: 'plan' });
    await tick();
    expect(of('mode_changed').map((d) => d.data)).toEqual([{ level: 'plan', nativeMode: 'plan' }]);
  });

  it('uses a mode config option when the agent sends one', async () => {
    const modeOption: SessionConfigOption = {
      id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default',
      options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }],
    };
    const { session, agent } = await open(LEVELS, { configOptions: [modeOption] }, { level: 'plan' });
    expect(agent.sentRequests('session/set_config_option')).toEqual([{ sessionId: 'session-1', configId: 'mode', value: 'plan' }]);
    expect(session.capabilities.liveLevels).toEqual(['plan', 'ask']);
  });
});

describe('login hint', () => {
  it('turns Authentication required at setup into a login error with the hint', async () => {
    const spec: AcpLaunchSpec = { ...BASE, loginHint: 'Run `agent` to sign in.' };
    const err = await open(spec, { newSessionError: { code: ACP_ERROR_CODES.authRequired, message: 'Authentication required' } }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^Authentication required: Run `agent` to sign in\./);
    expect(isLoginRequiredError((err as Error).message)).toBe(true);
    expect(err).toMatchObject({ needsLogin: true, loginHint: 'Run `agent` to sign in.' });
  });
});

describe('without claims or policy (unchanged)', () => {
  it('no steer, no live levels, sends during a turn are refused', async () => {
    const { session, agent } = await open(BASE, { modes: MODES });
    expect(session.capabilities).toMatchObject({ steer: false, queue: 'client', liveLevels: [] });
    await session.send(text('first'), 'prompt');
    await agent.nextPrompt();
    await expect(session.send(text('x'), 'steer')).rejects.toThrow(/Cannot steer into a running ACP turn/);
    await expect(session.setLevel('plan')).rejects.toThrow(/no live permission levels/);
    expect(agent.sentRequests('session/set_mode')).toEqual([]);
  });

  it('a level is not applied and an auth error stays the agent\'s own', async () => {
    const err = await open(BASE, { newSessionError: { code: ACP_ERROR_CODES.authRequired, message: 'Authentication required' } }, { level: 'plan' }).catch((e: Error) => e);
    expect(err).toMatchObject({ code: ACP_ERROR_CODES.authRequired, message: expect.stringContaining('Authentication required') });
    expect(err).not.toHaveProperty('needsLogin');
  });
});

describe('effort without a model choice (gate 3)', () => {
  const THINKING: SessionConfigOption = {
    id: 'thinking', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: 'low',
    options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }],
  };

  it('reports the effort in session_info when there is no model id, and changes it alone', async () => {
    const { session, agent, of } = await open(BASE, { configOptions: [THINKING] });
    await tick();
    expect(of('session_info')[0].data).toMatchObject({ model: null, models: [], efforts: ['low', 'high'], effort: 'low' });
    await session.setEffort!('high');
    expect(agent.sentRequests('session/set_config_option')).toEqual([{ sessionId: 'session-1', configId: 'thinking', value: 'high' }]);
    await tick();
    expect(of('session_info').at(-1)?.data).toEqual({ effort: 'high' });
    expect(of('model_changed')).toEqual([]);
  });

  it('refuses an effort it does not offer, null, and a session without effort', async () => {
    const { session, agent } = await open(BASE, { configOptions: [THINKING] });
    await expect(session.setEffort!('max')).rejects.toThrow(/doesn't offer effort "max"/);
    await expect(session.setEffort!(null)).rejects.toThrow(/default/);
    expect(agent.sentRequests('session/set_config_option')).toEqual([]);
    const bare = await open(BASE);
    await expect(bare.session.setEffort!('low')).rejects.toThrow(/no effort choice/);
  });

  it('with a model option, effort changes still come as model_changed', async () => {
    const model: SessionConfigOption = { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'm', options: [{ value: 'm', name: 'M' }] };
    const { session, of } = await open(BASE, { configOptions: [model, THINKING] });
    await tick();
    expect(of('session_info')[0].data).not.toHaveProperty('effort');
    await session.setEffort!('high');
    await tick();
    expect(of('model_changed').map((d) => d.data)).toEqual([{ modelId: 'm', effort: 'high' }]);
  });
});
