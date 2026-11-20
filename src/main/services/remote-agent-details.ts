import { createHash } from 'crypto';
import { readSelectedManagedPartsPage } from './selected-managed-parts-page';
import { REMOTE_MANAGED_INVENTORY_SOURCES } from '../../shared/remote-inventory-page';
import { readSelectedHelperPage } from './selected-helper-page';
import { readSavedGroupConnectionsForDisplay } from './saved-group-connections-display';
import { readHelperParentConnectionForDisplay } from './helper-parent-connection-display';
import { readSavedCanvasConnectionsForDisplay } from './saved-canvas-connections-display';
import { readSavedToolConnectionsForDisplay } from './saved-tool-connections-display';
import { isRemoteDetailsQuery, REMOTE_CONNECTION_PAGE_SOURCES, type RemoteDetailsQuery } from '../../shared/remote-details-query';
import { readConfiguredRegisteredConnectionsForDisplay } from './configured-registered-connections-display';
import { projectConnectionEndpointFieldsForDisplay } from './connection-endpoint-fields-display';
/** Read-only host projections for the selected agent's Details cards (#3733). */
import { readHistoricalSessionCard } from './remote-session-history';
import { card, row, section, display, selectedConnectionPageEnvelope } from './remote-details-presentation';
import { readConnectionCard, readActionCard, readCanvasCard } from './remote-details-cards';
import { resolveReadOnlyQuickTarget } from './read-only-quick-target';
import { readRemoteQuickDetails } from './remote-quick-details';
import { REMOTE_DETAILS_CARD_IDS, REMOTE_DETAILS_MAX_BYTES, type RemoteAgentDetails, type RemoteDetailsCard, type RemoteDetailsCardId } from '../../shared/remote-agent-details';
import { GRANT_GATED_SKILL_IDS } from '../../shared/managed-agents-types';
import { isDisposedAgent } from '../../shared/agent-helpers';
import { resolveAgentConfigTarget, type AgentConfigTarget } from './agent-config-reader';
import { readRemoteAgentSettings } from './remote-agent-settings';
import { isAgentRunning } from './agent-system';
import { agentRegistry } from './agent-registry';
import { readHelperAccessNoteForDisplay } from './helper-access-display';
import { readOrchestrationForDisplay } from './orchestration-display';
import { projectOrchestrationFields, projectPendingHelperStarts } from './remote-orchestration-card';
import { listHelpersEverywhere } from './helper-index';
import { readStartRequestsForDisplay } from './helper-start-requests';
import { getAgentConnection, getCurrentAgentConnection } from './clubhouse-mcp/bridge-server';
import { isDispatcherIdentityAgentId } from './dispatcher/dispatcher-service';
import { dispatcherControllerForDisplay, readDispatcherCard } from './remote-dispatcher-card';
import { configuredDispatcherDirections } from './configured-dispatcher-directions';
import { readMcpConfig, readLaunchWrapper, readDefaultMcps } from './agent-settings-service';
import { getProvider } from '../orchestrators';
import { agentDisplayState } from './agent-display-state';
import { getAgentRuntime } from './agent-runtime';
import { helpersSummary } from '../../shared/helper-work-summary';
import { captureReadOnlyConfigTargetWitness } from './read-only-config-target';
import { captureDisplayProvider } from './display-provider';
import { readAgentConnectionCacheForDisplay } from './agent-config';
import { readSelectedOutgoingWiresForDisplay } from './selected-outgoing-wires-display';

