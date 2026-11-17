import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GROUP_PROJECT_TOOL_SUFFIXES } from '../../../../shared/group-project-permissions';
import type { GrantAction } from '../../../../shared/agent-grants';
import type { McpToolResult } from '../types';

const m = vi.hoisted(() => ({
  home: '', project: { id: 'gp_parity', name: 'Team', description: '', instructions: '', scope: { level: 'app', reach: 'local' }, metadata: {}, seq: 3 },
  list: vi.fn(), get: vi.fn(), update: vi.fn(), previewScope: vi.fn(), setScope: vi.fn(), operations: vi.fn(), scopeOptions: vi.fn(), exclusive: vi.fn(), estimateTrim: vi.fn(), setRetention: vi.fn(), clearAll: vi.fn(), setTopicProtected: vi.fn(), dismissRefusals: vi.fn(), isReplica: vi.fn(),
  previewAutoJoin: vi.fn(), describeMembership: vi.fn(), addMember: vi.fn(), excludeMember: vi.fn(), setAutomaticMembership: vi.fn(), answerAutoJoinOffer: vi.fn(), confirmUnlinkedMembers: vi.fn(), recordMemberDisabledTools: vi.fn(),
  listHosts: vi.fn(), createOn: vi.fn(), create: vi.fn(), previewDelete: vi.fn(), confirmDelete: vi.fn(),
  roles: vi.fn(), grantRole: vi.fn(), ownGrant: vi.fn(), roster: vi.fn(), coverage: vi.fn(), guidance: vi.fn(), saveGuidance: vi.fn(), listActions: vi.fn(),
}));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => m.home || os.tmpdir() } }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../mcp-call-gate', async (original) => ({ ...await original<typeof import('../mcp-call-gate')>(), mcpCallAccess: () => 'open' }));
vi.mock('../../dispatcher/dispatcher-settings', () => ({ isDispatcherEnabled: () => true }));
vi.mock('../../project-store', () => ({ list: async () => [{ id: 'proj_a', name: 'App' }] }));
vi.mock('../../agent-config', () => ({ getDurableConfig: async () => ({ name: 'Controller' }) }));
vi.mock('../../group-project-registry', () => ({ groupProjectRegistry: { list: () => m.list(), getSync: () => m.project, onChange: () => () => {} } }));
vi.mock('../../group-project-host', () => ({ groupProjectHost: {
  selfMachine: () => null, list: m.list, get: m.get, update: m.update, previewScope: m.previewScope, setScope: m.setScope, operations: m.operations, scopeOptions: m.scopeOptions, exclusive: m.exclusive, estimateTrim: m.estimateTrim, setRetention: m.setRetention, clearAll: m.clearAll, setTopicProtected: m.setTopicProtected, dismissRefusals: m.dismissRefusals, isReplica: m.isReplica,
} }));
vi.mock('../../group-project-membership', () => ({ previewAutoJoin: m.previewAutoJoin, describeMembership: m.describeMembership, addMember: m.addMember, excludeMember: m.excludeMember, setAutomaticMembership: m.setAutomaticMembership, answerAutoJoinOffer: m.answerAutoJoinOffer, confirmUnlinkedMembers: m.confirmUnlinkedMembers, recordMemberDisabledTools: m.recordMemberDisabledTools }));
vi.mock('../../group-project-remote-create', () => ({ groupProjectRemoteCreate: { listHosts: m.listHosts, createOn: m.createOn } }));
vi.mock('../../group-project-management', () => ({ createManagedGroupProject: m.create, previewGroupProjectDeletion: m.previewDelete, groupProjectDeletion: { confirm: m.confirmDelete } }));
vi.mock('../../group-project-roles', () => ({ describeGroupProjectRoles: m.roles, grantGroupProjectRole: m.grantRole, setOwnGrant: m.ownGrant }));
vi.mock('../../group-project-roster', () => ({ groupProjectRoster: { describe: m.roster } }));
vi.mock('../../group-project-coverage', () => ({ listCoverage: m.coverage }));
vi.mock('../../connection-guidance', () => ({ getConnectionGuidance: m.guidance, saveConnectionGuidance: m.saveGuidance }));
vi.mock('../../group-project-polling', () => ({ listPausedPolling: () => [] }));
vi.mock('../../actions', () => ({ listActions: m.listActions }));

