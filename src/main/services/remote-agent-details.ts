/** Read-only host projections for the selected agent's Details cards (#3733). */
import * as path from 'path';
import { REMOTE_DETAILS_CARD_IDS, REMOTE_DETAILS_MAX_BYTES, REMOTE_DETAILS_MAX_ROWS, type RemoteAgentDetails, type RemoteDetailsCard, type RemoteDetailsCardId } from '../../shared/remote-agent-details';
import { CONNECTION_SOURCE_LABELS } from '../../shared/connection-sources';
import { localDirectionTools } from '../../shared/connection-grants';
import { describeAction } from '../../shared/actions';
import { GRANT_GATED_SKILL_IDS } from '../../shared/managed-agents-types';
import { isDisposedAgent } from '../../shared/agent-helpers';
import { resolveAgentConfigTarget, type AgentConfigTarget } from './agent-config-reader';
import { readRemoteAgentSettings } from './remote-agent-settings';
import { resolveOrchestrator, isAgentRunning } from './agent-system';
import { agentRegistry } from './agent-registry';
import { resolveOrchestrationPolicies } from './orchestration-policy';
import { getGlobalHelperCap } from './orchestration-settings';
import { listHelpersEverywhere } from './helper-index';
import { listStartRequests } from './helper-start-requests';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { getAgentConnection, getCurrentAgentConnection } from './clubhouse-mcp/bridge-server';
import { listConnectionSources } from './connection-sources';
import { listConnectionDirectionsForInspection } from './connection-grants-store';
import { getDispatcherState, isDispatcherIdentityAgentId } from './dispatcher/dispatcher-service';
import { isDispatcherEnabled } from './dispatcher/dispatcher-settings';
import { readAgentCardView } from './dispatcher/dispatcher-agent-card-source';
import { listActions, actionNames } from './actions';
import { getAgentCanvasMemberships } from './canvas-store-reader';
import { managedAgents, statusFor } from './managed-agents';
import { readMcpConfig, readLaunchWrapper, readDefaultMcps } from './agent-settings-service';
import { isSessionCapable } from '../orchestrators';
import { buildSessionSummary, normalizeSessionEvents, SUMMARY_TRANSCRIPT_MAX_BYTES } from './session-reader';
import { redactSecretValues } from '../telemetry/diag-redaction';
import { safeMcpErrorLine } from './mcp-error-text';
import { reachRows, reachSummary } from '../../shared/dispatcher-card-model';
import { viewOf as agentGrantsView } from './agent-grants-service';
import { agentDisplayState } from './agent-display-state';
import { getAgentRuntime } from './agent-runtime';

/** Redact before cutting so a partial credential cannot evade the existing secret patterns. */
const display = (value: unknown, max = 2048) => {
  const text = redactSecretValues(String(value)).replace(/[\x00-\x1f\x7f]/g, ' ');
  return text.length > max ? `${text.slice(0, max - 24)}… [text truncated]` : text;
};
const yes = (v: boolean) => v ? 'On' : 'Off';
const control = { 'hands-off': 'Hands off', 'ask-before-start': 'Ask before starting', 'ask-everything': 'Ask every time' };

function card(id: RemoteDetailsCardId, title: string): RemoteDetailsCard {
  return { id, title, state: 'ok', summary: '', rows: [], notes: [], omitted: 0, observedAt: Date.now() };
}
function row(c: RemoteDetailsCard, label: string, value: unknown) {
  if (value === undefined || value === null || value === '') return;
  if (c.rows.length >= REMOTE_DETAILS_MAX_ROWS) { c.omitted++; return; }
  c.rows.push({ label: display(label), value: display(value) });
}
async function section(c: RemoteDetailsCard, run: () => Promise<void> | void) {
  try { await run(); }
  catch { // telemetry-exempt: a safe per-card error is the result; no raw host error crosses the wire.
    c.state = 'error'; c.summary = 'Couldn’t read from host'; c.notes.push('Couldn’t read this section. Refresh to try again.');
  }
}

