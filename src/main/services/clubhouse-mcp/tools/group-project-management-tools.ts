/** Group Project UI management parity. No Canvas or membership prerequisite for admin. */
import { createHash, randomUUID } from 'crypto';
import type { GroupProjectCreateOptions, GroupProjectMembershipOptions } from '../../../../shared/group-project-types';
import { canonicalMemberAddress } from '../../../../shared/group-project-members';
import { GROUP_PROJECT_DEFAULT_DISABLED_TOOLS_VERSION, GROUP_PROJECT_TOOL_SUFFIXES, getDefaultGroupProjectDisabledToolsFromMetadata } from '../../../../shared/group-project-permissions';
import { groupProjectHost } from '../../group-project-host';
import * as membership from '../../group-project-membership';
import * as projectStore from '../../project-store';
import { groupProjectRemoteCreate } from '../../group-project-remote-create';
import { bindingManager } from '../binding-manager';
import { isTrackedDispatcher } from '../dispatcher-gate';
import { registerGlobalTool } from '../tool-registry';
import type { McpToolResult } from '../types';
import { McpArgError, requireBoolean, requireNumber, requireString } from './validation';

const string = { type: 'string' };
const boolean = { type: 'boolean' };
const strings = { type: 'array', items: string };
const scopeSchema = { type: 'object', properties: { level: { enum: ['app', 'project'] }, projectId: string, reach: { enum: ['local', 'network'] } }, required: ['level', 'reach'], additionalProperties: false };
const membershipSchema = { type: 'object', properties: { autoJoin: boolean, includeLinkedComputers: boolean, excluded: strings }, required: ['autoJoin', 'includeLinkedComputers', 'excluded'], additionalProperties: false };
const groupRef = { type: 'string', description: 'Group Project id or unique name from list_group_projects.' };
const author = (caller: string) => ({ agentId: caller, label: caller });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reply = (value: unknown, isError = false): McpToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError && { isError: true }) });
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new McpArgError('Expected an object.');
  return value as Record<string, unknown>;
};
function stringList(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim())) throw new McpArgError(`${key} must be a list of nonempty strings.`);
  return [...new Set(value as string[])];
}
function toolSwitches(args: Record<string, unknown>): string[] {
  const tools = stringList(args, 'disabled_tools');
  if (tools.some((t) => !(GROUP_PROJECT_TOOL_SUFFIXES as readonly string[]).includes(t))) throw new McpArgError('Unknown group project tool switch.');
  return tools;
}
function membershipOptions(value: unknown): GroupProjectMembershipOptions {
  const options = record(value);
  return { autoJoin: requireBoolean(options, 'autoJoin'), includeLinkedComputers: requireBoolean(options, 'includeLinkedComputers'), excluded: [...new Set(stringList(options, 'excluded').map((address) => canonicalMemberAddress(address, groupProjectHost.selfMachine())))] };
}
function retention(args: Record<string, unknown>) {
  const maxPerTopic = requireNumber(args, 'max_per_topic'), maxTotal = requireNumber(args, 'max_total');
  if (![maxPerTopic, maxTotal].every((v) => Number.isSafeInteger(v) && v >= 1)) throw new McpArgError('Retention limits must be positive integers.');
  return { maxPerTopic, maxTotal };
}

