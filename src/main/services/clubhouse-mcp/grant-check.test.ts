import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../plugin-manifest-registry', () => ({ getManifest: vi.fn(() => ({ permissions: ['mcp.tools'] })) }));
vi.mock('../dispatcher/dispatcher-settings', async (original) => ({
  ...await original<typeof import('../dispatcher/dispatcher-settings')>(),
  isDispatcherEnabled: () => true,
}));

import { listToolGrants, _resetForTesting, type RegisteredToolGrant } from './tool-registry';
import { mcpAdapter } from './mcp-adapter';
import { registerClubhouseMcpTools } from './tools/register-all';
import { checkToolGrant } from './grant-check';
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