import { registerGroupProjectManagementTools, GROUP_PROJECT_MANAGEMENT_TOOLS, GROUP_PROJECT_MCP_EXCLUSIONS } from './group-project-management-tools';
import { callTool, getScopedToolList, refusalReasonOf, _resetForTesting } from '../tool-registry';
import { agentRegistry } from '../../agent-registry';
import { bindingManager } from '../binding-manager';
import { updateAgentGrantChanges } from '../../agent-grants-store';
import { _resetDispatcherGateForTesting, setDispatcherAgent, setDispatcherChatAgent } from '../dispatcher-gate';
import { _resetGrantRequestsForTesting, listGrantRequests, takeGrantRequest } from '../../grant-requests';
import { _resetOrchestrationGateForTesting, setOrchestrationEnabled } from '../orchestration-gate';

const caller = 'parity-controller';
const plan = { name: 'Team', host: 'this', scope: { level: 'app', reach: 'local' }, membership: { autoJoin: false, includeLinkedComputers: false, excluded: [] } };
const json = (result: McpToolResult) => JSON.parse(result.content.map((c) => 'text' in c ? c.text : '').join('\n'));
const call = (name: string, args: Record<string, unknown>, who = caller) => callTool(who, name, args);
async function grants(mode: 'allow' | 'ask' | 'off', who = caller) {
  await updateAgentGrantChanges(who, () => ({ changes: (['group_project.admin', 'group_project.lead'] as GrantAction[]).map((action) => ({ action, target: { kind: 'any' }, mode, by: 'user', at: '2026-11-17T00:00:00Z' })) }));
}
async function creationArgs(extra: Record<string, unknown> = {}) {
  const args = { ...plan, ...extra };
  const preview = await call('preview_group_project_create', args);
  expect(preview.isError).toBeUndefined();
  return { ...args, preview_token: json(preview).preview_token };
}
async function argsFor(name: string): Promise<Record<string, unknown>> {
  const byName: Record<string, Record<string, unknown>> = {
    preview_group_project_create: plan,
    update_group_project: { name: 'Renamed' },
    preview_group_project_scope: { scope: plan.scope },
    set_group_project_scope: { scope: plan.scope, confirm_leaving: [] },
    add_group_project_member: { agent: 'member' }, exclude_group_project_member: { agent: 'member' },
    set_group_project_automatic_membership: { membership: plan.membership },
    answer_group_project_auto_join_offer: { accept: false }, confirm_group_project_unlinked_members: { confirm_leaving: [] },
    set_group_project_role: { agent: 'member', role: 'lead', mode: 'allow' },
    set_group_project_own_grant: { grant: 'wake', mode: 'off' },
    set_group_project_default_tools: { disabled_tools: [], apply_to_existing: true },
    set_group_project_member_settings: { agent: 'member', disabled_tools: [] },
    set_group_project_topic_protection: { topic: 'work', protected: true },
    preview_group_project_retention: { max_per_topic: 5, max_total: 20 },
    set_group_project_retention: { max_per_topic: 5, max_total: 20, confirm_trim: 2, expected_seq: 3 },
    clear_group_project_board: { confirm: true }, delete_group_project: { token: 'impact-token' },
  };
  if (name === 'create_group_project') return creationArgs();
  return { group_project: m.project.id, ...byName[name] };
}

beforeEach(async () => {
  m.home = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-mcp-parity-'));
  _resetForTesting(); _resetDispatcherGateForTesting(); _resetGrantRequestsForTesting(); _resetOrchestrationGateForTesting(); bindingManager._resetForTesting();
  m.list.mockResolvedValue([m.project]); m.get.mockResolvedValue(m.project); m.update.mockResolvedValue(m.project);
  m.operations.mockResolvedValue({ operations: [], omittedQueued: 0 }); m.scopeOptions.mockReturnValue({ network: { available: true }, projects: [{ id: 'proj_a', name: 'App' }] });
  m.previewAutoJoin.mockResolvedValue({ wouldJoin: [], unreadableProjects: [], coverage: [] });
  m.describeMembership.mockResolvedValue({ members: [], excluded: [], autoJoin: false }); m.roles.mockResolvedValue({ own: { deliver: 'allow', wake: 'off', actions: 'allow' }, holders: [] });
  m.roster.mockResolvedValue({ status: 'available', members: [], complete: true }); m.coverage.mockResolvedValue([]);
  m.listActions.mockReturnValue([]); m.guidance.mockResolvedValue({ revision: 'r1', instructions: {}, needsSourceConfirmation: false });
  m.listHosts.mockResolvedValue([{ machine: null, name: 'This computer', state: 'online' }, { machine: 'remote', name: 'Studio', state: 'online' }]);
  m.create.mockResolvedValue(m.project); m.createOn.mockResolvedValue({ status: 'waiting', requestId: 'request-one', host: 'remote', hostName: 'Studio', expiresAt: 'future' });
  m.previewDelete.mockResolvedValue({ token: 'impact-token', members: ['member'], actions: ['action'], incompleteWindows: false });
  m.exclusive.mockImplementation(async (_id, fn) => fn({ seq: 3 })); m.estimateTrim.mockResolvedValue(2); m.isReplica.mockReturnValue(false);
  agentRegistry.register(caller, { projectPath: m.home, orchestrator: 'claude-code', runtime: 'pty' });
  setDispatcherAgent(caller, true);
  bindingManager.bind('member', { targetId: m.project.id, targetKind: 'group-project', label: 'Team' });
  registerGroupProjectManagementTools();
  await grants('allow');
});
afterEach(async () => {
  await updateAgentGrantChanges(caller, () => undefined);
  agentRegistry.untrack(caller);
  _resetGrantRequestsForTesting();
  fs.rmSync(m.home, { recursive: true, force: true });
});