interface CreatePlan { name: string; host: string; options: GroupProjectCreateOptions }
const reviews = new Map<string, { caller: string; plan: CreatePlan; digest: string; expires: number }>();
const retries = new Map<string, { caller: string; host: string }>();
function createPlan(args: Record<string, unknown>): CreatePlan {
  const name = requireString(args, 'name').trim(), host = requireString(args, 'host').trim();
  if (!name || name.length > 100) throw new McpArgError('name must contain 1–100 characters.');
  if (!host) throw new McpArgError('Choose host explicitly: this or a machine from the creation preview.');
  const scope = record(args.scope);
  if (scope.level !== 'app' && scope.level !== 'project' || scope.reach !== 'local' && scope.reach !== 'network') throw new McpArgError('Choose scope level app/project and reach local/network explicitly.');
  if (scope.level === 'project' && (typeof scope.projectId !== 'string' || !scope.projectId)) throw new McpArgError('A project scope needs an explicit registered projectId.');
  if (host !== 'this' && scope.reach !== 'network') throw new McpArgError('Another host requires network reach.');
  const policy = membershipOptions(args.membership);
  if (scope.level === 'app' && (policy.autoJoin || policy.includeLinkedComputers)) throw new McpArgError('App-wide groups start empty: both automatic membership switches must be false.');
  if (scope.reach === 'local' && policy.includeLinkedComputers) throw new McpArgError('Linked computers require network reach.');
  if (args.members !== undefined && stringList(args, 'members').length) throw new McpArgError('Use the automatic membership preview and exclusions, then add explicit members with add_group_project_member.');
  return { name, host, options: { scope: scope.level === 'app' ? { level: 'app', reach: scope.reach } : { level: 'project', projectId: scope.projectId as string, reach: scope.reach }, membership: policy } };
}
async function previewCreate(plan: CreatePlan) {
  const hosts = await groupProjectRemoteCreate.listHosts();
  if (plan.host !== 'this' && !hosts.some((h) => h.machine === plan.host && h.state === 'online')) throw new McpArgError('The selected host is unavailable. Inspect hosts and choose again.');
  const preview = await membership.previewAutoJoin(plan.options.scope, plan.options.membership);
  return { ...plan, preview, hosts, scopeOptions: groupProjectHost.scopeOptions(), hostApprovalRequired: plan.host !== 'this' };
}

/** Catalog metadata doubles as the tested UI capability ledger (#3617). */
export const GROUP_PROJECT_MANAGEMENT_TOOLS = [
  ['preview_group_project_create', 'creation choices, host inventory, initial membership and exclusions', 'group_project.admin'],
  ['create_group_project', 'create on chosen host after preview', 'group_project.admin'],
  ['get_group_project_management', 'details, scope, host, membership, roster, coverage, roles, grants, notices, board settings, Actions and delivery diagnostics', 'group_project.admin'],
  ['update_group_project', 'edit name, description and instructions', 'group_project.admin'],
  ['preview_group_project_scope', 'preview project/app scope and local/network reach changes', 'group_project.admin'],
  ['set_group_project_scope', 'apply scope and reach with exact leaving review', 'group_project.admin'],
  ['add_group_project_member', 'add member or undo exclusion', 'group_project.admin'],
  ['exclude_group_project_member', 'remove member and preserve exclusion', 'group_project.admin'],
  ['set_group_project_automatic_membership', 'automatic future membership and linked computers', 'group_project.admin'],
  ['answer_group_project_auto_join_offer', 'legacy automatic membership offer', 'group_project.admin'],
  ['confirm_group_project_unlinked_members', 'review departures from unlinked copies', 'group_project.admin'],
  ['set_group_project_role', 'local lead/admin grants', 'group_project.admin'],
  ['set_group_project_own_grant', 'group deliver, wake and actions grants', 'group_project.admin'],
  ['set_group_project_default_tools', 'default tool switches and apply-to-existing choice', 'group_project.admin'],
  ['set_group_project_member_settings', 'member tool switches and saved instructions', 'group_project.admin'],
  ['set_group_project_topic_protection', 'board topic protection', 'group_project.lead'],
  ['preview_group_project_retention', 'retention values and trim preview', 'group_project.lead'],
  ['set_group_project_retention', 'apply reviewed retention and trim', 'group_project.lead'],
  ['clear_group_project_board', 'clear all board messages and topics', 'group_project.lead'],
  ['dismiss_group_project_refusals', 'dismiss delivery refusals', 'group_project.admin'],
  ['preview_delete_group_project', 'delete impact preview and caller-bound token', 'group_project.admin'],
  ['delete_group_project', 'delete with reviewed impact token', 'group_project.admin'],
] as const;