/** No caller-supplied paths, store objects, instructions, action prompts or MCP definitions leave here. */
export async function readRemoteAgentDetails(agentId: string, authorized: () => boolean, query?: RemoteDetailsQuery): Promise<{ status: number; body: unknown }> {
  const refused = () => ({ status: 403, body: { error: 'details_read_refused' } });
  if (!authorized()) return refused();
  if (query !== undefined && !isRemoteDetailsQuery(query)) return { status: 400, body: { error: 'invalid_details_query' } };
  query = query && { ...query };
  try {
    const quick = await resolveReadOnlyQuickTarget(agentId, authorized);
    if (quick) return query?.card === 'orchestrate' ? { status: 400, body: { error: 'unsupported_helper_page' } } : readRemoteQuickDetails(quick, authorized, query);
    let target: AgentConfigTarget;
    try { target = await resolveAgentConfigTarget(agentId, undefined, { strict: true }); }
    catch (error) { return !authorized() ? refused() : error instanceof Error && error.message === 'No registered agent matches that reference.'
      ? { status: 404, body: { error: 'agent_not_found' } } : { status: 500, body: { error: 'agent_inventory_unreadable' } }; }
    if (!authorized()) return refused();
    const { agent, project } = target;
    if (agent.id !== agentId || isDisposedAgent(agent)) return { status: 404, body: { error: 'agent_not_found' } };
    const dispatcher = isDispatcherIdentityAgentId(agentId);
    const targetWitness = captureReadOnlyConfigTargetWitness(target);
    const helperReceipts: Array<{ current(): boolean }> = [];
    const settingsReceipts: Array<{ current(): boolean }> = [];
    const orchestrationReceipts: Array<{ current(): boolean }> = [];
    const dispatcherReceipts: Array<{ current(): boolean }> = [];
    const connectionReceipts: Array<{ current(): boolean }> = [];
    const connectionHelpers = new Set<string>();
    const controller = dispatcherControllerForDisplay({ receipts: dispatcherReceipts, authorized });
    let orchestration: ReturnType<typeof readOrchestrationForDisplay> | undefined;
    const readPolicy = () => orchestration ??= readOrchestrationForDisplay(target, { receipts: orchestrationReceipts });
    const providerRead = captureDisplayProvider(target), provider = providerRead.provider;
    if (!authorized()) return refused();
    const running = isAgentRunning(agentId);
    const registration = agentRegistry.get(agentId);
    const registeredNonce = registration?.nonce;
    const registeredRuntime = registration?.runtime;
    const registeredProvider = registration?.orchestrator, registeredCwd = registration?.cwd;
    const providerId = running ? registeredProvider || 'unknown' : provider?.id || 'unknown';
    const providerLabel = (id: string) => id === 'unknown' ? 'Not reported by host' : display(id === provider?.id ? provider.displayName || id : getProvider(id)?.displayName || id);
    const runtime = getAgentRuntime(agentId);
    const sessionId = runtime?.kind === 'chat' ? runtime.getSessionId?.() ?? null : null;
    const nativeSessionId = runtime?.kind === 'chat' ? runtime.getNativeSessionId?.() ?? null : null;
    const displayRunId = runtime?.kind === 'chat' ? runtime.getDisplayRunId?.() ?? null : null;
    const lifecycle = agentDisplayState(agent, running);
    const cwd = agentRegistry.get(agentId)?.cwd || agent.worktreePath || project.path;
    const cards = [card('settings', 'Settings'), card('dispatcher', 'Dispatcher'), card('orchestrate', 'Orchestration'), card('connections', 'Connections'), card('actions', 'Actions'), card('skills-mcp', 'Skills and MCP'), card('session', 'Session'), card('canvases', 'Canvases'), card('changes', 'Changes')];
    const byId = Object.fromEntries(cards.map((c) => [c.id, c])) as Record<RemoteDetailsCardId, RemoteDetailsCard>;
    if (dispatcher) for (const id of ['dispatcher', 'orchestrate', 'skills-mcp', 'session', 'canvases', 'changes'] as const) byId[id].state = 'not-applicable';
    if (agent.parentAgentId) byId.dispatcher.state = 'not-applicable';
    const result: RemoteAgentDetails = { version: 1, connectionPages: 1, connectionPageEnvelope: 1, connectionPageSources: REMOTE_CONNECTION_PAGE_SOURCES.filter((source) => source === 'helper-parent' ? !!agent.parentAgentId && !dispatcher : source === 'dispatcher-auto' ? dispatcher : source === 'manual-dispatcher' ? !dispatcher && !agent.parentAgentId : source === 'helpers' ? !dispatcher : true), readOnly: true, agentId, readAt: Date.now(), providerId, providerLabel: providerLabel(providerId), running, status: lifecycle.status, spawnedAt: lifecycle.spawnedAt ?? null, sessionId, nativeSessionId, settings: null, cards };
    if (!dispatcher && agent.managed?.version === 1) { result.inventoryPages = 1; result.inventorySources = [...REMOTE_MANAGED_INVENTORY_SOURCES]; }
    if (query?.card === 'skills-mcp') {
      if (dispatcher || !result.inventorySources?.includes(query.source)) return { status: 400, body: { error: 'unsupported_inventory_page' } };
      const receipts: Array<{ current(): boolean }> = [];
      result.inventoryPage = await readSelectedManagedPartsPage(target, query, { authorized, target: targetWitness, receipts });
      if (!authorized()) return refused();
      if (!targetWitness.current()) return { status: 409, body: { error: 'agent_inventory_changed' } };
      if (!providerRead.receipt.current()) return { status: 409, body: { error: 'settings_evidence_changed' } };
      if (receipts.some((receipt) => !receipt.current())) return { status: 409, body: { error: 'inventory_evidence_changed' } };
      const now = agentRegistry.get(agentId);
      if (running && !registration && runtime?.kind !== 'chat' || now !== registration || now?.nonce !== registeredNonce || now?.runtime !== registeredRuntime || now?.orchestrator !== registeredProvider || now?.cwd !== registeredCwd
        || isAgentRunning(agentId) !== running || getAgentRuntime(agentId) !== runtime
        || runtime?.kind === 'chat' && (runtime.getSessionId?.() !== sessionId || (runtime.getNativeSessionId?.() ?? null) !== nativeSessionId || (runtime.getDisplayRunId?.() ?? null) !== displayRunId)) return { status: 409, body: { error: 'agent_run_changed' } };
      result.inventoryPageOnly = true;
      delete result.connectionPages; delete result.connectionPageEnvelope; delete result.connectionPageSources;
      for (const c of cards) { c.rows = []; c.notes = []; c.omitted = 0; c.summary = c.id === 'skills-mcp' ? 'Selected configured metadata page' : 'Not included in this selected inventory page'; if (c.id !== 'skills-mcp') c.requested = false; }
      if (!authorized()) return refused();
      if (Buffer.byteLength(JSON.stringify(result)) > REMOTE_DETAILS_MAX_BYTES) throw new Error('inventory_page_limit');
      return { status: 200, body: result };
    }
    const settingsRead = await readRemoteAgentSettings(agentId, authorized, { admittedTarget: target, admittedProvider: providerRead, receipts: settingsReceipts });
    if (!authorized()) return refused();
    // A failed freshness/authority check is a refusal of this assembly, not
    // an independently unavailable field such as the supported partial 503.
    if (settingsRead.status === 403) return refused();
    if (settingsRead.status === 409) return { status: 409, body: { error: 'settings_evidence_changed' } };
    if (!providerRead.receipt.current()) return { status: 409, body: { error: 'settings_evidence_changed' } };
    if (settingsRead.status === 200) result.settings = settingsRead.body as RemoteAgentDetails['settings'];
    else byId.settings.state = 'error';
    if (settingsRead.display) {
      byId.settings.rows.push(...settingsRead.display.rows); byId.settings.notes.push(...settingsRead.display.notes);
      byId.settings.omitted += settingsRead.display.omitted;
      if (settingsRead.display.state !== 'ok') { byId.settings.state = settingsRead.display.state; byId.settings.summary = settingsRead.display.summary; }
    }

    if (!dispatcher && !query) result.outgoingWires = readSelectedOutgoingWiresForDisplay(agentId, { authorized, target: targetWitness, receipts: connectionReceipts });

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
        if (!provider) throw new Error('provider_unavailable');
        const names = new Set((await readMcpConfig(cwd, provider.conventions, { strict: true })).map((s) => s.name));
        if (await readLaunchWrapper(project.path, { strict: true })) for (const id of agent.mcpIds ?? await readDefaultMcps(project.path, { strict: true })) names.add(id);
        if (result.settings) result.settings.setup.mcps = [...names].slice(0, 100).map((name) => display(name, 1024));
        if (names.size > 100) c.omitted += names.size - 100;
        row(c, 'MCP servers', `${names.size} configured`);
        if (!result.settings) for (const name of [...names].slice(0, 100)) row(c, 'MCP configured', display(name, 1024));
        return;
      }
      // Managed Settings fields were projected once from the admitted target.
    });
    await read('orchestrate', async (c) => {
      const model = readPolicy();
      const { enabled, limit } = projectOrchestrationFields(c, model, agent.name, !!agent.parentAgentId);
      if (!agent.parentAgentId && enabled === true) {
        const access = readHelperAccessNoteForDisplay(agentId, project.path, agent.name, model.fields.access, { receipts: orchestrationReceipts });
        row(c, 'Helper access ceiling', access.state === 'ok' ? access.value : 'Unavailable from current host run metadata');
        if (access.state !== 'ok') c.state = 'error';
        else if (running) c.notes.push('The helper ceiling is recorded by Clubhouse for this run. Helper start settings are ranked for the chosen CLI when it starts; provider enforcement is not independently verified.');
      }
      let helpers: Awaited<ReturnType<typeof listHelpersEverywhere>> | undefined;
      try { helpers = await listHelpersEverywhere(project.path, agentId, { includeDisposed: true, readOnly: true, receipts: helperReceipts }); }
      catch { /* telemetry-exempt: unavailable helper inventory stays separate from pending starts. */ }
      if (!authorized()) throw new Error('revoked');
      for (const { config } of helpers ?? []) connectionHelpers.add(config.id);
      const requests = readStartRequestsForDisplay(project.path, agentId, { receipts: orchestrationReceipts });
      const waiting = projectPendingHelperStarts(c, requests);
      result.helperPages = 1;
      result.helperPage = await readSelectedHelperPage(target, helpers, requests, { offset: query?.card === 'orchestrate' ? query.offset ?? 0 : 0, authorized, target: targetWitness, receipts: helperReceipts });
      if (!helpers || result.helperPage.state === 'unavailable') { c.state = 'error'; c.notes.push('The selected helper inventory is unavailable; live and disposed totals are unknown.'); return; }
      const live = helpers.filter((h) => !isDisposedAgent(h.config));
      const summary = helpersSummary(live.length, enabled ? limit : undefined, live.filter((h) => h.config.creation?.state === 'creating').length, waiting);
      row(c, 'Helpers', waiting === undefined ? `${live.length ? summary : 'No live helpers'} · pending starts unavailable` : summary);
      if (helpers.length > live.length) row(c, 'Disposed helpers', helpers.length - live.length);
      for (const entry of helpers) {
        const h = entry.config, structured = result.helperPage.rows.find((row) => row.key === createHash('sha256').update(JSON.stringify([entry.projectPath, h.id])).digest('hex'));
        const recordedState = structured?.status ?? (isDisposedAgent(h) ? 'disposed' : h.creation?.state === 'failed' ? 'failed' : h.creation?.state === 'creating' ? 'creating' : h.handoff ? 'handed-off' : 'State not checked in this helper page');
        const state = recordedState === 'disposed' ? 'Disposed' : recordedState === 'handed-off' ? 'Handed off' : recordedState === 'creating' ? 'Starting' : recordedState;
        const disposedAt = structured?.disposedAt ?? (isDisposedAgent(h) && Number.isFinite(Date.parse(h.disposedAt)) ? h.disposedAt : undefined);
        row(c, h.name, [state, h.branch, disposedAt, structured?.work.state === 'recorded' ? structured.work.text : structured?.work.state === 'unavailable' && structured.work.reason === 'read-failed' ? 'couldn’t check' : 'Work not checked (selected helper page)', structured?.projectName].filter(Boolean).join(' · '));
      }
      c.notes.push('Structured helper rows and bounded work continuation are shared separately; each selected page checks at most eight helpers.');
      if (agent.parentAgentId && !helpers.length && requests.state === 'ok' && !requests.value.length) c.state = 'not-applicable';
      if (!running && enabled) c.notes.push('The helper tools appear the next time this agent starts.');
    });
    await read('dispatcher', (c) => readDispatcherCard(c, target, readPolicy().fields.connectToDispatcher, { receipts: dispatcherReceipts, authorized, controller }));
    const argumentsQuery = query;
    await read('connections', async (c) => {
      const query = argumentsQuery?.card === 'connections' ? argumentsQuery : undefined;
      const groupsFor = (chosen: AgentConfigTarget) => {
        if (query?.source !== 'group-records') return undefined;
        const fields = projectConnectionEndpointFieldsForDisplay(chosen.agent.id, chosen.agent); if (fields.state !== 'ok') return undefined;
        const receipt = captureReadOnlyConfigTargetWitness(chosen); connectionReceipts.push(receipt);
        return readSavedGroupConnectionsForDisplay({ agentId: chosen.agent.id, projectId: chosen.project.id, projectPath: chosen.project.path, receipt, fields: fields.value },
          { authorized, receipts: connectionReceipts, projectOffset: query.projectOffset, offset: query.offset });
      };
      const canvasFor = (chosen: AgentConfigTarget) => {
        if (query?.source !== 'canvas-records' && query?.source !== 'zone-records') return undefined;
        const receipt = captureReadOnlyConfigTargetWitness(chosen); connectionReceipts.push(receipt);
        return readSavedCanvasConnectionsForDisplay({ agentId: chosen.agent.id, projectId: chosen.project.id, projectPath: chosen.project.path, receipt }, query.source === 'canvas-records' ? 'canvas' : 'zone',
          { authorized, receipts: connectionReceipts, projectOffset: query.projectOffset, offset: query.offset });
      };
      const toolsFor = (chosen: AgentConfigTarget) => {
        if (query?.source !== 'tool-records') return undefined;
        const receipt = captureReadOnlyConfigTargetWitness(chosen); connectionReceipts.push(receipt);
        return readSavedToolConnectionsForDisplay({ agentId: chosen.agent.id, projectId: chosen.project.id, projectPath: chosen.project.path, receipt },
          { authorized, receipts: connectionReceipts, projectOffset: query.projectOffset, offset: query.offset });
      };
      const registeredFor = (chosen: AgentConfigTarget): ReturnType<typeof readConfiguredRegisteredConnectionsForDisplay> | undefined => {
        if (query?.source !== 'helpers' && query?.source !== 'dispatcher-auto' && query?.source !== 'helper-parent') return undefined;
        const fields = projectConnectionEndpointFieldsForDisplay(chosen.agent.id, chosen.agent);
        if (fields.state !== 'ok' || (query.source === 'dispatcher-auto') !== dispatcher) return undefined;
        const receipt = captureReadOnlyConfigTargetWitness(chosen); connectionReceipts.push(receipt);
        if (query.source === 'helper-parent') return readHelperParentConnectionForDisplay({ agentId: chosen.agent.id, projectId: chosen.project.id, projectPath: chosen.project.path, receipt, fields: fields.value, parentAgentId: chosen.agent.parentAgentId, parentProjectPath: chosen.agent.parentProjectPath },
          { authorized, receipts: connectionReceipts, projectOffset: query.projectOffset, offset: query.offset });
        return readConfiguredRegisteredConnectionsForDisplay({ agentId: chosen.agent.id, projectId: chosen.project.id, projectPath: chosen.project.path, receipt, fields: fields.value },
          query.source === 'helpers' ? 'helper-children' : 'dispatcher-auto', { authorized, receipts: connectionReceipts, projectOffset: query.projectOffset, matchOffset: query.offset, readLoadedCache: readAgentConnectionCacheForDisplay });
      };
      if (!dispatcher) {
        const connect = readPolicy().fields.connectToDispatcher;
        const canonical = connect.state === 'ok' && connect.value ? await controller() : undefined;
        if (!authorized()) return;
        const automatic = configuredDispatcherDirections({ id: agentId, name: agent.name }, connect, canonical && { id: canonical.agent.id, name: canonical.agent.name });
        return readConnectionCard(c, agentId, { receipts: connectionReceipts, authorized, page: query, registered: registeredFor(target), tools: toolsFor(target), canvas: canvasFor(target), groups: groupsFor(target), name: agent.name, projectPath: project.path, connectToDispatcher: connect, automatic, automaticControllerProjectPath: canonical?.project.path, endpoint: !agent.parentAgentId ? { target: targetWitness, readCache: readAgentConnectionCacheForDisplay } : undefined, family: { parentId: agent.parentAgentId, helperIds: connectionHelpers } });
      }
      const canonical = await controller();
      if (!authorized()) return;
      if (!canonical) { c.state = 'error'; c.summary = 'Connection identity unavailable'; c.notes.push('The host Dispatcher’s canonical connection identity is unavailable. Connections cannot be verified until its host identity is available.'); return; }
      return readConnectionCard(c, canonical.agent.id, { receipts: connectionReceipts, authorized, page: query, registered: registeredFor(canonical), tools: toolsFor(canonical), canvas: canvasFor(canonical), groups: groupsFor(canonical), dispatcher: true, name: canonical.agent.name, projectPath: canonical.project.path });
    });
    await read('actions', (c) => readActionCard(c, agentId, project.id, dispatcher, { agentName: agent.name, projectName: project.displayName || project.name }));
    await read('skills-mcp', async (c) => {
      const evidence = settingsRead.managedEvidence;
      const status = evidence?.status.state === 'ok' ? evidence.status.value : undefined;
      if (agent.managed && !evidence) { c.state = 'error'; c.notes.push('The selected managed library evidence is unavailable.'); }
      else if (agent.managed && !status) c.notes.push('Recorded managed delivery status is unavailable. No installation or loading is inferred.');
      for (const id of agent.managed?.skills ?? []) {
        if (GRANT_GATED_SKILL_IDS.includes(id)) continue;
        row(c, 'Skill', `${evidence?.names.get(id) ?? 'Library name unavailable'} · ${running && status?.deliveredAt && !status.waiting && !status.deliveryFailed && status.deliveredSkillIds?.includes(id) ? 'Installation recorded by Clubhouse' : 'Configured in Clubhouse'}`);
      }
      for (const skill of status?.builtinSkills ?? []) row(c, 'Skill', `${skill.name} · ${running && skill.deliveredAt ? 'Installation recorded by Clubhouse' : 'Configured in Clubhouse'}`);
      if (running) {
        const connection = getAgentConnection(agentId);
        const current = getCurrentAgentConnection(agentId);
        row(c, 'Clubhouse MCP', current ? `Connected${current.toolCount == null ? '' : ` · ${current.toolCount} tools`} · ${new Date(current.connectedAt).toISOString()}` : connection ? 'An earlier handshake is retained; connection for this run is not confirmed' : 'No handshake reported for this run');
        for (const name of result.settings?.setup.mcps ?? settingsRead.managedEvidence?.setup.mcps ?? []) row(c, 'MCP configured', name);
        for (const problem of status?.mcpProblems ?? []) row(c, problem.server, `Missing environment variables: ${problem.missingEnv.join(', ')}`);
      } else c.notes.push('Last session evidence only. No live MCP connection is claimed while the agent is stopped.');
      c.notes.push('Configured names and revisions are recorded library metadata; revision payloads are not verified. Recorded installation does not confirm provider loading or use. Provider reports are shown separately.');
    });
    await read('session', async (c) => {
      c.title = running ? 'Session' : 'Last session';
      row(c, 'Status', lifecycle.status);
      row(c, 'Folder', cwd);
      row(c, 'Branch', agent.branch);
      if (!running) await readHistoricalSessionCard(c, agent, cwd);
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
    if (!providerRead.receipt.current() || settingsReceipts.some((receipt) => !receipt.current())) return { status: 409, body: { error: 'settings_evidence_changed' } };
    if (dispatcherReceipts.some((receipt) => !receipt.current())) return { status: 409, body: { error: 'dispatcher_evidence_changed' } };
    if (orchestrationReceipts.some((receipt) => !receipt.current())) return { status: 409, body: { error: 'orchestration_evidence_changed' } };
    if (running && !registration && runtime?.kind !== 'chat'
      || currentRegistration !== registration || currentRegistration?.nonce !== registeredNonce || currentRegistration?.runtime !== registeredRuntime
      || currentRegistration?.orchestrator !== registeredProvider || currentRegistration?.cwd !== registeredCwd
      || isAgentRunning(agentId) !== running
      || runtime?.kind === 'chat' && (getAgentRuntime(agentId) !== runtime || runtime.getSessionId?.() !== sessionId || (runtime.getNativeSessionId?.() ?? null) !== nativeSessionId || (runtime.getDisplayRunId?.() ?? null) !== displayRunId)) {
      return { status: 409, body: { error: 'agent_run_changed' } };
    }
    result.providerEvidenceState = runtime?.kind === 'chat' && runtime.getDetailsEvidence ? 'unavailable' : 'unsupported';
    if (running && runtime?.kind === 'chat') {
      const evidence = runtime.getDetailsEvidence?.();
      if (evidence && evidence.agentId === agentId && (evidence.providerId === result.providerId || result.providerId === 'unknown')
        && evidence.sessionId === sessionId && evidence.nativeSessionId === nativeSessionId) {
        result.providerId = evidence.providerId; result.providerLabel = providerLabel(evidence.providerId);
        result.providerEvidence = evidence; result.providerEvidenceState = 'current';
      }
    }
    // Enforce the envelope even when every section fits its individual row limit.
    if (query?.card === 'connections') selectedConnectionPageEnvelope(result);
    if (query?.card === 'orchestrate') {
      if (dispatcher || result.helperPages !== 1) return { status: 400, body: { error: 'unsupported_helper_page' } };
      if (!result.helperPage) return authorized() ? { status: 409, body: { error: 'helper_inventory_changed' } } : refused();
      byId.orchestrate.rows = []; byId.orchestrate.notes = []; byId.orchestrate.summary = 'Selected helper page';
      result.helperPageOnly = true; result.settings = null; delete result.providerEvidence; delete result.providerEvidenceState; delete result.outgoingWires;
      delete result.inventoryPage; delete result.inventoryPageOnly;
      delete result.inventoryPages; delete result.inventorySources;
      for (const c of cards) if (c.id !== 'orchestrate') { c.requested = false; c.omitted = 0; c.rows = []; c.notes = []; delete c.connectionPage; c.summary = 'Not included in this selected helper page'; }
    }
    while (Buffer.byteLength(JSON.stringify(result)) > REMOTE_DETAILS_MAX_BYTES) {
      const largest = cards.filter((c) => c.rows.length).sort((a, b) => JSON.stringify(b.rows).length - JSON.stringify(a.rows).length)[0];
      if (!largest) throw new Error('details_limit');
      largest.rows.pop(); largest.omitted++;
    }
    if (cards.length !== REMOTE_DETAILS_CARD_IDS.length) throw new Error('details_contract');
    if (!authorized()) return refused();
    if (connectionReceipts.some((receipt) => !receipt.current())) return authorized() ? { status: 409, body: { error: 'connection_evidence_changed' } } : refused();
    if (!authorized()) return refused();
    return { status: 200, body: result };
  } catch {
    // telemetry-exempt: no host errors or partial evidence after revocation leave this boundary.
    return authorized() ? { status: 500, body: { error: 'details_read_failed' } } : refused();
  }
}