describe('management grants and catalog (#3617)', () => {
  it.each(GROUP_PROJECT_MANAGEMENT_TOOLS)('%s enforces Deny, Ask, approval and Allow through callTool', async (name, _capability, action) => {
    const args = await argsFor(name);
    await grants('off');
    expect(refusalReasonOf(await call(name, args))).toBe('no_grant');
    expect(getScopedToolList(caller).map((t) => t.name)).not.toContain(name);
    await grants('ask');
    expect(getScopedToolList(caller).map((t) => t.name)).toContain(name);
    expect(refusalReasonOf(await call(name, args))).toBe('ask_first');
    const request = listGrantRequests().find((r) => r.toolName === name)!;
    expect(request.actions).toEqual([action]);
    expect(takeGrantRequest(request.requestId, true)).toBeTruthy();
    expect((await call(name, args)).isError).toBeUndefined();
    // A separate Allow call never adds a redundant approval request.
    await grants('allow');
    const allowArgs = await argsFor(name);
    expect((await call(name, allowArgs)).isError).toBeUndefined();
    expect(listGrantRequests()).toEqual([]);
  });

  it('keeps management in the controller and preserves chat acting handoff', async () => {
    setDispatcherChatAgent(caller, true);
    expect(getScopedToolList(caller).map((t) => t.name)).not.toContain('create_group_project');
    expect(await call('create_group_project', plan)).toMatchObject({ isError: true });
    expect(m.create).not.toHaveBeenCalled();
    setDispatcherAgent(caller, true);
    expect(getScopedToolList(caller).map((t) => t.name)).toContain('create_group_project');
  });

  it('uses existing Dispatcher admin Ask default, without introducing a new default grant', async () => {
    await updateAgentGrantChanges(caller, () => undefined);
    expect(refusalReasonOf(await call('preview_group_project_create', {}))).toBe('ask_first');
  });

  it('lists a tool for a single-group grant but checks the selected id on each call', async () => {
    setDispatcherAgent(caller, false);
    await updateAgentGrantChanges(caller, () => ({ changes: [{ action: 'group_project.admin', target: { kind: 'group_project', id: 'gp_parity' }, mode: 'allow' }] }));
    m.list.mockResolvedValue([m.project, { ...m.project, id: 'gp_other', name: 'Other' }]);
    expect(getScopedToolList(caller).map((t) => t.name)).toContain('update_group_project');
    expect(getScopedToolList(caller).map((t) => t.name)).not.toContain('create_group_project');
    expect((await call('update_group_project', { group_project: 'gp_parity', name: 'Allowed' })).isError).toBeUndefined();
    expect(refusalReasonOf(await call('update_group_project', { group_project: 'gp_other', name: 'Refused' }))).toBe('no_grant');
    expect(m.update).toHaveBeenCalledTimes(1);
  });

  it('ordinary agents and orchestrators use the same explicit grants, without Canvas or membership', async () => {
    setDispatcherAgent(caller, false);
    expect(getScopedToolList(caller).map((t) => t.name)).toContain('create_group_project');
    setOrchestrationEnabled(caller, true);
    expect(getScopedToolList(caller).map((t) => t.name)).toContain('get_group_project_management');
    await grants('off');
    expect(getScopedToolList(caller).map((t) => t.name)).not.toContain('get_group_project_management');
  });
});

