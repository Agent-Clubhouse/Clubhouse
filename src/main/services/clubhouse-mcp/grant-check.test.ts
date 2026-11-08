import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../plugin-manifest-registry', () => ({ getManifest: vi.fn(() => ({ permissions: ['mcp.tools'] })) }));
vi.mock('../dispatcher/dispatcher-settings', async (original) => ({
  ...await original<typeof import('../dispatcher/dispatcher-settings')>(),
  isDispatcherEnabled: () => true,
}));

import { listToolGrants, _resetForTesting, type RegisteredToolGrant } from './tool-registry';
import { mcpAdapter } from './mcp-adapter';
import { registerClubhouseMcpTools } from './tools/register-all';
import { checkToolGrant, registerActionOwnerLookup } from './grant-check';
import { setMcpCaller, _resetMcpCallGateForTesting } from './mcp-call-gate';
import { setOrchestrationEnabled, isOrchestrationEnabled, isCrossProjectEnabled, _resetOrchestrationGateForTesting } from './orchestration-gate';
import { setDispatcherAgent, isDispatcherAgent, isTrackedDispatcher, _resetDispatcherGateForTesting } from './dispatcher-gate';
import { deniedGroupProjectTools } from '../../../shared/group-project-admin';
import { toolGrantDeclarations, type ToolGrant } from './tool-grants';
import type { ToolGroups } from './tool-registry';

/**
 * The parity suite (#2968): for every tool the app registers, every kind of
 * caller against every kind of target, the outcome before the grant check
 * (tool groups, wires, group admin) and after it. Only the epic's two gap
 * fixes may differ.
 */

const PROJECT = '/p';
type Caller = 'plain' | 'orchestrator' | 'helper' | 'dispatcher';
const CALLERS: Caller[] = ['plain', 'orchestrator', 'helper', 'dispatcher'];

function setupCallers() {
  _resetMcpCallGateForTesting();
  _resetOrchestrationGateForTesting();
  _resetDispatcherGateForTesting();
  setMcpCaller('plain', PROJECT, {});
  setMcpCaller('orchestrator', PROJECT, {});
  setOrchestrationEnabled('orchestrator', true, { crossProject: true });
  setMcpCaller('helper', PROJECT, { parentAgentId: 'orchestrator' });
  setMcpCaller('dispatcher', PROJECT, {});
  setDispatcherAgent('dispatcher', true);
}

/** The old tool-group gate, as tool-registry applies it. */
function oldGroupAllows(group: ToolGroups | undefined, agentId: string): boolean {
  if (!group) return true;
  const groups = typeof group === 'string' ? [group] : group;
  return groups.some((g) => g === 'orchestration' ? !isTrackedDispatcher(agentId) && isOrchestrationEnabled(agentId)
    : g === 'crossProject' ? !isTrackedDispatcher(agentId) && isCrossProjectEnabled(agentId)
      : g === 'dispatcher' ? isDispatcherAgent(agentId)
        : false);
}

function registerAll(): RegisteredToolGrant[] {
  _resetForTesting();
  mcpAdapter._resetForTesting();
  registerClubhouseMcpTools();
  return listToolGrants();
}

/** Every argument a declaration can be conditional on, so the strictest set of declarations applies. */
function allArgs(grant: ToolGrant | undefined): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const d of grant ? toolGrantDeclarations(grant) : []) for (const a of d.ifArgs ?? []) args[a] = 'x';
  return args;
}

