/** Saved helper/Dispatcher directions from a bounded registered relationship page.
 * No binding-source collect/inspect, ordinary loader, initialization or lifecycle call.
 */
import { AUTOMATIC_CONNECTION_SWITCHES } from '../../shared/connection-grants';
import type { AgentConnectionCacheDisplay } from './agent-config';
import type { ConnectionEndpointFields } from './connection-endpoint-fields-display';
import type { DisplayReceipt, DisplayValue } from './display-settings';
import { readRegisteredAgentDisplayPage, type RegisteredDisplayAgent, type RegisteredDisplayRoot, type RegisteredDisplaySelection, type RegisteredAgentDisplayPage } from './registered-agent-display-page';

export const CONFIGURED_REGISTERED_PAGE_SIZE = 8;
export interface ConfiguredRegisteredConnection {
  endpoint: RegisteredDisplayAgent;
  source: 'helper' | 'dispatcher-auto';
  /** Saved applicability, never a live binding, MCP handshake or effective grant. */
  applicability: 'configured' | 'disposed' | 'unknown';
  directions: Array<{ from: 'selected' | 'endpoint'; disabledTools: string[]; enabledTools: string[] }>;
  hostCache?: DisplayValue<AgentConnectionCacheDisplay>;
}
export interface ConfiguredRegisteredConnectionPage extends Omit<RegisteredAgentDisplayPage, 'entries'> {
  entries: ConfiguredRegisteredConnection[];
}
const current = (r: DisplayReceipt) => { try { return r.current(); } catch { return false; } };
/** Detached receipt list only; no primary, path map or returned field object retained. */
function combine(rs: readonly DisplayReceipt[]): DisplayReceipt {
  const captured = [...new Set(rs)]; return { current: () => captured.every(current) };
}

/** Internal caller supplies already admitted selected fields and exact target/role receipt.
 * Default8/max8 related endpoints per request,16 registered roots,4096 registry visits +4096 agent-row visits,
 * <=4MiB registry +8MiB initial root primary budget and64 directory alias probes. With cache enabled,
 * each of at most8 callbacks is preceded by the relevant root receipt; initial
 * and final aggregate receipts remain separate. Currentness rereads are not part
 * of the initial byte budget and have no hard I/O deadline. Pages are independent.
 * Only a trusted synchronous passive cache getter may be supplied. No callback
 * is a registration, runtime, permission or transport authorization substitute.
 */
export function readConfiguredRegisteredConnectionsForDisplay(selected: RegisteredDisplaySelection & { fields: ConnectionEndpointFields }, purpose: 'helper-children' | 'dispatcher-auto', options: {
  authorized(): boolean;
  receipts: DisplayReceipt[];
  projectOffset?: number;
  matchOffset?: number;
  limit?: number;
  readLoadedCache?: (projectPath: string, agentId: string, options: { receipts: DisplayReceipt[]; expectedProjectNamespace?: string }) => AgentConnectionCacheDisplay;
}): DisplayValue<ConfiguredRegisteredConnectionPage> {
  const inputs = [{ field: 'Selected configured registered relationships', source: 'primary' as const, observedAt: Date.now() }];
  const unavailable = (reason: 'invalid' | 'changed'): DisplayValue<ConfiguredRegisteredConnectionPage> => ({ state: 'unavailable', reason, inputs });
  const limit = options.limit ?? CONFIGURED_REGISTERED_PAGE_SIZE;
  if (!selected || selected.fields?.id !== selected.agentId || !Number.isInteger(limit) || limit < 1 || limit > CONFIGURED_REGISTERED_PAGE_SIZE
    || !Array.isArray(options.receipts) || options.readLoadedCache !== undefined && typeof options.readLoadedCache !== 'function') return unavailable('invalid');
  // Capture primitives before the first authority callback. Returned settings
  // cannot later retarget this observation or alter its applicability.
  const selectedDisposed = selected.fields.disposed.state === 'ok' ? selected.fields.disposed.value : undefined;
  const selectedId = selected.agentId, selectedProject = selected.projectId, selectedPath = selected.projectPath, target = selected.receipt;
  const authorized = options.authorized, receipts = options.receipts, readCache = options.readLoadedCache;
  const admitted = () => { try { return authorized() && current(target); } catch { return false; } };
  if (!admitted()) return unavailable('changed');
  const evidenceStart = receipts.length, roots = new Map<string, RegisteredDisplayRoot>();
  const page = readRegisteredAgentDisplayPage({ agentId: selectedId, projectId: selectedProject, projectPath: selectedPath, receipt: target }, purpose,
    { authorized, receipts, projectOffset: options.projectOffset, matchOffset: options.matchOffset, limit, rootEvidence: roots });
  if (page.state !== 'ok') return page;
  const result: ConfiguredRegisteredConnectionPage = { ...page.value, entries: page.value.entries.map((endpoint) => {
    const disposed = endpoint.fields.disposed.state === 'ok' ? endpoint.fields.disposed.value : undefined;
    const applicability = endpoint.identityAmbiguous ? 'unknown' : disposed || selectedDisposed ? 'disposed' : disposed === false && selectedDisposed === false ? 'configured' : 'unknown';
    const first = purpose === 'helper-children' ? AUTOMATIC_CONNECTION_SWITCHES.parentToHelper : AUTOMATIC_CONNECTION_SWITCHES.dispatcherToAgent;
    const second = purpose === 'helper-children' ? AUTOMATIC_CONNECTION_SWITCHES.helperToParent : AUTOMATIC_CONNECTION_SWITCHES.agentToDispatcher;
    return { endpoint, source: purpose === 'helper-children' ? 'helper' : 'dispatcher-auto', applicability,
      directions: applicability === 'configured' ? [{ from: 'selected', disabledTools: [...first.disabledTools], enabledTools: [...first.enabledTools] },
        { from: 'endpoint', disabledTools: [...second.disabledTools], enabledTools: [...second.enabledTools] }] : [] };
  }) };
  if (readCache) for (const entry of result.entries) {
    // A prior callback may change another primary in this same or a later
    // project. Check THIS exact admitted root immediately before EACH getter.
    const root = roots.get(entry.endpoint.projectId);
    if (!admitted() || !root || !current(root.receipt)) return unavailable('changed');
    const cacheInputs = [{ field: 'Related agent host-session fields', source: 'host-cache' as const, observedAt: Date.now() }];
    if (!root.namespace) { entry.hostCache = { state: 'unavailable', reason: 'unreadable', inputs: cacheInputs }; continue; }
    try { entry.hostCache = { state: 'ok', value: readCache(root.projectPath, entry.endpoint.agentId, { receipts, expectedProjectNamespace: root.namespace }), inputs: cacheInputs }; }
    catch { entry.hostCache = { state: 'unavailable', reason: 'unreadable', inputs: cacheInputs }; }
  }
  // Retain ALL page/cache evidence for the endpoint's final serialization fence.
  const final = combine([target, ...receipts.slice(evidenceStart)]); receipts.push(final);
  if (!admitted() || !final.current()) return unavailable('changed');
  return { state: 'ok', value: result, inputs: page.inputs };
}