describe('creation review and destination approval', () => {
  it('returns available choices and refuses guessed Dispatcher defaults', async () => {
    const result = json(await call('preview_group_project_create', {}));
    expect(result.needsChoices.join(' ')).toContain('host');
    expect(result.hosts).toHaveLength(2);
    expect(result.projects).toEqual([{ id: 'proj_a', name: 'App' }]);
    expect((await call('create_group_project', { name: 'No guessing' })).isError).toBe(true);
    expect(m.create).not.toHaveBeenCalled();
  });
  it.each([
    { scope: { level: 'app', reach: 'local' }, membership: { autoJoin: false, includeLinkedComputers: false, excluded: [] }, host: 'this' },
    { scope: { level: 'project', projectId: 'proj_a', reach: 'local' }, membership: { autoJoin: true, includeLinkedComputers: false, excluded: ['excluded'] }, host: 'this' },
    { scope: { level: 'project', projectId: 'proj_a', reach: 'network' }, membership: { autoJoin: true, includeLinkedComputers: true, excluded: [] }, host: 'this' },
  ])('applies explicit scope/reach/membership $scope', async (choices) => {
    const args = await creationArgs(choices);
    expect(json(await call('create_group_project', args)).status).toBe('created');
    expect(m.create).toHaveBeenCalledWith('Team', { scope: choices.scope, membership: choices.membership });
    expect((await call('create_group_project', args)).isError).toBe(true);
  });
  it.each([
    { host: 'this', scope: { level: 'app', reach: 'local' } },
    { host: 'remote', scope: { level: 'app', reach: 'network' } },
  ])('allows exactly one concurrent create to claim a single-use review on $host', async (choices) => {
    const args = await creationArgs(choices);
    let releasePreview!: () => void;
    const revalidation = new Promise<void>((resolve) => { releasePreview = resolve; });
    const snapshot = { wouldJoin: [], unreadableProjects: [], coverage: [] };
    m.previewAutoJoin.mockImplementation(async () => { await revalidation; return snapshot; });
    const first = call('create_group_project', args);
    // Hold the first caller inside the await that previously allowed a second claim.
    await vi.waitFor(() => expect(m.previewAutoJoin).toHaveBeenCalledTimes(2));
    let secondResult: McpToolResult | undefined;
    const second = call('create_group_project', args).then((result) => { secondResult = result; return result; });
    let results: McpToolResult[] = [];
    try {
      await vi.waitFor(() => expect(secondResult?.isError).toBe(true));
    } finally {
      releasePreview();
      results = await Promise.all([first, second]);
    }
    expect(results.filter((result) => !result.isError)).toHaveLength(1);
    expect(results.filter((result) => result.isError)).toHaveLength(1);
    expect(json(secondResult!).error.message).toContain('Refresh the creation preview');
    expect(m.create).toHaveBeenCalledTimes(choices.host === 'this' ? 1 : 0);
    expect(m.createOn).toHaveBeenCalledTimes(choices.host === 'remote' ? 1 : 0);
    // One initial preview plus one revalidation; the second create never revalidates.
    expect(m.previewAutoJoin).toHaveBeenCalledTimes(2);
  });
  it('keeps the review consumed after revalidation fails and asks for a new review', async () => {
    const args = await creationArgs();
    m.previewAutoJoin.mockRejectedValueOnce(new Error('Inventory unavailable'));
    const failed = await call('create_group_project', args);
    expect(failed.isError).toBe(true);
    expect(json(failed).error.message).toContain('Creation review consumed. Review again');
    const retry = await call('create_group_project', args);
    expect(retry.isError).toBe(true);
    expect(json(retry).error.message).toContain('Refresh the creation preview');
    expect(m.create).not.toHaveBeenCalled();
    expect((await call('create_group_project', await creationArgs())).isError).toBeUndefined();
  });
  it('keeps the review consumed after a create error and requires checking the result before review', async () => {
    const args = await creationArgs();
    m.create.mockRejectedValueOnce(new Error('Create did not complete'));
    const failed = await call('create_group_project', args);
    expect(failed.isError).toBe(true);
    expect(json(failed).error.message).toContain('Check list_group_projects for the result, then review again');
    expect((await call('create_group_project', args)).isError).toBe(true);
    expect(m.create).toHaveBeenCalledTimes(1);
  });
  it('rejects changed choices, inventory and caller identity before create', async () => {
    const args = await creationArgs();
    expect((await call('create_group_project', { ...args, name: 'Different' })).isError).toBe(true);
    m.previewAutoJoin.mockResolvedValue({ wouldJoin: [{ agentId: 'new' }], unreadableProjects: [] });
    expect((await call('create_group_project', args)).isError).toBe(true);
    expect(m.create).not.toHaveBeenCalled();
  });
  it('normalizes exclusions before preview so creation uses the reviewed membership', async () => {
    const args = await creationArgs({ membership: { ...plan.membership, excluded: [' member ', 'member'] } });
    expect(m.previewAutoJoin).toHaveBeenLastCalledWith(plan.scope, { ...plan.membership, excluded: ['member'] });
    expect((await call('create_group_project', args)).isError).toBeUndefined();
    expect(m.create).toHaveBeenCalledWith('Team', { scope: plan.scope, membership: { ...plan.membership, excluded: ['member'] } });
  });

  it('uses destination approval and exact saved retry without local creation', async () => {
    const args = await creationArgs({ host: 'remote', scope: { level: 'app', reach: 'network' } });
    expect(json(await call('create_group_project', args))).toMatchObject({ status: 'waiting', requestId: 'request-one' });
    expect(m.create).not.toHaveBeenCalled();
    expect(m.createOn).toHaveBeenCalledWith('remote', 'Team', { scope: { level: 'app', reach: 'network' }, membership: plan.membership });
    m.createOn.mockResolvedValue({ status: 'created', groupProjectId: 'remote-gp', requestId: 'request-one' });
    expect(json(await call('create_group_project', { name: 'ignored on retry', host: 'remote', retry_of: 'request-one' })).status).toBe('created');
    expect(m.createOn).toHaveBeenLastCalledWith('remote', '', undefined, 'request-one');
    expect((await call('create_group_project', { name: 'x', host: 'other-host', retry_of: 'request-one' })).isError).toBe(true);
  });
});