describe('grant check parity (#2968)', () => {
  beforeEach(setupCallers);

  it('agent wire tools: only a helper reading or resetting its parent, and resetting the Dispatcher, change', () => {
    const tools = registerAll().filter((t) => t.kind === 'agent');
    expect(tools.length).toBeGreaterThan(8);
    // Who each caller can be wired to, by how it stands to them.
    const targets: Record<string, string> = { peer: 'peer', parent: 'orchestrator', dispatcher: 'dispatcher', helper: 'helper' };
    const diffs: string[] = [];
    for (const caller of CALLERS) {
      for (const [relation, targetId] of Object.entries(targets)) {
        if (targetId === caller) continue;
        for (const tool of tools) {
          const before = oldGroupAllows(tool.group, caller);
          const after = before && checkToolGrant(caller, tool.grant, allArgs(tool.grant), { binding: { targetKind: 'agent', targetId } }).ok;
          if (before !== after) diffs.push(`${caller} -> ${relation}: ${tool.name}`);
        }
      }
    }
    expect(diffs.sort()).toEqual([
      'helper -> parent: check_connectivity',
      'helper -> parent: clear_agent',
      'helper -> parent: compact_agent',
      'helper -> parent: get_status',
      'helper -> parent: read_output',
      'orchestrator -> dispatcher: clear_agent',
      'orchestrator -> dispatcher: compact_agent',
      'plain -> dispatcher: clear_agent',
      'plain -> dispatcher: compact_agent',
      'helper -> dispatcher: clear_agent',
      'helper -> dispatcher: compact_agent',
    ].sort());
  });

  it('a helper can still message its parent over the wire', () => {
    const send = registerAll().find((t) => t.kind === 'agent' && t.name === 'send_message')!;
    expect(checkToolGrant('helper', send.grant, {}, { binding: { targetKind: 'agent', targetId: 'orchestrator' } }).ok).toBe(true);
  });

  it('group project and browser wire tools: unchanged for members and admins', () => {
    const tools = registerAll().filter((t) => t.kind === 'group-project' || t.kind === 'browser');
    expect(tools.length).toBeGreaterThan(10);
    const diffs: string[] = [];
    for (const caller of CALLERS) {
      for (const admin of [false, true]) {
        const metadata = admin ? { admins: [caller] } : {};
        for (const tool of tools) {
          const denied = tool.kind === 'group-project' && deniedGroupProjectTools(metadata, caller).has(tool.name);
          const before = oldGroupAllows(tool.group, caller) && !denied;
          const wire = { binding: { targetKind: tool.kind as 'group-project' | 'browser', targetId: 't' }, groupMetadata: metadata };
          const after = before && checkToolGrant(caller, tool.grant, allArgs(tool.grant), wire).ok;
          if (before !== after) diffs.push(`${caller}${admin ? ' (admin)' : ''}: ${tool.kind}:${tool.name}`);
        }
      }
    }
    expect(diffs).toEqual([]);
  });

  it('global tools: unchanged for every caller, except message_parent, which the handler refused anyway', () => {
    const tools = registerAll().filter((t) => t.kind === 'global');
    expect(tools.length).toBeGreaterThan(30);
    const diffs: string[] = [];
    for (const caller of CALLERS) {
      for (const tool of tools) {
        const before = oldGroupAllows(tool.group, caller);
        const after = before && checkToolGrant(caller, tool.grant, allArgs(tool.grant)).ok;
        if (before !== after) diffs.push(`${caller}: ${tool.name}`);
      }
    }
    // message_parent was listed for every agent and refused by its handler without a parent.
    // set_helper_presets (#2785) is new, and needs settings.app.write, which no agent holds with Allow yet.
    expect(diffs.sort()).toEqual([
      'dispatcher: message_parent', 'dispatcher: set_helper_presets',
      'helper: set_helper_presets',
      'orchestrator: message_parent', 'orchestrator: set_helper_presets',
      'plain: message_parent', 'plain: set_helper_presets',
    ]);
  });
});

