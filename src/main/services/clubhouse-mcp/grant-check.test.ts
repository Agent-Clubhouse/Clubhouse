import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The stores it writes (connections, grants) go to a userData folder of each test's own,
// not the one test files share, so files running in parallel can't race on them.
const userData = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', async (original) => {
  const actual = await original<typeof import('electron')>();
  return { ...actual, app: { ...actual.app, getPath: (name: string) => (name === 'userData' && userData.dir ? userData.dir : actual.app.getPath(name)) } };
});

vi.mock('../plugin-manifest-registry', () => ({ getManifest: vi.fn(() => ({ permissions: ['mcp.tools'] })) }));
vi.mock('../dispatcher/dispatcher-settings', async (original) => ({
  ...await original<typeof import('../dispatcher/dispatcher-settings')>(),
  isDispatcherEnabled: () => true,
}));

import { listToolGrants, _resetForTesting, type RegisteredToolGrant } from './tool-registry';
import { mcpAdapter } from './mcp-adapter';
import { registerClubhouseMcpTools } from './tools/register-all';
import { bindingManager } from './binding-manager';
import { capToHolder, checkToolGrant, decideGrant, isListable, registerActionOwnerLookup } from './grant-check';
import { updateAgentGrantChanges } from '../agent-grants-store';
import { setMcpCaller, _resetMcpCallGateForTesting } from './mcp-call-gate';
import { setOrchestrationEnabled, isOrchestrationEnabled, isCrossProjectEnabled, _resetOrchestrationGateForTesting } from './orchestration-gate';
import { setDispatcherIdLookup, setDispatcherAgent, isDispatcherAgent, isTrackedDispatcher, _resetDispatcherGateForTesting } from './dispatcher-gate';
import { GROUP_PROJECT_PRIVILEGED_TOOL_SUFFIXES } from '../../../shared/group-project-permissions';
import type { GrantChange } from '../../../shared/agent-grant-changes';

/** Lead and admin of one group project, as a person grants them (#3360). */
function leadAndAdmin(groupProjectId: string): GrantChange[] {
  return (['group_project.lead', 'group_project.admin'] as const).map((action) => ({ action, target: { kind: 'group_project', id: groupProjectId }, mode: 'allow' }));
}
import { toolGrantDeclarations, type ToolGrant } from './tool-grants';
import type { ToolGroups } from './tool-registry';

/**
 * The parity suite (#2968): for every tool the app registers, every kind of
 * caller against every kind of target, the outcome before the grant check
 * (tool groups, wires, group admin) and after it. Only the epic's two gap
 * fixes may differ.
 */

