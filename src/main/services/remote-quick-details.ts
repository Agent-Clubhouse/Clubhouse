import { isRemoteDetailsQuery, type RemoteDetailsQuery } from '../../shared/remote-details-query';
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
import type { DisplayReceipt } from './display-settings';

export async function readRemoteQuickDetails(target: ReadOnlyQuickTarget, authorized: () => boolean, query?: RemoteDetailsQuery): Promise<{ status: number; body: unknown }> {
  const refused = () => ({ status: 403, body: { error: 'details_read_refused' } });
  if (!authorized()) return refused();
  if (query !== undefined && !isRemoteDetailsQuery(query)) return { status: 400, body: { error: 'invalid_details_query' } };
  if (query && !['outgoing', 'incoming', 'directions', 'sources'].includes(query.source)) return { status: 404, body: { error: 'quick_source_not_applicable' } };
  query = query && { ...query };
  try {
    const { run, project } = target, agentId = run.agentId, selected = run.display;
    const setupReceipts: DisplayReceipt[] = [];
    const connectionReceipts: DisplayReceipt[] = [];
    const registration = agentRegistry.get(agentId);
    const nonce = registration?.nonce, registeredRuntime = registration?.runtime;
    const registeredProvider = registration?.orchestrator, registeredCwd = registration?.cwd;
    const rawRunning = isAgentRunning(agentId), bound = quickRuntimeIsCurrent(run, registration), observed = quickRuntimeDisplay(run);
    const runtime = bound ? getAgentRuntime(agentId) : undefined, running = rawRunning && bound;
    const sessionId = runtime?.kind === 'chat' ? runtime.getSessionId?.() ?? null : null;
    const nativeSessionId = runtime?.kind === 'chat' ? runtime.getNativeSessionId?.() ?? null : null;
    const displayRunId = runtime?.kind === 'chat' ? runtime.getDisplayRunId?.() ?? null : null;
    const state = agentDisplayState({ id: agentId }, running);
    const status = run.finishedAt && !running ? run.completion === 'failed' ? 'error' : 'sleeping' : rawRunning && !bound ? 'spawning' : state.status;
    // A requested default does not establish which provider actually started.
    const providerId = (bound ? registeredProvider : observed?.provider) || 'unknown';
    const providerName = (id: string) => getProvider(id)?.displayName ?? id;
    const cards = REMOTE_DETAILS_CARD_IDS.map((id) => card(id, ({ settings: 'Settings', dispatcher: 'Dispatcher', orchestrate: 'Orchestration', connections: 'Connections', actions: 'Actions', 'skills-mcp': 'Skills and MCP', session: running ? 'Session' : 'Last session', canvases: 'Canvases', changes: 'Changes' })[id]));
    const byId = Object.fromEntries(cards.map((c) => [c.id, c])) as Record<typeof REMOTE_DETAILS_CARD_IDS[number], RemoteDetailsCard>;
    byId.dispatcher.state = byId.orchestrate.state = 'not-applicable';
    const result: RemoteAgentDetails = { version: 1, connectionPages: 1, connectionPageSources: running && bound ? ['outgoing', 'incoming', 'directions', 'sources'] : [], readOnly: true, readAt: Date.now(), agentId, providerId, providerLabel: providerId === 'unknown' ? 'Not reported by host' : display(providerName(providerId)), running, status, spawnedAt: run.startedAt, sessionId, nativeSessionId, settings: null, cards };
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
        let name = 'Template metadata unavailable';
        try {
          const template = await checked(service.getTemplateForDisplay(selected.template.id, { receipts: setupReceipts }));
          name = template.name;
          c.notes.push(`Template name: ${template.source === 'builtin' ? 'built-in metadata' : 'host primary metadata'} observed ${new Date(template.observedAt).toISOString()}.`);
          if (template.truncated) c.notes.push('Template display metadata was truncated by the host.');
        }
        catch { if (!authorized()) throw new Error('revoked'); c.state = 'error'; c.notes.push('The selected template is unavailable. Other launch fields are shown independently.'); }
        row(c, 'Template', name);
        if (selected.template.added.length || selected.template.removed.length) {
          const names = new Map<string, string>();
          try {
            const ids = [...new Set([...selected.template.added, ...selected.template.removed])];
            if (ids.length > 100 || ids.some((id) => typeof id !== 'string' || !id || id.length > 2048)) throw new Error('part_limit');
            const library = await checked(service.openSetupMetadataForDisplay());
            // Retain the private receipt before further awaits, including a
            // failed part lookup. No revision payload or global entry list.
            setupReceipts.push(library.receipt);
            for (const id of ids) {
              const part = await checked(library.head(id));
              names.set(id, part ? display(part.name, 240) : 'No longer in the library');
            }
            c.notes.push('Part names are selected committed library metadata. Revision payload integrity and provider loading are not verified.');
          } catch { if (!authorized()) throw new Error('revoked'); c.state = 'error'; names.clear(); c.notes.push('The selected launch-part names are unavailable. No empty library or loaded setup is inferred.'); }
          const labels = (ids: readonly string[]) => ids.map((id) => names.get(id) ?? 'Unavailable from library metadata').join(', ');
          row(c, 'Added for this run', labels(selected.template.added));
          row(c, 'Left out for this run', labels(selected.template.removed));
        }
        if (selected.template.omitted) { c.omitted += selected.template.omitted; c.notes.push('Further launch part choices were outside the retained display limit.'); }
      }
    });
    await read('connections', (c) => {
      if (!running || !bound) { c.state = 'error'; c.summary = 'Connection run association unavailable'; c.notes.push('The host cannot associate current connection records with this stopped or unconfirmed quick run.'); return; }
      return readConnectionCard(c, agentId, { receipts: connectionReceipts, authorized, page: query, name: run.name });
    });
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
    if (setupReceipts.some((receipt) => !receipt.current())) return { status: 409, body: { error: 'quick_setup_evidence_changed' } };
    const current = agentRegistry.get(agentId);
    if (current !== registration || current?.nonce !== nonce || current?.runtime !== registeredRuntime || current?.orchestrator !== registeredProvider || current?.cwd !== registeredCwd
      || isAgentRunning(agentId) !== rawRunning || quickRuntimeIsCurrent(run, current) !== bound || running && !registration && runtime?.kind !== 'chat'
      || runtime?.kind === 'chat' && (getAgentRuntime(agentId) !== runtime || runtime.getSessionId?.() !== sessionId || (runtime.getNativeSessionId?.() ?? null) !== nativeSessionId || (runtime.getDisplayRunId?.() ?? null) !== displayRunId)
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
    if (!authorized()) return refused();
    if (connectionReceipts.some((receipt) => !receipt.current())) return authorized() ? { status: 409, body: { error: 'connection_evidence_changed' } } : refused();
    if (!authorized()) return refused();
    return { status: 200, body: result };
  } catch { /* telemetry-exempt: no raw host error or partial data after revocation. */ return authorized() ? { status: 500, body: { error: 'quick_details_unreadable' } } : refused(); }
}