/** No caller-supplied paths, store objects, instructions, action prompts or MCP definitions leave here. */
export async function readRemoteAgentDetails(agentId: string, authorized: () => boolean): Promise<{ status: number; body: unknown }> {
  const refused = () => ({ status: 403, body: { error: 'details_read_refused' } });
  if (!authorized()) return refused();
  try {
    let target: AgentConfigTarget;
    try { target = await resolveAgentConfigTarget(agentId, undefined, { strict: true }); }
    catch (error) { return !authorized() ? refused() : error instanceof Error && error.message === 'No registered agent matches that reference.'
      ? { status: 404, body: { error: 'agent_not_found' } } : { status: 500, body: { error: 'agent_inventory_unreadable' } }; }
    if (!authorized()) return refused();
    const { agent, project } = target;
    if (agent.id !== agentId || isDisposedAgent(agent)) return { status: 404, body: { error: 'agent_not_found' } };
    const provider = await resolveOrchestrator(project.path, agent.orchestrator);
    if (!authorized()) return refused();
    const dispatcher = isDispatcherIdentityAgentId(agentId);
    const running = isAgentRunning(agentId);
    const registration = agentRegistry.get(agentId);
    const registeredNonce = registration?.nonce;
    const registeredRuntime = registration?.runtime;
    const runtime = getAgentRuntime(agentId);
    const sessionId = runtime?.kind === 'chat' ? runtime.getSessionId?.() ?? null : null;
    const nativeSessionId = runtime?.kind === 'chat' ? runtime.getNativeSessionId?.() ?? null : null;
    const lifecycle = agentDisplayState(agent, running);
    const cwd = agentRegistry.get(agentId)?.cwd || agent.worktreePath || project.path;
    const cards = [card('settings', 'Settings'), card('dispatcher', 'Dispatcher'), card('orchestrate', 'Orchestration'), card('connections', 'Connections'), card('actions', 'Actions'), card('skills-mcp', 'Skills and MCP'), card('session', 'Session'), card('canvases', 'Canvases'), card('changes', 'Changes')];
    const byId = Object.fromEntries(cards.map((c) => [c.id, c])) as Record<RemoteDetailsCardId, RemoteDetailsCard>;
    if (dispatcher) for (const id of ['dispatcher', 'orchestrate', 'skills-mcp', 'session', 'canvases', 'changes'] as const) byId[id].state = 'not-applicable';
    if (agent.parentAgentId) byId.dispatcher.state = 'not-applicable';
    const result: RemoteAgentDetails = { version: 1, readOnly: true, agentId, readAt: Date.now(), providerId: provider.id, running, status: lifecycle.status, spawnedAt: lifecycle.spawnedAt ?? null, sessionId, nativeSessionId, settings: null, cards };
    const settingsRead = await readRemoteAgentSettings(agentId, authorized);
    if (!authorized()) return refused();
    if (settingsRead.status === 200) result.settings = settingsRead.body as RemoteAgentDetails['settings'];
    else byId.settings.state = 'error';

    // Sequential sections keep disk/git pressure bounded. Check authority around every section.
    const read = async (id: RemoteDetailsCardId, run: (c: RemoteDetailsCard) => Promise<void> | void) => {
      if (!authorized()) throw new Error('revoked');
      const c = byId[id];
      if (c.state !== 'not-applicable') await section(c, () => run(c));
      c.observedAt = Date.now();
      if (!authorized()) throw new Error('revoked');
    };
    await read('settings', async (c) => {
      row(c, 'Context notice', agent.contextWindowNotice);
      row(c, 'CLI start', lifecycle.error);
      if (!agent.managed) {
        const names = new Set((await readMcpConfig(cwd, provider.conventions, { strict: true })).map((s) => s.name));
        if (await readLaunchWrapper(project.path, { strict: true })) for (const id of agent.mcpIds ?? await readDefaultMcps(project.path, { strict: true })) names.add(id);
        if (result.settings) result.settings.setup.mcps = [...names].slice(0, 100).map((name) => display(name, 1024));
        if (names.size > 100) c.omitted += names.size - 100;
        row(c, 'MCP servers', `${names.size} configured`);
        return;
      }
      const setup = agent.managed;
      const service = managedAgents();
      const entries = await service.liveEntries();
      let template: Awaited<ReturnType<typeof service.getTemplate>> | null = null;
      if (setup.templateId) {
        try { template = await service.getTemplate(setup.templateId); }
        catch { c.notes.push('The template is no longer available. Other setup fields are shown independently.'); }
      }
      const status = await statusFor(project.path, agentId);
      const names = (ids: string[]) => ids.map((id) => entries[id]?.name ?? 'No longer in the library').join(', ');
      if (setup.helperChanges && (setup.helperChanges.added.length || setup.helperChanges.removed.length)) {
        row(c, 'Built from', [template?.name ?? 'No longer in the library', setup.helperChanges.added.length ? `plus ${names(setup.helperChanges.added)}` : '', setup.helperChanges.removed.length ? `minus ${names(setup.helperChanges.removed)}` : ''].filter(Boolean).join(', '));
      }
      if (template?.updatedBy) row(c, 'Template changed', `${template.updatedBy}${template.updatedAt ? ` · ${template.updatedAt}` : ''}`);
      if (status.running && status.waiting) for (const change of status.changes.length ? status.changes : ['Setup changed']) row(c, 'Waiting', change);
      if (status.migrated) row(c, 'Switched to managed', `${status.migrated.from} · backup: ${status.migrated.backup}`);
      if (status.migrationFailed) row(c, 'Migration failed', status.migrationFailed);
      if (status.deliveryFailed) row(c, 'Setup delivery', safeMcpErrorLine(status.deliveryFailed));
    });
    await read('orchestrate', async (c) => {
      const policy = (await resolveOrchestrationPolicies(project.path, [agent])).get(agentId);
      if (!policy) throw new Error('missing_policy');
      c.summary = policy.orchestrate ? `${control[policy.control]} · up to ${policy.maxHelpers}` : 'off';
      if (!agent.parentAgentId) {
      row(c, 'Orchestration', yes(policy.orchestrate));
      row(c, 'Helpers get', policy.access === 'same' ? 'Same as this agent' : policy.access);
      row(c, 'Control', control[policy.control]);
      row(c, 'At once', policy.maxHelpers);
      row(c, 'App-wide limit', getGlobalHelperCap());
      row(c, 'Cross-project helpers', yes(policy.crossProjectHelpers));
      row(c, 'Auto provider', `${yes(policy.autoHelpers)}${policy.autoEffective ? ` · ${policy.autoEffective.effective ? 'available' : policy.autoEffective.reason ?? 'unavailable'} (${policy.autoEffective.source})` : ''}`);
      }
      const helpers = await listHelpersEverywhere(project.path, agentId, { includeDisposed: true, readOnly: true });
      for (const { config: h, projectPath } of helpers) {
        const state = isDisposedAgent(h) ? 'Disposed' : h.handoff ? 'Handed off' : h.creation?.state === 'failed' ? 'Failed' : h.creation?.state === 'creating' ? 'Starting' : isAgentRunning(h.id) ? 'Running' : 'Sleeping';
        row(c, h.name, [state, h.branch, isDisposedAgent(h) ? h.disposedAt : '', projectPath !== project.path ? path.basename(projectPath) : '', h.creation?.state === 'failed' ? safeMcpErrorLine(h.creation.reason) : ''].filter(Boolean).join(' · '));
      }
      for (const request of listStartRequests().filter((r) => r.orchestratorId === agentId && r.projectPath === project.path)) {
        row(c, 'Waiting to start', `${request.args.name} · ${request.args.task} · expires ${request.expiresAt}`);
      }
      if (agent.parentAgentId && !helpers.length) c.state = 'not-applicable';
      if (!running && policy.orchestrate) c.notes.push('The helper tools appear the next time this agent starts.');
    });
    await read('dispatcher', async (c) => {
      if (!isDispatcherEnabled()) { c.state = 'not-applicable'; return; }
      const policy = (await resolveOrchestrationPolicies(project.path, [agent])).get(agentId);
      const state = getDispatcherState();
      c.title = display(state.config?.name || 'Dispatcher');
      c.summary = policy?.connectToDispatcher ? 'connected' : 'not connected';
      row(c, 'Connected', yes(!!policy?.connectToDispatcher));
      if (policy?.connectToDispatcher) {
        const view = await readAgentCardView(agentId);
        row(c, 'Description', view?.state === 'asking' ? 'Asking what it does…' : view?.state === 'ready' ? 'Ready' : 'No description yet');
        row(c, 'When to reach it', view?.card?.contactWhen || 'Not given');
        row(c, 'Owns', view?.card?.owns || 'Not given');
        if (state.config && state.agentId) {
          const reach = reachRows(agentGrantsView(state.agentId, state.config));
          row(c, `${c.title} can`, reachSummary(reach));
          for (const r of reach) row(c, r.label, `${r.mode === 'allow' ? 'Allow' : r.mode === 'ask' ? 'Ask first' : 'Off'}${r.everyAgent ? ' · set for every agent' : ''}`);
        } else c.notes.push('The host Dispatcher’s permissions are not available.');
      }
    });
    await read('connections', async (c) => {
      // Dispatcher chat and controller share one identity, as the local Connections card does.
      const wiresId = dispatcher ? getDispatcherState().agentId || agentId : agentId;
      const bindings = bindingManager.getAllBindings().filter((b) => b.agentId === wiresId || b.targetKind === 'agent' && b.targetId === wiresId);
      const sources = await listConnectionSources(wiresId);
      const directions = listConnectionDirectionsForInspection(wiresId);
      const pairs = new Map<string, { from: string; to: string; name: string; kind: string; bound: boolean; sources: string[]; disabled?: string[]; enabled?: string[] }>();
      const key = (from: string, to: string) => `${from}\0${to}`;
      for (const b of bindings) pairs.set(key(b.agentId, b.targetId), { from: b.agentId, to: b.targetId, name: b.agentId === wiresId ? b.targetName || b.projectName || b.label : b.agentName || b.agentId, kind: b.targetKind, bound: true, sources: [], disabled: b.disabledTools, enabled: b.enabledTools });
      for (const p of sources.pairs) {
        const k = key(p.agentId, p.targetId);
        const item = pairs.get(k) ?? { from: p.agentId, to: p.targetId, name: p.agentId === wiresId ? p.inspection?.targetName || p.targetId : p.inspection?.agentName || p.agentId, kind: 'agent', bound: p.bound, sources: [] };
        item.sources = p.sources.map((s) => `${CONNECTION_SOURCE_LABELS[s.kind]}${s.suspended ? ` (${s.suspended})` : ''}`);
        if (p.unresolved) item.sources.push('Source unresolved');
        pairs.set(k, item);
      }
      c.summary = `${pairs.size} directions`;
      for (const p of pairs.values()) {
        const direction = directions.find((d) => !d.from.machineId && !d.to.machineId && d.from.agentId === p.from && d.to.agentId === p.to);
        const tools = localDirectionTools(direction, p.disabled, p.enabled);
        row(c, p.name, `${p.kind} · ${p.from === wiresId ? 'to' : 'from'} · ${p.bound ? 'connected' : 'saved, not connected'}${p.sources.length ? ` · ${p.sources.join(', ')}` : ''}`);
        if (p.kind === 'agent') row(c, `${p.name} permissions`, `Allowed: ${tools.allowed.join(', ') || 'none'}; Off: ${tools.disabled.join(', ') || 'none'}`);
      }
      for (const source of sources.unreadable) c.notes.push(`Couldn’t read connection source: ${display(source)}`);
      if (!pairs.size) c.notes.push('No Clubhouse MCP wires.');
    });
    await read('actions', (c) => {
      const all = listActions();
      const related = all.filter((a) => dispatcher ? a.owner.kind === 'dispatcher' : a.owner.kind === 'agent' && a.owner.agentId === agentId
        || a.steps.some((s) => s.kind === 'quick' ? s.worktreeAgentId === agentId : 'agentId' in s && s.agentId === agentId)
        || a.trigger.kind === 'event' && (a.trigger.source.kind === 'agent' && a.trigger.source.agentId === agentId || a.trigger.source.kind === 'project' && a.trigger.source.projectId === project.id));
      c.summary = `${related.length} ${dispatcher ? 'made by the Dispatcher' : 'related'}`;
      for (const a of related) {
        const groups = dispatcher ? [] : [a.owner.kind === 'agent' && a.owner.agentId === agentId ? 'Owned by this agent' : '', a.steps.some((s) => s.kind === 'quick' ? s.worktreeAgentId === agentId : 'agentId' in s && s.agentId === agentId) ? 'Targets this agent' : '', a.trigger.kind === 'event' && (a.trigger.source.kind === 'agent' && a.trigger.source.agentId === agentId || a.trigger.source.kind === 'project' && a.trigger.source.projectId === project.id) ? 'Set off by this agent' : ''].filter(Boolean);
        row(c, a.name, [a.enabled ? 'On' : 'Off', ...groups, describeAction(a, actionNames()), a.lastRun?.outcome].filter(Boolean).join(' · '));
      }
      if (!related.length) c.notes.push(dispatcher ? 'No actions made by the Dispatcher.' : 'No actions are owned by, target or are set off by this agent.');
    });
    await read('skills-mcp', async (c) => {
      const status = await statusFor(project.path, agentId);
      const entries = agent.managed ? await managedAgents().liveEntries() : {};
      for (const id of agent.managed?.skills ?? []) {
        if (GRANT_GATED_SKILL_IDS.includes(id)) continue;
        row(c, 'Skill', `${entries[id]?.name ?? 'No longer in the library'} · ${running && status.deliveredAt && !status.waiting && !status.deliveryFailed && status.deliveredSkillIds?.includes(id) ? 'Installed by Clubhouse' : 'Set up by Clubhouse'}`);
      }
      for (const skill of status.builtinSkills ?? []) row(c, 'Skill', `${skill.name} · ${running && skill.deliveredAt ? 'Installed by Clubhouse' : 'Set up by Clubhouse'}`);
      if (running) {
        const connection = getAgentConnection(agentId);
        const current = getCurrentAgentConnection(agentId);
        row(c, 'Clubhouse MCP', current ? `Connected${current.toolCount == null ? '' : ` · ${current.toolCount} tools`} · ${new Date(current.connectedAt).toISOString()}` : connection ? 'An earlier handshake is retained; connection for this run is not confirmed' : 'No handshake reported for this run');
        for (const name of result.settings?.setup.mcps ?? []) row(c, 'MCP configured', name);
        for (const problem of status.mcpProblems ?? []) row(c, problem.server, `Missing environment variables: ${problem.missingEnv.join(', ')}`);
      } else c.notes.push('Last session evidence only. No live MCP connection is claimed while the agent is stopped.');
      c.notes.push('Configured and installed skills do not confirm provider loading or use. Provider reports are shown separately.');
    });
    await read('session', async (c) => {
      c.title = running ? 'Session' : 'Last session';
      row(c, 'Status', lifecycle.status);
      row(c, 'Folder', cwd);
      row(c, 'Branch', agent.branch);
      if (!running && agent.lastSleep) {
        row(c, 'Ended', agent.lastSleep.at);
        row(c, 'Why', `${agent.lastSleep.reason}${agent.lastSleep.by ? ` · ${agent.lastSleep.by}` : ''}${agent.lastSleep.idleMinutes == null ? '' : ` · ${agent.lastSleep.idleMinutes} min idle`}${agent.lastSleep.exitCode == null ? '' : ` · exit code ${agent.lastSleep.exitCode}`}`);
      }
      if ((lifecycle.status === 'sleeping' || lifecycle.status === 'error') && agent.lastSessionId) {
        if (!isSessionCapable(provider)) { c.notes.push('This provider does not support reading last session usage.'); return; }
        const raw = await provider.readSessionTranscript(agent.lastSessionId, cwd, { maxBytes: SUMMARY_TRANSCRIPT_MAX_BYTES });
        if (!raw) { c.notes.push('No earlier session usage reported by the provider.'); return; }
        const summary = buildSessionSummary(normalizeSessionEvents(raw), provider.id);
        row(c, 'Duration', summary.totalDurationMs ? `${summary.totalDurationMs} ms` : null);
        row(c, 'Cost', summary.totalCostUsd ? `$${summary.totalCostUsd.toFixed(2)}` : null);
        row(c, 'Ended', summary.lastActiveAt);
      } else if (!running) c.notes.push('No earlier session recorded.');
    });
    await read('canvases', async (c) => {
      const hits = await getAgentCanvasMemberships(agentId, project.id, { strict: true });
      c.summary = `on ${hits.length} ${hits.length === 1 ? 'board' : 'boards'}`;
      for (const hit of hits) {
        const before = c.rows.length;
        row(c, hit.name, hit.scope === 'app' ? 'Home' : 'card');
        if (c.rows.length > before && hit.canvasId && hit.viewId && hit.canvasId.length <= 2048 && hit.viewId.length <= 2048) {
          c.rows[c.rows.length - 1].canvas = { scope: hit.scope, canvasId: hit.canvasId, viewId: hit.viewId };
        }
      }
      if (!hits.length) c.state = 'not-applicable';
    });
    await read('changes', (c) => {
      c.summary = 'Branch, session and last turn';
      c.notes.push('File comparisons are read through the host’s bounded read-only Changes service.');
    });
    if (!authorized()) return refused();
    for (const c of cards) {
      c.notes = c.notes.map((note) => display(note));
      if (c.notes.length > 20) c.notes = [...c.notes.slice(0, 19), `${c.notes.length - 19} more notices omitted by the host’s display limit.`];
    }
    const currentRegistration = agentRegistry.get(agentId);
    if (running && !registration && runtime?.kind !== 'chat'
      || currentRegistration !== registration || currentRegistration?.nonce !== registeredNonce || currentRegistration?.runtime !== registeredRuntime
      || isAgentRunning(agentId) !== running
      || runtime?.kind === 'chat' && (getAgentRuntime(agentId) !== runtime || runtime.getSessionId?.() !== sessionId || (runtime.getNativeSessionId?.() ?? null) !== nativeSessionId)) {
      return { status: 409, body: { error: 'agent_run_changed' } };
    }
    // Enforce the envelope even when every section fits its individual row limit.
    while (Buffer.byteLength(JSON.stringify(result)) > REMOTE_DETAILS_MAX_BYTES) {
      const largest = cards.filter((c) => c.rows.length).sort((a, b) => JSON.stringify(b.rows).length - JSON.stringify(a.rows).length)[0];
      if (!largest) throw new Error('details_limit');
      largest.rows.pop(); largest.omitted++;
    }
    if (cards.length !== REMOTE_DETAILS_CARD_IDS.length) throw new Error('details_contract');
    return { status: 200, body: result };
  } catch {
    // telemetry-exempt: no host errors or partial evidence after revocation leave this boundary.
    return authorized() ? { status: 500, body: { error: 'details_read_failed' } } : refused();
  }
}