beforeEach(() => {
  userData.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grant-check-'));
});
afterEach(() => {
  fs.rmSync(userData.dir, { recursive: true, force: true });
  userData.dir = '';
});

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
          // wake_agent was in the dispatcher group; its gate is now Wake it on the connection (#3215), checked beside the grant.
          const before = tool.name === 'wake_agent' ? isDispatcherAgent(caller) : oldGroupAllows(tool.group, caller);
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

  it('group project and browser wire tools: members get the board, and only a lead by grant gets the lead tools (#3360)', async () => {
    const tools = registerAll().filter((t) => t.kind === 'group-project' || t.kind === 'browser');
    expect(tools.length).toBeGreaterThan(10);
    const privileged: ReadonlySet<string> = new Set(GROUP_PROJECT_PRIVILEGED_TOOL_SUFFIXES);
    const diffs: string[] = [];
    for (const caller of CALLERS) {
      for (const lead of [false, true]) {
        await updateAgentGrantChanges(caller, () => (lead ? { changes: leadAndAdmin('t') } : undefined));
        for (const tool of tools) {
          // The admins role no longer gates anything: what used to need it now needs lead (or admin) granted on this group project.
          const expected = oldGroupAllows(tool.group, caller) && (!(tool.kind === 'group-project' && privileged.has(tool.name)) || lead);
          const wire = { binding: { targetKind: tool.kind as 'group-project' | 'browser', targetId: 't' }, groupMetadata: { admins: [caller] } };
          const after = oldGroupAllows(tool.group, caller) && checkToolGrant(caller, tool.grant, allArgs(tool.grant), wire).ok;
          if (expected !== after) diffs.push(`${caller}${lead ? ' (lead)' : ''}: ${tool.kind}:${tool.name}`);
        }
        await updateAgentGrantChanges(caller, () => undefined);
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
    // The device tools (#3068) are new: only the Dispatcher sees devices, and it asks before changing any.
    const deviceTools = ['probe_capacity', 'list_devices', 'reconnect_device', 'remove_device', 'rename_device', 'start_adding_device'];
    const manage = deviceTools.filter((t) => t !== 'list_devices' && t !== 'probe_capacity');
    expect(diffs.sort()).toEqual([
      'dispatcher: message_parent', ...manage.map((t) => `dispatcher: ${t}`), 'dispatcher: set_helper_presets',
      ...deviceTools.map((t) => `helper: ${t}`), 'helper: set_helper_presets',
      ...deviceTools.slice(0, 1).map((t) => `orchestrator: ${t}`), 'orchestrator: message_parent', ...deviceTools.slice(1).map((t) => `orchestrator: ${t}`), 'orchestrator: set_helper_presets',
      ...deviceTools.slice(0, 1).map((t) => `plain: ${t}`), 'plain: message_parent', ...deviceTools.slice(1).map((t) => `plain: ${t}`), 'plain: set_helper_presets',
      ...['helper', 'orchestrator', 'plain'].flatMap((caller) => ['update_annex_network_settings', 'set_theme'].map((tool) => `${caller}: ${tool}`)),
      // Remote news/file tools require a distinct grant; these fixtures have no local Dispatcher binding.
      ...['helper', 'orchestrator', 'plain'].flatMap((caller) => ['message_remote_dispatcher', 'send_file_to_remote_dispatcher'].map((tool) => `${caller}: ${tool}`)),
    ].sort());
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

  it('an orchestrator lists the templates and parts start_helper can name (#3001)', () => {
    for (const name of ['list_agent_templates', 'list_agent_parts']) {
      expect(ok('orchestrator', 'global', name), name).toBe(true);
      expect(ok('plain', 'global', name), name).toBe(false);
    }
    // Reading, never changing: the builder's writes stay the Dispatcher's.
    for (const name of ['save_agent_template', 'create_agent_part', 'push_agent_template']) {
      expect(ok('orchestrator', 'global', name), name).toBe(false);
    }
  });

  it('a helper replies to its orchestrator', () => {
    expect(ok('helper', 'global', 'message_parent')).toBe(true);
    expect(ok('helper', 'agent', 'send_message', {}, 'orchestrator')).toBe(true);
    expect(ok('helper', 'agent', 'send_file', {}, 'orchestrator')).toBe(true);
  });

  it('group project board tools, for members, and lead tools for a lead by grant (#3360)', async () => {
    for (const name of ['read_bulletin', 'read_topic', 'read_message', 'list_members', 'get_project_info', 'post_bulletin']) {
      expect(ok('plain', 'group-project', name, {}, 'g', 'group-project', {}), name).toBe(true);
    }
    // The old admins role gives nothing now.
    for (const name of ['shoulder_tap', 'broadcast', 'wake_agent', 'clear_topic', 'set_project_info']) {
      expect(ok('plain', 'group-project', name, {}, 'g', 'group-project', { admins: ['plain'] }), name).toBe(false);
    }
    await updateAgentGrantChanges('plain', () => ({ changes: leadAndAdmin('g') }));
    for (const name of ['shoulder_tap', 'broadcast', 'wake_agent', 'clear_topic', 'set_project_info']) {
      expect(ok('plain', 'group-project', name, {}, 'g', 'group-project', {}), name).toBe(true);
    }
    // A lead of another group project leads nothing here.
    expect(ok('plain', 'group-project', 'broadcast', {}, 'other', 'group-project', {})).toBe(false);
    await updateAgentGrantChanges('plain', () => undefined);
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

describe('a person\'s changes reach the next call (#2971)', () => {
  beforeEach(setupCallers);

  it('Allow on app settings writes opens set_helper_presets; Off on reading connected agents closes get_status', async () => {
    const tools = registerAll();
    const presets = tools.find((t) => t.name === 'set_helper_presets')!;
    const status = tools.find((t) => t.kind === 'agent' && t.name === 'get_status')!;
    const wire = { binding: { targetKind: 'agent' as const, targetId: 'peer' } };
    expect(checkToolGrant('plain', presets.grant, {}).ok).toBe(false);
    expect(checkToolGrant('plain', status.grant, {}, wire).ok).toBe(true);
    await updateAgentGrantChanges('plain', () => ({ changes: [
      { action: 'settings.app.write', target: { kind: 'app' }, mode: 'allow' },
      { action: 'agent.read', target: { kind: 'connected' }, mode: 'off' },
    ] }));
    expect(checkToolGrant('plain', presets.grant, {}).ok).toBe(true);
    expect(checkToolGrant('plain', status.grant, {}, wire)).toMatchObject({ ok: false, reason: 'no_grant' });
    await updateAgentGrantChanges('plain', () => undefined);
    expect(checkToolGrant('plain', presets.grant, {}).ok).toBe(false);
  });

  it('subscribing is making an Action (#3042): it follows action.write on the app', async () => {
    const subscribe = registerAll().find((t) => t.name === 'subscribe')!;
    expect(toolGrantDeclarations(subscribe.grant)).toContainEqual({ actions: ['action.write'], target: 'app' });
    for (const caller of CALLERS) expect(checkToolGrant(caller, subscribe.grant, {}).ok, caller).toBe(true);
    await updateAgentGrantChanges('plain', () => ({ changes: [{ action: 'action.write', target: { kind: 'app' }, mode: 'off' }] }));
    try {
      const refused = checkToolGrant('plain', subscribe.grant, {});
      expect(refused).toMatchObject({ ok: false, reason: 'no_grant' });
      if (refused.ok === false) expect(refused.message).toContain('action.write on the app');
      expect(checkToolGrant('orchestrator', subscribe.grant, {}).ok).toBe(true);
    } finally {
      await updateAgentGrantChanges('plain', () => undefined);
    }
  });

  it('requires activity permission only for an any-agent source, flat or nested, even without a window argument', async () => {
    const tools = registerAll();
    const subscribe = tools.find((t) => t.name === 'subscribe')!;
    const create = tools.find((t) => t.name === 'create_action')!;
    expect(checkToolGrant('plain', subscribe.grant, { source: { kind: 'agent', agentId: 'plain' } }).ok).toBe(true);
    expect(checkToolGrant('plain', create.grant, { trigger: { kind: 'schedule' } }).ok).toBe(true);
    const direct = { source: { kind: 'any' } };
    const nested = { trigger: { kind: 'event', source: { kind: 'any' } } };
    expect(checkToolGrant('plain', subscribe.grant, direct)).toMatchObject({ ok: false, action: 'agent.watch' });
    expect(checkToolGrant('plain', create.grant, nested)).toMatchObject({ ok: false, action: 'agent.watch' });
    // The engine, not a one-call approval, explains why a saved Allow is necessary.
    expect(checkToolGrant('dispatcher', subscribe.grant, direct).ok).toBe(true);
    try {
      await updateAgentGrantChanges('plain', () => ({ changes: [{ action: 'agent.watch', target: { kind: 'app' }, mode: 'allow' }] }));
      expect(checkToolGrant('plain', subscribe.grant, direct).ok).toBe(true);
      expect(checkToolGrant('plain', create.grant, nested).ok).toBe(true);
    } finally {
      await updateAgentGrantChanges('plain', () => undefined);
    }
  });

  it('an explicit grant on one person\'s Action opens just that one (#2918)', async () => {
    registerActionOwnerLookup((args) => (typeof args.id === 'string' ? { actionId: args.id } : undefined));
    try {
      const run = { actions: ['action.run'] as const, target: 'action_arg' as const };
      await updateAgentGrantChanges('plain', () => ({ changes: [{ action: 'action.run', target: { kind: 'action', id: 'persons' }, mode: 'allow' }] }));
      expect(checkToolGrant('plain', run, { id: 'persons' }).ok).toBe(true);
      expect(checkToolGrant('plain', run, { id: 'other' }).ok).toBe(false);
    } finally {
      registerActionOwnerLookup(null);
      await updateAgentGrantChanges('plain', () => undefined);
    }
  });
});

describe('waking the Dispatcher by messaging it (#3037)', () => {
  beforeEach(setupCallers);
  const dispatcher = { kind: 'agent' as const, relations: ['connected' as const], isDispatcher: true };

  it('every agent may by default; a person can set it to Ask first or Off', async () => {
    for (const caller of ['plain', 'orchestrator', 'helper'] as const) expect(decideGrant(caller, 'agent.wake', dispatcher).outcome).toBe('allow');
    expect(decideGrant('plain', 'agent.wake', { kind: 'agent', relations: ['connected'] }).outcome).toBe('refuse');
    const target = { kind: 'connected' as const, onlyDispatcher: true };
    try {
      await updateAgentGrantChanges('plain', () => ({ changes: [{ action: 'agent.wake', target, mode: 'ask' }] }));
      expect(decideGrant('plain', 'agent.wake', dispatcher).outcome).toBe('ask');
      await updateAgentGrantChanges('plain', () => ({ changes: [{ action: 'agent.wake', target, mode: 'off' }] }));
      expect(decideGrant('plain', 'agent.wake', dispatcher).outcome).toBe('refuse');
    } finally {
      await updateAgentGrantChanges('plain', () => undefined);
    }
  });
});

describe('Ask first (#2970)', () => {
  beforeEach(setupCallers);
  const wire = { binding: { targetKind: 'agent' as const, targetId: 'peer' } };
  const read = { actions: ['agent.read'] as const, target: 'connected' as const };

  it('requires the group Admin grant, including Ask first, for its Actions', async () => {
    const members = vi.spyOn(bindingManager, 'getAllBindings').mockReturnValue([{ agentId: 'plain', targetId: 'gp1', targetKind: 'group-project' }] as never);
    registerActionOwnerLookup((args) => args.id === 'group-action' ? { actionId: 'group-action', groupProjectId: 'gp1' } : undefined);
    const grants = [
      { actions: ['action.write'] as const, target: 'action_arg' as const },
      { actions: ['group_project.admin'] as const, target: 'action_group_project' as const },
    ];
    try {
      expect(checkToolGrant('plain', grants, { id: 'group-action' })).toMatchObject({ ok: false, reason: 'no_grant' });
      await updateAgentGrantChanges('plain', () => ({ changes: [{ action: 'group_project.admin', target: { kind: 'group_project', id: 'gp1' }, mode: 'ask' }] }));
      expect(checkToolGrant('plain', grants, { id: 'group-action' })).toMatchObject({ ok: false, reason: 'ask_first', asks: [{ action: 'group_project.admin' }] });
      await updateAgentGrantChanges('plain', () => ({ changes: [{ action: 'group_project.admin', target: { kind: 'group_project', id: 'gp1' }, mode: 'allow' }] }));
      expect(checkToolGrant('plain', grants, { id: 'group-action' }).ok).toBe(true);
      members.mockReturnValue([]);
      expect(checkToolGrant('plain', grants, { id: 'group-action' })).toMatchObject({ ok: false, reason: 'no_grant' });
      await updateAgentGrantChanges('plain', () => ({ changes: [{ action: 'group_project.admin', target: { kind: 'any' }, mode: 'allow' }] }));
      expect(checkToolGrant('plain', grants, { id: 'group-action' })).toMatchObject({ ok: false, reason: 'no_grant' });
      expect(checkToolGrant('plain', grants, { id: 'unknown' }).ok).toBe(false);
    } finally {
      registerActionOwnerLookup(null);
      members.mockRestore();
      await updateAgentGrantChanges('plain', () => undefined);
    }
  });

  it('a permission set to Ask first asks, and the tool stays listed', async () => {
    await updateAgentGrantChanges('plain', () => ({ changes: [{ action: 'agent.read', target: { kind: 'connected' }, mode: 'ask' }] }));
    try {
      const check = checkToolGrant('plain', read, {});
      expect(check).toMatchObject({ ok: false, reason: 'ask_first', asks: [{ action: 'agent.read', where: 'an agent you are connected to' }] });
      expect(isListable(check)).toBe(true);
      expect(isListable(checkToolGrant('plain', { actions: ['settings.app.write'], target: 'app' }, {}))).toBe(false);
      const status = registerAll().find((t) => t.kind === 'agent' && t.name === 'get_status')!;
      expect(checkToolGrant('plain', status.grant, {}, wire)).toMatchObject({ reason: 'ask_first' });
    } finally {
      await updateAgentGrantChanges('plain', () => undefined);
    }
  });

  it('a refusal wins over an ask, so the user is never asked for a call that would fail', async () => {
    await updateAgentGrantChanges('plain', () => ({ changes: [{ action: 'agent.read', target: { kind: 'connected' }, mode: 'ask' }] }));
    try {
      const both: ToolGrant = [read, { actions: ['settings.app.write'], target: 'app' }];
      expect(checkToolGrant('plain', both, {})).toMatchObject({ ok: false, reason: 'no_grant' });
    } finally {
      await updateAgentGrantChanges('plain', () => undefined);
    }
  });

  it('a tool that asks itself gets the call (start_helper, dispose_helper)', async () => {
    await updateAgentGrantChanges('plain', () => ({ changes: [{ action: 'agent.read', target: { kind: 'connected' }, mode: 'ask' }] }));
    try {
      expect(checkToolGrant('plain', { ...read, askHandledByTool: true }, {}).ok).toBe(true);
    } finally {
      await updateAgentGrantChanges('plain', () => undefined);
    }
  });

  it('an orchestrator\'s approval setting reaches the call (#2970), and the helper tools ask themselves', () => {
    setOrchestrationEnabled('orchestrator', true, { crossProject: true, control: 'ask-everything' });
    const tools = registerAll();
    const dispose = { actions: ['agent.dispose'] as const, target: 'my_helpers' as const };
    expect(checkToolGrant('orchestrator', dispose, {})).toMatchObject({ reason: 'ask_first', asks: [{ action: 'agent.dispose', where: 'your helpers' }] });
    for (const name of ['dispose_helper', 'hand_off', 'start_helper']) {
      expect(checkToolGrant('orchestrator', tools.find((t) => t.name === name)!.grant, {}).ok).toBe(true);
    }
    setOrchestrationEnabled('orchestrator', true, { crossProject: true, control: 'hands-off' });
    expect(checkToolGrant('orchestrator', dispose, {}).ok).toBe(true);
  });

  it('the Dispatcher\'s app settings write asks by default', () => {
    expect(checkToolGrant('dispatcher', { actions: ['settings.app.write'], target: 'app' }, {})).toMatchObject({ reason: 'ask_first', asks: [{ where: 'the app' }] });
  });

  it('the Dispatcher asks first to add or open a project; no one else can (#3050)', () => {
    const add: ToolGrant = { actions: ['project.add'], target: 'all_projects' };
    expect(checkToolGrant('dispatcher', add, {})).toMatchObject({ reason: 'ask_first', asks: [{ action: 'project.add', where: 'projects' }] });
    for (const caller of ['plain', 'orchestrator', 'helper']) expect(checkToolGrant(caller, add, {}), caller).toMatchObject({ ok: false, reason: 'no_grant' });
  });

  it('a person can switch the Dispatcher\'s project.add to Allow or Off (#3050)', async () => {
    const add: ToolGrant = { actions: ['project.add'], target: 'all_projects' };
    const target = { kind: 'project', project: 'any' } as const;
    try {
      await updateAgentGrantChanges('dispatcher', () => ({ changes: [{ action: 'project.add', target, mode: 'allow' }] }));
      expect(checkToolGrant('dispatcher', add, {}).ok).toBe(true);
      await updateAgentGrantChanges('dispatcher', () => ({ changes: [{ action: 'project.add', target, mode: 'off' }] }));
      expect(checkToolGrant('dispatcher', add, {})).toMatchObject({ ok: false, reason: 'no_grant' });
    } finally {
      await updateAgentGrantChanges('dispatcher', () => undefined);
    }
  });

  it('every agent can ask for a permission for itself', () => {
    const request = registerAll().find((t) => t.name === 'request_grant')!;
    for (const caller of CALLERS) expect(checkToolGrant(caller, request.grant, {}).ok).toBe(true);
  });
});

describe('a helper template\'s permissions are capped by its orchestrator (#2971)', () => {
  beforeEach(setupCallers);

  it('caps each entry to what the orchestrator holds, never dropping one (which would leave a wider default)', async () => {
    const app = { kind: 'app' as const };
    const connected = { kind: 'connected' as const };
    const grants = [
      { action: 'agent.message' as const, target: connected, mode: 'off' as const },
      { action: 'settings.app.write' as const, target: app, mode: 'allow' as const },
      { action: 'models.read' as const, target: app, mode: 'allow' as const },
      { action: 'agent.read' as const, target: connected, mode: 'ask' as const },
    ];
    expect(capToHolder('orchestrator', grants).map((g) => `${g.action}:${g.mode}`))
      .toEqual(['agent.message:off', 'settings.app.write:off', 'models.read:allow', 'agent.read:ask']);
    // An orchestrator that only asks passes Ask first; one with it Off passes Off.
    await updateAgentGrantChanges('orchestrator', () => ({ changes: [
      { action: 'models.read', target: app, mode: 'ask' },
      { action: 'agent.read', target: connected, mode: 'off' },
    ] }));
    try {
      expect(capToHolder('orchestrator', grants).map((g) => `${g.action}:${g.mode}`))
        .toEqual(['agent.message:off', 'settings.app.write:off', 'models.read:ask', 'agent.read:off']);
    } finally {
      await updateAgentGrantChanges('orchestrator', () => undefined);
    }
  });

  it('in another project, its own project needs the orchestrator to hold any project', () => {
    const own = [{ action: 'project.read' as const, target: { kind: 'project' as const, project: 'own' as const }, mode: 'allow' as const }];
    expect(capToHolder('plain', own)[0].mode).toBe('allow');
    expect(capToHolder('plain', own, { elsewhere: true })[0].mode).toBe('off');
    // The cross-project orchestrator holds project.read on any project.
    expect(capToHolder('orchestrator', own, { elsewhere: true })[0].mode).toBe('allow');
  });
});

describe('handoff agreement grants', () => {
  beforeEach(setupCallers);
  it.each(['handoff.offer', 'handoff.accept'] as const)('%s defaults Off for every non-Dispatcher and Ask for the Dispatcher', (action) => {
    const grant = { actions: [action], target: 'handoff_peer' as const };
    const targets = new Map([[grant, [{ kind: 'agent' as const, agentId: 'peer', relations: ['connected' as const] }]]]);
    for (const caller of ['plain', 'orchestrator', 'helper']) expect(checkToolGrant(caller, grant, { to: 'peer' }, undefined, targets)).toMatchObject({ ok: false, reason: 'no_grant' });
    expect(checkToolGrant('dispatcher', grant, { to: 'peer' }, undefined, targets)).toMatchObject({ ok: false, reason: 'ask_first' });
    expect(isListable(checkToolGrant('dispatcher', grant, {}, undefined, undefined, true))).toBe(true);
    expect(isListable(checkToolGrant('plain', grant, {}, undefined, undefined, true))).toBe(false);
  });

  it('enforces the resolved peer target on every call and fails closed if resolution was unsafe', async () => {
    const grant = { actions: ['handoff.offer' as const], target: 'handoff_peer' as const };
    expect(checkToolGrant('dispatcher', grant, {})).toMatchObject({ ok: false, reason: 'no_grant' });
    const args = { to: 'peer' };
    const connected = new Map([[grant, [{ kind: 'agent' as const, agentId: 'peer', relations: ['connected' as const] }]]]);
    const unrelated = new Map([[grant, [{ kind: 'agent' as const, agentId: 'other', relations: [] }]]]);
    try {
      await updateAgentGrantChanges('plain', () => ({ changes: [{ action: 'handoff.offer', target: { kind: 'connected' }, mode: 'allow' }] }));
      expect(checkToolGrant('plain', grant, args, undefined, connected).ok).toBe(true);
      expect(checkToolGrant('plain', grant, args, undefined, unrelated).ok).toBe(false);
      expect(checkToolGrant('plain', grant, args).ok).toBe(false);
      await updateAgentGrantChanges('plain', () => ({ changes: [{ action: 'handoff.offer', target: { kind: 'connected' }, mode: 'ask' }] }));
      expect(checkToolGrant('plain', grant, args, undefined, connected)).toMatchObject({ ok: false, reason: 'ask_first' });
      await updateAgentGrantChanges('plain', () => undefined);
      expect(checkToolGrant('plain', grant, args, undefined, connected).ok).toBe(false);
    } finally { await updateAgentGrantChanges('plain', () => undefined); }
  });
});

it('keeps the remote Dispatcher Ask default when the locally connected controller is asleep', () => {
  setMcpCaller('connected-agent', userData.dir, {});
  setDispatcherIdLookup((id) => id === 'sleeping-controller');
  const bindings = vi.spyOn(bindingManager, 'getBindingsForAgent').mockReturnValue([{ targetKind: 'agent', targetId: 'sleeping-controller' }] as ReturnType<typeof bindingManager.getBindingsForAgent>);
  try {
    expect(checkToolGrant('connected-agent', { actions: ['agent.message'], target: 'remote_dispatcher' }, {})).toMatchObject({ ok: false, reason: 'ask_first' });
    bindings.mockReturnValue([]);
    expect(checkToolGrant('connected-agent', { actions: ['agent.message'], target: 'remote_dispatcher' }, {})).toMatchObject({ ok: false, reason: 'no_grant' });
  } finally { bindings.mockRestore(); setDispatcherIdLookup(null); }
});