describe('shared operation semantics', () => {
  it('carries the MCP agent author on every forwardable mutation', async () => {
    for (const name of ['update_group_project', 'add_group_project_member', 'exclude_group_project_member', 'answer_group_project_auto_join_offer', 'set_group_project_own_grant', 'set_group_project_topic_protection', 'set_group_project_default_tools', 'set_group_project_member_settings']) {
      expect((await call(name, await argsFor(name))).isError, name).toBeUndefined();
    }
    for (const spy of [m.update, m.addMember, m.excludeMember, m.answerAutoJoinOffer, m.ownGrant, m.setTopicProtected, m.recordMemberDisabledTools]) {
      expect(spy.mock.calls.some((args) => args.some((a: unknown) => a && typeof a === 'object' && 'author' in a && JSON.stringify(a.author) === JSON.stringify({ agentId: caller, label: caller })))).toBe(true);
    }
  });
  it('ignores claimed identities in arguments and uses the authenticated MCP caller', async () => {
    await call('add_group_project_member', { group_project: 'Team', agent: 'member', author: { agentId: 'victim', label: 'user' }, agentId: 'victim', caller: 'victim' });
    expect(m.addMember).toHaveBeenCalledWith('gp_parity', 'member', { author: { agentId: caller, label: caller } });
    await call('update_group_project', { group_project: 'Team', description: 'Reviewed', author: { label: 'user' } });
    expect(m.update).toHaveBeenCalledWith('gp_parity', { description: 'Reviewed' }, { author: { agentId: caller, label: caller } });
  });

  it('preserves queued diagnostics instead of claiming a copy changed', async () => {
    m.operations.mockResolvedValue({ operations: [{ id: 'write', outcome: { status: 'queued', waitingFor: 'Studio' } }], omittedQueued: 0 });
    const result = json(await call('update_group_project', { group_project: 'gp_parity', name: 'New' }));
    expect(result.operations.operations[0].outcome.status).toBe('queued');
  });
  it('passes role changes to this computer’s role service and returns authoritative roster separately', async () => {
    await call('set_group_project_role', await argsFor('set_group_project_role'));
    expect(m.grantRole).toHaveBeenCalledWith('gp_parity', 'member', 'lead', 'allow');
    await call('get_group_project_management', { group_project: 'Team' });
    expect(m.roster).toHaveBeenCalledWith('gp_parity');
  });
  it('requires unchanged trim review and explicit board clear confirmation', async () => {
    expect((await call('set_group_project_retention', { ...await argsFor('set_group_project_retention'), expected_seq: 2 })).isError).toBe(true);
    expect(m.setRetention).not.toHaveBeenCalled();
    expect((await call('clear_group_project_board', { group_project: 'Team', confirm: false })).isError).toBe(true);
    expect(m.clearAll).not.toHaveBeenCalled();
  });
  it('shares delete preview/confirm and scopes tokens to the MCP caller', async () => {
    expect(json(await call('preview_delete_group_project', { group_project: 'Team' }))).toMatchObject({ token: 'impact-token', actions: ['action'], members: ['member'] });
    expect(m.previewDelete).toHaveBeenCalledWith('gp_parity', `mcp:${caller}`);
    await call('delete_group_project', { group_project: 'Team', token: 'impact-token' });
    expect(m.confirmDelete).toHaveBeenCalledWith('gp_parity', `mcp:${caller}`, 'impact-token');
    m.confirmDelete.mockRejectedValue(new Error('The group project changed. Refresh the impact check before deleting.'));
    expect((await call('delete_group_project', { group_project: 'Team', token: 'stale' })).isError).toBe(true);
  });
});