describe('everyday flows keep working (#2968)', () => {
  beforeEach(setupCallers);
  const byName = (kind: string, name: string) => registerAll().find((t) => t.kind === kind && t.name === name)!;
  const ok = (caller: string, kind: string, name: string, args: Record<string, unknown> = {}, targetId?: string, wireKind: 'agent' | 'browser' | 'group-project' = 'agent', groupMetadata?: Record<string, unknown>) => {
    const tool = byName(kind, name);
    const wire = targetId ? { binding: { targetKind: wireKind, targetId }, groupMetadata } : undefined;
    return checkToolGrant(caller, tool.grant, { ...allArgs(tool.grant), ...args }, wire).ok;
  };

  it('an orchestrator starts a helper, messages it, wakes it and reads its result', () => {
    expect(ok('orchestrator', 'global', 'start_helper')).toBe(true);
    for (const name of ['list_helpers', 'wake_helper', 'sleep_helper', 'inspect_helper', 'answer_helper_question', 'dispose_helper', 'hand_off']) {
      expect(ok('orchestrator', 'global', name), name).toBe(true);
    }
    for (const name of ['send_message', 'send_file', 'get_status', 'read_output', 'check_connectivity', 'clear_agent', 'compact_agent']) {
      expect(ok('orchestrator', 'agent', name, {}, 'helper'), name).toBe(true);
    }
  });

  it('a helper replies to its orchestrator', () => {
    expect(ok('helper', 'global', 'message_parent')).toBe(true);
    expect(ok('helper', 'agent', 'send_message', {}, 'orchestrator')).toBe(true);
    expect(ok('helper', 'agent', 'send_file', {}, 'orchestrator')).toBe(true);
  });

  it('group project board tools, for members and admins', () => {
    for (const name of ['read_bulletin', 'read_topic', 'read_message', 'list_members', 'get_project_info', 'post_bulletin']) {
      expect(ok('plain', 'group-project', name, {}, 'g', 'group-project', {}), name).toBe(true);
    }
    for (const name of ['shoulder_tap', 'broadcast', 'wake_agent', 'clear_topic', 'set_project_info']) {
      expect(ok('plain', 'group-project', name, {}, 'g', 'group-project', { admins: ['plain'] }), name).toBe(true);
    }
  });

  it('canvas wires between agents, and to browsers', () => {
    for (const caller of ['plain', 'orchestrator']) {
      for (const name of ['send_message', 'send_file', 'get_status', 'read_output', 'check_connectivity', 'clear_agent', 'compact_agent']) {
        expect(ok(caller, 'agent', name, {}, 'peer'), `${caller} ${name}`).toBe(true);
      }
    }
    for (const name of ['navigate', 'click', 'screenshot', 'get_console']) expect(ok('plain', 'browser', name, {}, 'b', 'browser'), name).toBe(true);
  });

  it('the Dispatcher keeps its v1 reach: creating, restarting, setting up and pushing to any agent', () => {
    for (const name of ['create_managed_agent', 'restart_agent', 'set_agent_setup', 'push_agent_template', 'save_agent_template', 'create_agent_part',
      'fork_agent_part', 'get_agent_setup', 'list_agents', 'update_agent', 'update_project', 'list_projects']) {
      expect(ok('dispatcher', 'global', name), name).toBe(true);
    }
    for (const name of ['wake_agent', 'sleep_agent', 'preview_provider', 'clear_agent', 'send_message']) {
      expect(ok('dispatcher', 'agent', name, {}, 'peer'), name).toBe(true);
    }
  });

  it('Actions (#2918): every agent reads all and creates its own, and changes or runs only its own', () => {
    registerActionOwnerLookup((args) => (args.id === 'mine' ? { actionId: 'mine', ownerAgentId: 'plain' }
      : args.id === 'persons' ? { actionId: 'persons' } : undefined));
    try {
      for (const caller of CALLERS) {
        expect(checkToolGrant(caller, { actions: ['action.read'], target: 'app' }, {}).ok, `${caller} read`).toBe(true);
        expect(checkToolGrant(caller, { actions: ['action.write'], target: 'app' }, {}).ok, `${caller} create`).toBe(true);
      }
      const run = { actions: ['action.run'] as const, target: 'action_arg' as const };
      const edit = { actions: ['action.write'] as const, target: 'action_arg' as const };
      expect(checkToolGrant('plain', run, { id: 'mine' }).ok).toBe(true);
      expect(checkToolGrant('plain', edit, { id: 'mine' }).ok).toBe(true);
      // A person's Action runs at that person's Access: an agent needs a grant on it.
      const refused = checkToolGrant('plain', run, { id: 'persons' });
      expect(refused).toMatchObject({ ok: false, reason: 'no_grant' });
      if (refused.ok === false) expect(refused.message).toContain('action.run on an Action you don\'t own');
      expect(checkToolGrant('orchestrator', edit, { id: 'mine' }).ok).toBe(false);
      // An unknown id is refused the same way, so a refusal never says whether it exists.
      expect(checkToolGrant('plain', run, { id: 'nope' })).toMatchObject({ ok: false, reason: 'no_grant' });
      // The Dispatcher keeps its v1 reach.
      expect(checkToolGrant('dispatcher', run, { id: 'persons' }).ok).toBe(true);
      // The tool list passes no arguments: the Action isn't known yet, so it's listed and the call is checked.
      for (const caller of CALLERS) expect(checkToolGrant(caller, run, {}).ok, `${caller} lists run_action`).toBe(true);
    } finally {
      registerActionOwnerLookup(null);
    }
  });
});

describe('a refused call says what is missing (#2968)', () => {
  beforeEach(setupCallers);

  it('names the permission and the target, and how to report instead', () => {
    const status = registerAll().find((t) => t.kind === 'agent' && t.name === 'get_status')!;
    const refused = checkToolGrant('helper', status.grant, {}, { binding: { targetKind: 'agent', targetId: 'orchestrator' } });
    expect(refused.ok).toBe(false);
    if (refused.ok === false) {
      expect(refused.message).toContain('agent.read on your orchestrator');
      expect(refused.message).toContain('message_parent');
      expect(refused.message).toContain('Only the user can grant it');
    }
    const clear = registerAll().find((t) => t.kind === 'agent' && t.name === 'clear_agent')!;
    const toDispatcher = checkToolGrant('plain', clear.grant, {}, { binding: { targetKind: 'agent', targetId: 'dispatcher' } });
    if (toDispatcher.ok === false) expect(toDispatcher.message).toContain('agent.reset on the Dispatcher');
    else throw new Error('expected a refusal');
  });
});
