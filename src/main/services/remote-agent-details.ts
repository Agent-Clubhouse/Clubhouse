/** Read-only host projections for the selected agent's Details cards (#3733). */
import { card, row, section, display } from './remote-details-presentation';
import { readConnectionCard, readActionCard, readCanvasCard } from './remote-details-cards';
import { resolveReadOnlyQuickTarget } from './read-only-quick-target';
import { readRemoteQuickDetails } from './remote-quick-details';
import * as path from 'path';
import { REMOTE_DETAILS_CARD_IDS, REMOTE_DETAILS_MAX_BYTES, type RemoteAgentDetails, type RemoteDetailsCard, type RemoteDetailsCardId } from '../../shared/remote-agent-details';
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
import { getAgentConnection, getCurrentAgentConnection } from './clubhouse-mcp/bridge-server';
import { getDispatcherState, isDispatcherIdentityAgentId } from './dispatcher/dispatcher-service';
import { isDispatcherEnabled } from './dispatcher/dispatcher-settings';
import { readAgentCardView } from './dispatcher/dispatcher-agent-card-source';
import { managedAgents, statusFor } from './managed-agents';
import { readMcpConfig, readLaunchWrapper, readDefaultMcps } from './agent-settings-service';
import { isSessionCapable } from '../orchestrators';
import { buildSessionSummary, normalizeSessionEvents, SUMMARY_TRANSCRIPT_MAX_BYTES } from './session-reader';
import { safeMcpErrorLine } from './mcp-error-text';
import { reachRows, reachSummary } from '../../shared/dispatcher-card-model';
import { viewOf as agentGrantsView } from './agent-grants-service';
import { agentDisplayState } from './agent-display-state';
import { getAgentRuntime } from './agent-runtime';
import { HELPER_TRANSFORM_UNAVAILABLE, readOnlyHelperWork } from './read-only-helper-work';
import { helpersSummary, workSummary } from '../../shared/helper-work-summary';
import { captureReadOnlyAgentTargetWitness } from './read-only-agent-target-witness';

const yes = (v: boolean) => v ? 'On' : 'Off';
const control = { 'hands-off': 'Hands off', 'ask-before-start': 'Ask before starting', 'ask-everything': 'Ask every time' };

/** No caller-supplied paths, store objects, instructions, action prompts or MCP definitions leave here. */
export async function readRemoteAgentDetails(agentId: string, authorized: () => boolean): Promise<{ status: number; body: unknown }> {
  const refused = () => ({ status: 403, body: { error: 'details_read_refused' } });
  if (!authorized()) return refused();
  try {
    const quick = await resolveReadOnlyQuickTarget(agentId, authorized);
    if (quick) return readRemoteQuickDetails(quick, authorized);
    let target: AgentConfigTarget;
    try { target = await resolveAgentConfigTarget(agentId, undefined, { strict: true }); }
    catch (error) { return !authorized() ? refused() : error instanceof Error && error.message === 'No registered agent matches that reference.'
      ? { status: 404, body: { error: 'agent_not_found' } } : { status: 500, body: { error: 'agent_inventory_unreadable' } }; }
    if (!authorized()) return refused();
    const { agent, project } = target;
    if (agent.id !== agentId || isDisposedAgent(agent)) return { status: 404, body: { error: 'agent_not_found' } };
    const dispatcher = isDispatcherIdentityAgentId(agentId);
    const targetWitness = dispatcher ? null : captureReadOnlyAgentTargetWitness(target);
    const helperReceipts: Array<{ current(): boolean }> = [];
    const provider = await resolveOrchestrator(project.path, agent.orchestrator);
    if (!authorized()) return refused();
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
      const helpers = await listHelpersEverywhere(project.path, agentId, { includeDisposed: true, readOnly: true, receipts: helperReceipts });
      const requests = listStartRequests().filter((r) => r.orchestratorId === agentId && r.projectPath === project.path);
      const live = helpers.filter((h) => !isDisposedAgent(h.config));
      row(c, 'Helpers', helpersSummary(live.length, policy.orchestrate ? policy.maxHelpers : undefined, live.filter((h) => h.config.creation?.state === 'creating').length, requests.length));
      if (helpers.length > live.length) row(c, 'Disposed helpers', helpers.length - live.length);
      let workReads = 0, workOmitted = 0;
      const workDeadline = Date.now() + 2000;
      for (const entry of helpers) {
        const { config: h, projectPath } = entry;
        const state = isDisposedAgent(h) ? 'Disposed' : h.handoff ? 'Handed off' : h.creation?.state === 'failed' ? 'Failed' : h.creation?.state === 'creating' ? 'Starting' : isAgentRunning(h.id) ? 'Running' : 'Sleeping';
        let work: string | null = null;
        if (!isDisposedAgent(h) && !h.creation) {
          if (workReads < 8 && Date.now() < workDeadline) {
            workReads++;
            const checks = await readOnlyHelperWork(target, entry, authorized);
            work = workSummary(checks);
            if (checks.error === HELPER_TRANSFORM_UNAVAILABLE) work += ' (custom Git transform)';
          } else { work = 'Work not checked (host read limit)'; workOmitted++; }
        }
        row(c, h.name, [state, h.branch, work, isDisposedAgent(h) ? h.disposedAt : '', projectPath !== project.path ? path.basename(projectPath) : '', h.creation?.state === 'failed' ? safeMcpErrorLine(h.creation.reason) : ''].filter(Boolean).join(' · '));
      }
      if (workOmitted) c.notes.push(`${workOmitted} helper work checks omitted by this read’s limit (at most 8 checks, 2 seconds to start checks). Other helper fields are shown.`);
      for (const request of requests) {
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
    await read('connections', (c) => readConnectionCard(c, dispatcher ? getDispatcherState().agentId || agentId : agentId));
    await read('actions', (c) => readActionCard(c, agentId, project.id, dispatcher));
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
    await read('canvases', (c) => readCanvasCard(c, agentId, project.id));
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
    // The complete response has finished awaiting. A stopped parent has no run
    // registration, and an earlier helper work check cannot attest later membership.
    if (targetWitness && !targetWitness.current() || helperReceipts.some((receipt) => !receipt.current())) return { status: 409, body: { error: 'agent_inventory_changed' } };
    if (running && !registration && runtime?.kind !== 'chat'
      || currentRegistration !== registration || currentRegistration?.nonce !== registeredNonce || currentRegistration?.runtime !== registeredRuntime
      || isAgentRunning(agentId) !== running
      || runtime?.kind === 'chat' && (getAgentRuntime(agentId) !== runtime || runtime.getSessionId?.() !== sessionId || (runtime.getNativeSessionId?.() ?? null) !== nativeSessionId)) {
      return { status: 409, body: { error: 'agent_run_changed' } };
    }
    result.providerEvidenceState = runtime?.kind === 'chat' && runtime.getDetailsEvidence ? 'unavailable' : 'unsupported';
    if (running && runtime?.kind === 'chat') {
      const evidence = runtime.getDetailsEvidence?.();
      if (evidence && evidence.agentId === agentId && evidence.providerId === provider.id
        && evidence.sessionId === sessionId && evidence.nativeSessionId === nativeSessionId) { result.providerEvidence = evidence; result.providerEvidenceState = 'current'; }
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