it('keeps every Group Project UI IPC capability mapped or explicitly excluded, and descriptions discoverable', () => {
  const management = 'get_group_project_management';
  const counterparts: Record<string, string> = {
    LIST: 'list_group_projects', CREATE: 'create_group_project', CREATE_HOSTS: 'preview_group_project_create', CREATE_ON_HOST: 'create_group_project', GET: management, UPDATE: 'update_group_project', PREVIEW_DELETE: 'preview_delete_group_project', DELETE: 'delete_group_project',
    DISMISS_REFUSALS: 'dismiss_group_project_refusals', GET_OPERATIONS: management, SCOPE_OPTIONS: 'preview_group_project_create', PREVIEW_SCOPE: 'preview_group_project_scope', SET_SCOPE: 'set_group_project_scope',
    GET_BULLETIN_DIGEST: 'read_bulletin', GET_TOPIC_MESSAGES: 'read_topic', GET_ALL_MESSAGES: 'read_topic', POST_BULLETIN_MESSAGE: 'post_bulletin', SEND_SHOULDER_TAP: 'shoulder_tap', DELETE_MESSAGE: 'delete_messages', DELETE_TOPIC: 'clear_topic', SET_TOPIC_PROTECTION: 'set_group_project_topic_protection',
    GET_RETENTION_CONFIG: management, SAVE_RETENTION_CONFIG: 'set_group_project_retention', CLEAR_ALL_MESSAGES: 'clear_group_project_board', ESTIMATE_TRIM: 'preview_group_project_retention', GET_MESSAGE: 'read_message', INJECT_MESSAGE: 'shoulder_tap', SET_POLLING: 'toggle_polling', GET_PAUSED_POLLING: 'query_polling', RESUME_POLLING: 'nudge_polling',
    LIST_MEMBERS: management, ADD_MEMBER: 'add_group_project_member', EXCLUDE_MEMBER: 'exclude_group_project_member', ANSWER_AUTO_JOIN_OFFER: 'answer_group_project_auto_join_offer', GET_ROLES: management, SET_ROLE: 'set_group_project_role', SET_OWN_GRANT: 'set_group_project_own_grant', PREVIEW_AUTO_JOIN: 'preview_group_project_create', SET_AUTOMATIC_MEMBERSHIP: 'set_group_project_automatic_membership', CONFIRM_UNLINKED_MEMBERS: 'confirm_group_project_unlinked_members', GET_ROSTER: management, GET_COVERAGE: management,
  };
  const preload = fs.readFileSync(path.join(process.cwd(), 'src/preload/groupProject.ts'), 'utf8');
  const uiCalls = [...preload.matchAll(/ipcRenderer\.invoke\(IPC\.GROUP_PROJECT\.([A-Z_]+)/g)].map((match) => match[1]);
  expect(uiCalls.filter((call) => !counterparts[call])).toEqual([]);
  const known = new Set<string>([...GROUP_PROJECT_MANAGEMENT_TOOLS.map(([name]) => name), ...GROUP_PROJECT_TOOL_SUFFIXES, 'list_group_projects']);
  expect(Object.values(counterparts).filter((name) => !known.has(name))).toEqual([]);
  const names = new Set(GROUP_PROJECT_MANAGEMENT_TOOLS.map(([name]) => name));
  const catalog = getScopedToolList(caller);
  for (const name of names) {
    const tool = catalog.find((t) => t.name === name)!;
    expect(tool, name).toBeTruthy();
    expect(tool.description).toContain('Requires group_project.');
  }
  expect(Object.keys(GROUP_PROJECT_MCP_EXCLUSIONS)).toEqual(['canvases', 'unread', 'hostMove']);
});
