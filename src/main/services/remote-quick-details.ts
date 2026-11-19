/** Quick runs are retained launch identities, never synthetic durable configs. */
import { REMOTE_DETAILS_CARD_IDS, REMOTE_DETAILS_MAX_BYTES, type RemoteAgentDetails, type RemoteDetailsCard } from '../../shared/remote-agent-details';
import { accessFromLegacy, accessLabel } from '../../shared/agent-access';
import { getProvider } from '../orchestrators';
import { agentRegistry } from './agent-registry';
import { getAgentRuntime } from './agent-runtime';
import { isAgentRunning } from './agent-system';
import { agentDisplayState } from './agent-display-state';
import type { ReadOnlyQuickTarget } from './read-only-quick-target';
import { card, row, display, section } from './remote-details-presentation';
import { readActionCard, readCanvasCard, readConnectionCard } from './remote-details-cards';
import { getAgentConnection, getCurrentAgentConnection } from './clubhouse-mcp/bridge-server';
import { managedAgents } from './managed-agents';
import { quickRuntimeDisplay, quickRuntimeIsCurrent } from './quick-agent-events';

export async function readRemoteQuickDetails(target: ReadOnlyQuickTarget, authorized: () => boolean): Promise<{ status: number; body: unknown }> {
  const refused = () => ({ status: 403, body: { error: 'details_read_refused' } });
  if (!authorized()) return refused();
  try {
    const { run, project } = target, agentId = run.agentId, selected = run.display;
    const registration = agentRegistry.get(agentId);
    const nonce = registration?.nonce, registeredRuntime = registration?.runtime;
    const registeredProvider = registration?.orchestrator, registeredCwd = registration?.cwd;
    const rawRunning = isAgentRunning(agentId), bound = quickRuntimeIsCurrent(run, registration), observed = quickRuntimeDisplay(run);
    const runtime = bound ? getAgentRuntime(agentId) : undefined, running = rawRunning && bound;
    const sessionId = runtime?.kind === 'chat' ? runtime.getSessionId?.() ?? null : null;
    const nativeSessionId = runtime?.kind === 'chat' ? runtime.getNativeSessionId?.() ?? null : null;
    const state = agentDisplayState({ id: agentId }, running);
    const status = run.finishedAt && !running ? run.completion === 'failed' ? 'error' : 'sleeping' : rawRunning && !bound ? 'spawning' : state.status;
    // A requested default does not establish which provider actually started.
    const providerId = (bound ? registeredProvider : observed?.provider) || 'unknown';
    const providerName = (id: string) => getProvider(id)?.displayName ?? id;
    const cards = REMOTE_DETAILS_CARD_IDS.map((id) => card(id, ({ settings: 'Settings', dispatcher: 'Dispatcher', orchestrate: 'Orchestration', connections: 'Connections', actions: 'Actions', 'skills-mcp': 'Skills and MCP', session: running ? 'Session' : 'Last session', canvases: 'Canvases', changes: 'Changes' })[id]));
    const byId = Object.fromEntries(cards.map((c) => [c.id, c])) as Record<typeof REMOTE_DETAILS_CARD_IDS[number], RemoteDetailsCard>;
    byId.dispatcher.state = byId.orchestrate.state = 'not-applicable';
    const result: RemoteAgentDetails = { version: 1, readOnly: true, readAt: Date.now(), agentId, providerId, providerLabel: providerId === 'unknown' ? 'Not reported by host' : display(providerName(providerId)), running, status, spawnedAt: run.startedAt, sessionId, nativeSessionId, settings: null, cards };
    const checked = async <T>(work: Promise<T>) => { const value = await work; if (!authorized()) throw new Error('revoked'); return value; };
    const read = async (id: typeof REMOTE_DETAILS_CARD_IDS[number], fn: (c: RemoteDetailsCard) => Promise<void> | void) => {
      if (!authorized()) throw new Error('revoked');
      await section(byId[id], () => fn(byId[id]));
      byId[id].observedAt = Date.now();
      if (!authorized()) throw new Error('revoked');
    };
    await read('settings', async (c) => {
      c.summary = 'Quick run';
      if (running && registeredProvider) row(c, 'CLI', providerName(registeredProvider));
      else if (observed) row(c, 'Last CLI', providerName(observed.provider));
      if (!running || selected?.orchestrator !== registeredProvider) row(c, 'Requested CLI', selected ? selected.orchestrator ? providerName(selected.orchestrator) : 'Host default requested' : 'Launch selection was not retained by this host');
      const runtimeLabel = (kind: string) => kind === 'chat' ? 'Chat' : kind === 'headless' ? 'CLI (headless)' : 'CLI';
      row(c, !running && observed ? 'Last runtime' : 'Runs in', running && registration ? runtimeLabel(registeredRuntime!) : observed ? runtimeLabel(observed.runtime) : 'Current runtime not confirmed');
      row(c, 'Requested model', selected?.model && selected.model !== 'default' ? selected.model : selected ? 'Default model' : 'Launch selection was not retained by this host');
      row(c, 'Requested effort', selected?.effort);
      const actualAccess = running ? registration?.launchAccess : undefined;
      const permissionsUnsupported = running && !!registeredProvider && getProvider(registeredProvider)?.getCapabilities?.().permissions === false;
      const currentAccess = actualAccess ? actualAccess.access ?? accessFromLegacy(actualAccess.freeAgentMode, actualAccess.permissionMode) : null;
      const requestedAccess = selected?.access ?? (selected?.freeAgentMode !== undefined ? accessFromLegacy(selected.freeAgentMode, selected.permissionMode) : null);
      row(c, permissionsUnsupported || currentAccess ? 'Access' : 'Requested access', permissionsUnsupported ? 'Set by the CLI' : currentAccess ? accessLabel(currentAccess) : requestedAccess ? accessLabel(requestedAccess) : 'Not reported by host');
      row(c, 'Sandbox and approvals', [actualAccess?.approvalPolicy ?? selected?.approvalPolicy, actualAccess?.sandbox ?? selected?.sandbox].filter(Boolean).join(' · ') || 'Existing level defaults requested');
      c.notes.push('Launch choices do not confirm the provider’s model, effort or loaded setup. Current provider reports are shown separately. Quick runs have no saved next-wake settings.');
      if (rawRunning && !bound) c.notes.push('A runtime exists for this ID, but it is not confirmed as this quick launch. Only retained launch metadata is shown.');
      if (selected?.template) {
        const service = managedAgents();
        let name = 'Template no longer available';
        try { name = (await checked(service.getTemplate(selected.template.id))).name; }
        catch { if (!authorized()) throw new Error('revoked'); c.notes.push('The selected template is unavailable. Other launch fields are shown independently.'); }
        row(c, 'Template', name);
        if (selected.template.added.length || selected.template.removed.length) {
          const entries = await checked(service.liveEntries());
          const names = (ids: readonly string[]) => ids.map((id) => entries[id]?.name ?? 'No longer in the library').join(', ');
          row(c, 'Added for this run', names(selected.template.added));
          row(c, 'Left out for this run', names(selected.template.removed));
        }
        if (selected.template.omitted) { c.omitted += selected.template.omitted; c.notes.push('Further launch part choices were outside the retained display limit.'); }
      }
    });
    await read('connections', (c) => readConnectionCard(c, agentId));
    await read('actions', (c) => readActionCard(c, agentId, project.id, false, { agentName: run.name, projectName: project.displayName || project.name }));
    await read('canvases', (c) => readCanvasCard(c, agentId, project.id));
    await read('skills-mcp', (c) => {
      if (!running) { c.notes.push('This quick run has stopped. No live MCP connection is claimed.'); return; }
      const current = getCurrentAgentConnection(agentId), historical = getAgentConnection(agentId);
      row(c, 'Clubhouse MCP', current ? `Connected${current.toolCount == null ? '' : ` · ${current.toolCount} tools`}` : historical ? 'An earlier handshake is retained; connection for this run is not confirmed' : 'No handshake reported for this run');
      c.notes.push('Provider-reported skills and MCP servers are separate from a Clubhouse handshake. No durable managed setup is inferred for a quick run.');
    });
    await read('session', (c) => {
      row(c, 'Status', status);
      row(c, bound || observed?.cwd ? 'Folder' : 'Requested folder', (bound ? registeredCwd : observed?.cwd) || selected?.cwd || run.projectPath);
      row(c, 'Launch started', new Date(run.startedAt).toISOString());
      if (run.finishedAt && !running) {
        row(c, 'Ended', new Date(run.finishedAt).toISOString());
        row(c, 'Outcome', run.completion ?? 'Not reported');
        row(c, 'Run duration', `${Math.max(0, run.finishedAt - run.startedAt)} ms`);
      }
      row(c, 'CLI start', run.completion === 'failed' ? running ? 'Launch reported a failure; the created runtime is still present.' : 'Launch failed; no running runtime is confirmed.' : bound ? state.error : null);
      if (!sessionId) c.notes.push('No chat session identity is available for this quick run; no usage or earlier session is inferred.');
    });
    byId.changes.notes.push('Comparisons require a folder confirmed by this quick run’s created runtime. A requested folder alone is not read. Session and last-turn evidence also requires its current chat session identity.');
    if (!authorized()) return refused();
    const current = agentRegistry.get(agentId);
    if (current !== registration || current?.nonce !== nonce || current?.runtime !== registeredRuntime || current?.orchestrator !== registeredProvider || current?.cwd !== registeredCwd
      || isAgentRunning(agentId) !== rawRunning || quickRuntimeIsCurrent(run, current) !== bound || running && !registration && runtime?.kind !== 'chat'
      || runtime?.kind === 'chat' && (getAgentRuntime(agentId) !== runtime || runtime.getSessionId?.() !== sessionId || (runtime.getNativeSessionId?.() ?? null) !== nativeSessionId)
      || !target.current()) return { status: 409, body: { error: 'quick_run_changed' } };
    result.providerEvidenceState = runtime?.kind === 'chat' && runtime.getDetailsEvidence ? 'unavailable' : 'unsupported';
    if (running && bound && runtime?.kind === 'chat') {
      const evidence = runtime.getDetailsEvidence?.();
      if (evidence && evidence.agentId === agentId && evidence.providerId === providerId
        && evidence.sessionId === sessionId && evidence.nativeSessionId === nativeSessionId) { result.providerEvidence = evidence; result.providerEvidenceState = 'current'; }
    }
    for (const c of cards) {
      c.notes = c.notes.map((note) => display(note));
      if (c.notes.length > 20) c.notes = [...c.notes.slice(0, 19), `${c.notes.length - 19} more notices omitted by the host’s display limit.`];
    }
    while (Buffer.byteLength(JSON.stringify(result)) > REMOTE_DETAILS_MAX_BYTES) {
      const largest = cards.filter((c) => c.rows.length).sort((a, b) => JSON.stringify(b.rows).length - JSON.stringify(a.rows).length)[0];
      if (!largest) throw new Error('details_limit'); largest.rows.pop(); largest.omitted++;
    }
    return { status: 200, body: result };
  } catch { /* telemetry-exempt: no raw host error or partial data after revocation. */ return authorized() ? { status: 500, body: { error: 'quick_details_unreadable' } } : refused(); }
}