/** UI navigation and host migration are deliberate exclusions, not MCP mutations. */
export const GROUP_PROJECT_MCP_EXCLUSIONS = {
  canvases: 'Opening or placing a Canvas card is UI navigation; membership and management never require Canvas. Deletion inventories saved references.',
  unread: 'Unread markers are UI state per computer; MCP reads accept since timestamps.',
  hostMove: 'Host movement, failover and election are design-only (#3551).',
} as const;

export function registerGroupProjectManagementTools(legacyCreate?: (caller: string, args: Record<string, unknown>) => Promise<McpToolResult>): void {
  type Handler = (caller: string, args: Record<string, unknown>, id: string) => Promise<unknown>;
  const definitions = new Map(GROUP_PROJECT_MANAGEMENT_TOOLS.map(([name, capability, action]) => [name, { capability, action }]));
  const register = (name: typeof GROUP_PROJECT_MANAGEMENT_TOOLS[number][0], description: string, properties: Record<string, unknown>, required: string[], handler: Handler, creation = false) => {
    const spec = definitions.get(name)!;
    registerGlobalTool(name, {
      description: `${description} Requires ${spec.action}; Ask first uses normal approval and Allow runs directly. ${creation ? '' : 'Use a group id or unique name; no Canvas is needed.'}`,
      inputSchema: { type: 'object', properties: { ...(!creation && { group_project: groupRef }), ...properties }, required: [...(!creation ? ['group_project'] : []), ...required], additionalProperties: false },
    }, async (caller, args) => {
      try {
        // The registry resolved this id once, before checking the same id's grant.
        const id = creation ? '' : requireString(args, 'group_project');
        const value = await handler(caller, args, id);
        return value && typeof value === 'object' && 'content' in value ? value as McpToolResult : reply(value);
      } catch (error) {
        // telemetry-exempt: the typed error is returned to the caller, with no invented success.
        return reply({ error: { code: error instanceof McpArgError ? 'invalid_args' : (error as { code?: string }).code ?? 'failed', message: error instanceof Error ? error.message : String(error) } }, true);
      }
    }, { group: 'groupProjects', grant: creation
      ? { actions: [spec.action], target: 'app' }
      : { actions: [spec.action], target: 'group_project_arg', from: { args: ['group_project'] } } });
  };
  const createProperties = { name: string, scope: scopeSchema, host: { type: 'string', description: 'Explicit this, or a network machine fingerprint from preview hosts. Never guess the host.' }, membership: membershipSchema };
  register('preview_group_project_create', 'Review creation choices before creating. With no choices, lists scope options and hosts so the person can choose. App groups start empty; project auto-join keeps updating, uses explicit links and preserves exclusions.', createProperties, [], async (caller, args) => {
    if (args.scope === undefined || args.host === undefined || args.membership === undefined || args.name === undefined) return { needsChoices: ['name', 'scope (app/project, projectId when project, local/network reach)', 'host', 'membership (autoJoin, includeLinkedComputers, excluded)'], projects: (await projectStore.list()).map((p) => ({ id: p.id, name: p.displayName || p.name })), scopeOptions: groupProjectHost.scopeOptions(), hosts: await groupProjectRemoteCreate.listHosts() };
    const plan = createPlan(args), preview = await previewCreate(plan);
    for (const [token, review] of reviews) if (review.expires < Date.now()) reviews.delete(token);
    const token = randomUUID();
    reviews.set(token, { caller, plan, digest: hash(preview.preview), expires: Date.now() + 300_000 });
    return { ...preview, preview_token: token };
  }, true);
  register('create_group_project', 'Create a Group Project after preview_group_project_create. Dispatcher must collect explicit scope, reach, host and membership choices. Supply preview_token and the exact reviewed choices. Remote creation waits for destination-host approval; retry only its request id with retry_of and the same host.', { ...createProperties, members: strings, preview_token: string, retry_of: string }, ['name'], async (caller, args) => {
    if (args.retry_of !== undefined) {
      const request = requireString(args, 'retry_of'), host = requireString(args, 'host');
      const saved = retries.get(request);
      if (!saved || saved.caller !== caller || saved.host !== host) throw new McpArgError('Retry only a remote create request returned to you on this host in this session.');
      return groupProjectRemoteCreate.createOn(host, '', undefined, request);
    }
    // Compatibility for existing orchestrators. Dispatcher always takes the explicit preview path.
    if (!isTrackedDispatcher(caller) && args.scope === undefined && args.host === undefined && args.membership === undefined && legacyCreate) {
      const outcome = await legacyCreate(caller, args);
      if (outcome.isError) throw new McpArgError(outcome.content.map((c) => 'text' in c ? c.text : '').join('\n'));
      return outcome;
    }
    const plan = createPlan(args), token = requireString(args, 'preview_token'), review = reviews.get(token);
    // Claim once, synchronously: concurrent calls must not both revalidate the same review.
    // Like deletion, a failed attempt never restores the review token.
    reviews.delete(token);
    if (!review || review.caller !== caller || review.expires < Date.now() || hash(review.plan) !== hash(plan)) throw new McpArgError('Refresh the creation preview with the exact choices before creating.');
    let preview: Awaited<ReturnType<typeof previewCreate>>;
    try { preview = await previewCreate(plan); }
    catch (error) {
      // telemetry-exempt: the caller receives the failure and the explicit consumed-review outcome.
      throw new McpArgError(`Creation review consumed. Review again with preview_group_project_create before creating. ${error instanceof Error ? error.message : String(error)}`);
    }
    if (review.digest !== hash(preview.preview)) throw new McpArgError('Initial membership or coverage changed. Refresh the creation preview.');
    try {
      if (plan.host !== 'this') {
        const outcome = await groupProjectRemoteCreate.createOn(plan.host, plan.name, plan.options);
        retries.set(outcome.requestId, { caller, host: plan.host });
        return outcome;
      }
      const { createManagedGroupProject } = await import('../../group-project-management');
      const project = await createManagedGroupProject(plan.name, plan.options);
      return { status: 'created', project, membership: await membership.describeMembership(project.id) };
    } catch (error) {
      // telemetry-exempt: returned to the caller; a partial create must not invite an unchecked duplicate.
      throw new McpArgError(`Creation review consumed. Check list_group_projects for the result, then review again with preview_group_project_create. ${error instanceof Error ? error.message : String(error)}`);
    }
  }, true);

  register('get_group_project_management', 'Read management state: details, membership/exclusions/auto-joins, authoritative roster and completeness, coverage, this-computer roles, own grants, notices, default/member tools and instruction revisions, retention, Actions and delivery outcomes. Host roles on a copy are read-only. Actions use the existing list/create/update/delete/run/history tools.', {}, [], async (_caller, _args, id) => {
    const [roles, roster, coverage, guidance, actions] = await Promise.all([import('../../group-project-roles'), import('../../group-project-roster'), import('../../group-project-coverage'), import('../../connection-guidance'), import('../../actions')]);
    const project = await groupProjectHost.get(id);
    return {
      project, membership: await membership.describeMembership(id), roster: await roster.groupProjectRoster.describe(id), coverage: await coverage.listCoverage(id), roles: await roles.describeGroupProjectRoles(id),
      delivery: { mode: 'notices', operations: await groupProjectHost.operations(id) },
      defaultDisabledTools: getDefaultGroupProjectDisabledToolsFromMetadata(project?.metadata),
      retention: { maxPerTopic: project?.metadata.maxPerTopic ?? 500, maxTotal: project?.metadata.maxTotal ?? 2500 },
      memberSettings: await Promise.all(bindingManager.getAllBindings().filter((b) => b.targetKind === 'group-project' && b.targetId === id).map(async (b) => ({ agentId: b.agentId, disabledTools: b.disabledTools, guidance: await guidance.getConnectionGuidance(b.agentId, id) }))),
      actions: (await actions.listActions()).filter((a) => a.owner.kind === 'group_project' && a.owner.groupProjectId === id),
    };
  });
  const outcome = async (id: string, result: unknown) => ({ result, operations: await groupProjectHost.operations(id) });
  register('update_group_project', 'Edit name, description or instructions through the authoritative host. On a copy eligible changes may queue; report their operations as queued, applied or refused.', { name: string, description: string, instructions: string }, [], async (caller, args, id) => {
    const fields: { name?: string; description?: string; instructions?: string } = {};
    for (const key of ['name', 'description', 'instructions'] as const) if (args[key] !== undefined) fields[key] = requireString(args, key);
    if (!Object.keys(fields).length) throw new McpArgError('Supply name, description or instructions.');
    if (fields.name !== undefined && (!fields.name.trim() || fields.name.length > 100)) throw new McpArgError('name must contain 1–100 characters.');
    return outcome(id, await groupProjectHost.update(id, fields, { author: author(caller) }));
  });
  register('preview_group_project_scope', 'Preview a scope/reach change, including members leaving and returning. Only the host can change scope.', { scope: scopeSchema }, ['scope'], async (_caller, args, id) => groupProjectHost.previewScope(id, record(args.scope)));
  register('set_group_project_scope', 'Apply reviewed scope/reach on the host. confirm_leaving must match the current preview exactly.', { scope: scopeSchema, confirm_leaving: strings }, ['scope', 'confirm_leaving'], async (_caller, args, id) => groupProjectHost.setScope(id, record(args.scope), { confirmLeaving: stringList(args, 'confirm_leaving') }));
  for (const [name, operation] of [['add_group_project_member', membership.addMember], ['exclude_group_project_member', membership.excludeMember]] as const) {
    register(name, name === 'add_group_project_member' ? 'Add an eligible agent by id or host-relative address, undoing its exclusion. Remote membership needs admin Allow on the host.' : 'Exclude a durable member so automatic membership does not re-add it; helpers/quick agents lose their explicit entry. Remote changes need admin Allow on the host.', { agent: string }, ['agent'], async (caller, args, id) => outcome(id, await operation(id, requireString(args, 'agent'), { author: author(caller) })));
  }
  register('set_group_project_automatic_membership', 'Change ongoing auto-join and linked-computer switches on the host. Turning either off preserves current members. Exclusions change through add/exclude tools.', { membership: membershipSchema }, ['membership'], async (_caller, args, id) => {
    const options = membershipOptions(args.membership);
    if (options.excluded?.length) throw new McpArgError('Change exclusions with add_group_project_member/exclude_group_project_member.');
    return membership.setAutomaticMembership(id, options);
  });
  register('answer_group_project_auto_join_offer', 'Accept or dismiss an existing legacy auto-join offer. On a copy the host must permit the agent-authored change.', { accept: boolean }, ['accept'], async (caller, args, id) => outcome(id, await membership.answerAutoJoinOffer(id, requireBoolean(args, 'accept'), { author: author(caller) })));
  register('confirm_group_project_unlinked_members', 'Confirm the exact departures listed in management membership after unlinking project copies. Host-only; revalidates the review.', { confirm_leaving: strings }, ['confirm_leaving'], async (_caller, args, id) => membership.confirmUnlinkedMembers(id, stringList(args, 'confirm_leaving')));
  register('set_group_project_role', 'Set this computer’s lead or admin grant for a member to allow, ask or off. Lead and admin are separate. On a copy this does not change the host’s grants; inspect its read-only roster.', { agent: string, role: { enum: ['lead', 'admin'] }, mode: { enum: ['allow', 'ask', 'off'] } }, ['agent', 'role', 'mode'], async (_caller, args, id) => {
    const role = requireString(args, 'role'), mode = requireString(args, 'mode');
    if (role !== 'lead' && role !== 'admin' || mode !== 'allow' && mode !== 'ask' && mode !== 'off') throw new McpArgError('Choose lead/admin and allow/ask/off.');
    const roles = await import('../../group-project-roles');
    await roles.grantGroupProjectRole(id, requireString(args, 'agent'), role, mode);
    return roles.describeGroupProjectRoles(id);
  });
  register('set_group_project_own_grant', 'Set what the group may do itself: deliver notices, wake sleeping members or run Actions. Remote changes need admin Allow on the host.', { grant: { enum: ['deliver', 'wake', 'actions'] }, mode: { enum: ['allow', 'off'] } }, ['grant', 'mode'], async (caller, args, id) => {
    const grant = requireString(args, 'grant'), mode = requireString(args, 'mode');
    if (grant !== 'deliver' && grant !== 'wake' && grant !== 'actions' || mode !== 'allow' && mode !== 'off') throw new McpArgError('Choose deliver/wake/actions and allow/off.');
    return outcome(id, await (await import('../../group-project-roles')).setOwnGrant(id, grant, mode, { author: author(caller) }));
  });
  register('set_group_project_default_tools', 'Set default switches, explicitly choosing future-only or all existing local member bindings. Applying to all changes this computer’s bindings; each forwarded write still needs host admin Allow.', { disabled_tools: strings, apply_to_existing: boolean }, ['disabled_tools', 'apply_to_existing'], async (caller, args, id) => {
    const disabled = toolSwitches(args), apply = requireBoolean(args, 'apply_to_existing');
    const project = await groupProjectHost.get(id);
    const copy = project && groupProjectHost.isReplica(project);
    const result = await groupProjectHost.update(id, { metadata: { defaultDisabledTools: disabled, defaultDisabledToolsVersion: GROUP_PROJECT_DEFAULT_DISABLED_TOOLS_VERSION } }, { author: author(caller) });
    if (apply) {
      for (const b of bindingManager.getAllBindings().filter((b) => b.targetKind === 'group-project' && b.targetId === id)) {
        await membership.recordMemberDisabledTools(id, b.agentId, disabled, { author: author(caller) });
        if (!copy) bindingManager.setDisabledTools(b.agentId, id, disabled);
      }
    }
    return outcome(id, result);
  });
  register('set_group_project_member_settings', 'Set tools or saved instruction text for a current local member binding. Instructions require the revision from management and explicit replace_across_sources when its guidance review requires it. A copy cannot change host roles or other computers’ bindings.', { agent: string, disabled_tools: strings, instructions: { type: 'object', additionalProperties: string }, revision: string, replace_across_sources: boolean }, ['agent'], async (caller, args, id) => {
    const agent = requireString(args, 'agent');
    const binding = bindingManager.getBindingsForAgent(agent).find((b) => b.targetId === id && b.targetKind === 'group-project');
    if (!binding) throw new McpArgError('That agent has no local membership binding.');
    const disabled = args.disabled_tools === undefined ? undefined : toolSwitches(args);
    if (args.instructions === undefined && disabled === undefined) throw new McpArgError('Supply disabled_tools or instructions.');
    let guidance;
    if (args.instructions !== undefined) {
      const instructions = record(args.instructions);
      if (Object.values(instructions).some((v) => typeof v !== 'string')) throw new McpArgError('instructions must map tool names to text.');
      guidance = await (await import('../../connection-guidance')).saveConnectionGuidance(agent, id, { instructions: instructions as Record<string, string>, revision: requireString(args, 'revision'), replaceAcrossSources: args.replace_across_sources === true });
    }
    if (disabled) {
      const project = await groupProjectHost.get(id);
      await membership.recordMemberDisabledTools(id, agent, disabled, { author: author(caller) });
      // A copy follows the host's confirmed membership on sync; never apply queued switches optimistically.
      if (project && !groupProjectHost.isReplica(project)) bindingManager.setDisabledTools(agent, id, disabled);
    }
    return outcome(id, { guidance, requestedDisabledTools: disabled });
  });
  register('set_group_project_topic_protection', 'Protect or unprotect a board topic. Forwarded changes need lead Allow on the host; inspect queued/applied/refused operations.', { topic: string, protected: boolean }, ['topic', 'protected'], async (caller, args, id) => {
    await groupProjectHost.setTopicProtected(id, requireString(args, 'topic'), requireBoolean(args, 'protected'), { author: author(caller) });
    return outcome(id, true);
  });
  register('preview_group_project_retention', 'Preview message trimming for positive integer retention limits. Review trim count and seq before applying.', { max_per_topic: { type: 'number' }, max_total: { type: 'number' } }, ['max_per_topic', 'max_total'], async (_caller, args, id) => {
    const limits = retention(args);
    return { ...limits, wouldRemove: await groupProjectHost.estimateTrim(id, limits.maxPerTopic, limits.maxTotal), seq: (await groupProjectHost.get(id))?.seq };
  });
  register('set_group_project_retention', 'Apply host-only retention after reviewing the trim count and sequence. Refuses if the board changed since preview.', { max_per_topic: { type: 'number' }, max_total: { type: 'number' }, confirm_trim: { type: 'number' }, expected_seq: { type: 'number' } }, ['max_per_topic', 'max_total', 'confirm_trim', 'expected_seq'], async (_caller, args, id) => {
    const limits = retention(args);
    return groupProjectHost.exclusive(id, async ({ seq }) => {
      if (seq !== requireNumber(args, 'expected_seq') || await groupProjectHost.estimateTrim(id, limits.maxPerTopic, limits.maxTotal) !== requireNumber(args, 'confirm_trim')) throw new McpArgError('The board changed. Refresh the trim preview.');
      return { trimmed: await groupProjectHost.setRetention(id, limits.maxPerTopic, limits.maxTotal, { withinExclusive: true }) };
    });
  });
  register('clear_group_project_board', 'Clear all board messages and topics on the host, including protected topics. Requires explicit confirm true after reviewing the board.', { confirm: boolean }, ['confirm'], async (_caller, args, id) => {
    if (!requireBoolean(args, 'confirm')) throw new McpArgError('Review the board and pass confirm true to clear it.');
    return { removed: await groupProjectHost.clearAll(id) };
  });
  register('dismiss_group_project_refusals', 'Dismiss this computer’s recorded delivery refusals and their refused operation statuses after reviewing management diagnostics. Does not resend or cancel queued writes.', {}, [], async (_caller, _args, id) => { await groupProjectHost.dismissRefusals(id); return true; });
  register('preview_delete_group_project', 'Review host-only delete impact: members, exclusions, canvases, Actions, grants, messages, topics and machines. Returns an expiring single-use token bound to you. Surface incompleteWindows before deletion.', {}, [], async (caller, _args, id) => {
    const project = await groupProjectHost.get(id);
    if (project && groupProjectHost.isReplica(project)) throw new McpArgError(`Only ${project.hostName ?? 'the host'} can preview deletion of this group project.`);
    return (await import('../../group-project-management')).previewGroupProjectDeletion(id, `mcp:${caller}`);
  });
  register('delete_group_project', 'Delete on the host using the exact token from preview_delete_group_project. Rechecks impact and uses the UI’s recoverable cascade. Agents themselves are never deleted.', { token: string }, ['token'], async (caller, args, id) => { await (await import('../../group-project-management')).groupProjectDeletion.confirm(id, `mcp:${caller}`, requireString(args, 'token')); return { deleted: true }; });
}
