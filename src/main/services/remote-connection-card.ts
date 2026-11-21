import type { SavedGroupConnectionPage } from './saved-group-connections-display';
import type { SavedCanvasConnectionPage } from './saved-canvas-connections-display';
import type { SavedToolConnectionPage } from './saved-tool-connections-display';
import type { RemoteConnectionDetailsQuery as RemoteDetailsQuery } from '../../shared/remote-details-query';
import type { ConfiguredRegisteredConnectionPage } from './configured-registered-connections-display';
/** Selected Connections evidence only. No generic source/federation/credential readers. */
import { createHash } from 'crypto';
import { parseAgentAddress, formatAgentAddress } from '../../shared/agent-address';
import { mergeConnectionDirection } from '../../shared/remote-connections';
import { CONNECTION_SOURCE_LABELS, connectionSourceKind } from '../../shared/connection-sources';
import { CONNECTION_SWITCHES, localDirectionTools, networkDirectionTools } from '../../shared/connection-grants';
import type { RemoteDetailsCard } from '../../shared/remote-agent-details';
import { REMOTE_DETAILS_MAX_ROWS } from '../../shared/remote-agent-details';
import { bindingManager, type BindingDisplayRow } from './clubhouse-mcp/binding-manager';
import { readConnectionDirectionsForDisplay, type ConnectionDirectionDisplay } from './connection-directions-display';
import { readCachedConnectionSourcesForDisplay, type CachedSourceDisplay } from './persisted-bindings';
import { readPeerMetadataForDisplay, capturePeerPairingForDisplay } from './annex-peers';
import { captureOwnPairingForDisplay } from './annex-network-membership';
import { readFederationControllerForDisplay } from './dispatcher-federation';
import { readRegisteredFederationPauseForDisplay } from './dispatcher-federation-policy';
import { actionDetailsNames } from './actions/details-names';
import { getSatellite } from './annex-client';
import { readSavedDispatcherLinksForDisplay, type SavedDispatcherLinkDisplay } from './dispatcher-saved-links-display';
import { readDispatcherLinkMemoryForDisplay, type DispatcherLinkMemoryDisplay } from './dispatcher-connections';
import { readDispatcherEnablementForDisplay } from './dispatcher/dispatcher-settings';
import { isDispatcherIdentityAgentId } from './dispatcher/dispatcher-service';
import type { DisplayReceipt, DisplayValue } from './display-settings';
import { readSavedDispatcherEndpointMetadataForDisplay } from './dispatcher-endpoint-associations-display';
import { endpointCardFields, type EndpointCardFields } from './connection-endpoint-card-fields';
import type { ConfiguredDispatcherDirection } from './configured-dispatcher-directions';
import { row, display } from './remote-details-presentation';

export interface ConnectionCardReadOptions {
  receipts: DisplayReceipt[];
  page?: RemoteDetailsQuery;
  registered?: DisplayValue<ConfiguredRegisteredConnectionPage>;
  tools?: DisplayValue<SavedToolConnectionPage>;
  canvas?: DisplayValue<SavedCanvasConnectionPage>;
  groups?: DisplayValue<SavedGroupConnectionPage>;
  authorized(): boolean;
  dispatcher?: boolean;
  /** Strictly admitted durable project only; Quick runs do not use saved durable links. */
  projectPath?: string;
  connectToDispatcher?: DisplayValue<boolean>;
  /** Strict selected normal-durable target; no route-supplied paths/getters. */
  endpoint?: { target: DisplayReceipt; readCache?: NonNullable<Parameters<typeof readSavedDispatcherEndpointMetadataForDisplay>[2]['readLoadedCache']> };
  /** Selected normal-agent saved automatic source; caller retains selected/controller admission receipts. */
  automatic?: DisplayValue<ConfiguredDispatcherDirection[]>;
  /** Existing strict canonical controller's exact primary folder; private, never a route parameter or DTO. */
  automaticControllerProjectPath?: string;
  name?: string;
  family?: { parentId?: string; helperIds: ReadonlySet<string> };
}
type Pair = { from: string; to: string; kind: BindingDisplayRow['targetKind'] | 'unknown'; binding?: BindingDisplayRow; saved?: ConnectionDirectionDisplay; sources: CachedSourceDisplay[]; machine?: string; remoteAgent?: string; manual?: SavedDispatcherLinkDisplay; manualMemory?: DispatcherLinkMemoryDisplay['rows'][number]; manualFields?: EndpointCardFields; automatic?: ConfiguredDispatcherDirection; identityGroup?: string; labelScope?: 'manual' | 'automatic' | 'native'; switchAssociationUnknown?: boolean };
const value = <T>(v: DisplayValue<T> | undefined): T | undefined => v?.state === 'ok' ? v.value : undefined;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const boundedName = (v: unknown): string | undefined => typeof v === 'string' && !!v && v.length <= 1024 ? v : undefined;
const labels = (tools: readonly string[]) => { const known = CONNECTION_SWITCHES.filter((entry) => tools.includes(entry.tool)).map((entry) => entry.label).join(', ') || 'none'; const other = tools.filter((tool) => !CONNECTION_SWITCHES.some((entry) => entry.tool === tool)).length; return `${known}${other ? `; ${other} unrecognized tool names` : ''}`; };
function retainedMachine(machine: string) {
  const s = getSatellite(machine);
  const state = s && ['disconnected', 'discovering', 'connecting', 'connected'].includes(s.state) ? s.state : 'not retained';
  return { state, alias: boundedName(s?.alias) ?? null, pairingRequired: s?.needsPairing === true, snapshotMissing: !s?.snapshot, incomplete: !!s?.snapshotUnavailable || !!s?.snapshot?.snapshotTruncated?.omitted?.length };
}
function machineReceipt(machine: string, key: string): DisplayReceipt { return { current: () => { try { return hash(retainedMachine(machine)) === key; } catch { return false; } } }; }
function nameReceipt(keys: string[], selected: string, name: string | undefined, key: string): DisplayReceipt {
  return { current: () => { try { const resolver = actionDetailsNames(() => undefined, { agentId: selected, projectId: '', agentName: name }); return hash(keys.map((id) => [id, boundedName(resolver.names.agent(id)) ?? null])) === key; } catch { return false; } } };
}
function endpointTargetReceipt(authorized: () => boolean, target: DisplayReceipt): DisplayReceipt {
  return { current: () => authorized() && target.current() };
}
function referenceNames(selected: string, selectedName: string | undefined) {
  const name = boundedName(selectedName), resolver = actionDetailsNames(() => undefined, { agentId: selected, projectId: '', agentName: name });
  const admitted = new Map<string, string | undefined>(); let limited = false;
  return {
    get(id: string) {
      if (admitted.has(id)) return admitted.get(id);
      if (admitted.size >= 256 || !id || id.length > 512) { limited = true; return undefined; }
      admitted.set(id, undefined); const result = boundedName(resolver.names.agent(id)); admitted.set(id, result); return result;
    },
    finish(receipts: DisplayReceipt[]) {
      const keys = [...admitted.keys()]; receipts.push(nameReceipt(keys, selected, name, hash(keys.map((id) => [id, admitted.get(id) ?? null]))));
      return [...resolver.notices(), ...(limited ? ['Further reference names exceeded this read’s limit and remain unavailable.'] : [])];
    },
  };
}
function toolsFor(pair: Pair, savedComplete: boolean): string {
  if (pair.switchAssociationUnknown) return 'Saved or bound switch association is unconfirmed for this configured endpoint; source defaults are listed separately';
  if (pair.automatic && savedComplete && !pair.binding && !pair.saved && !pair.sources.length) {
    if (pair.manual) return 'Multiple configured sources; starting defaults are shown separately, without a bound or saved switch record';
    const defaults = localDirectionTools({ disabledTools: pair.automatic.disabledTools, enabledTools: pair.automatic.enabledTools });
    return `Configured automatic link defaults · On: ${labels(defaults.allowed)}; Off: ${labels(defaults.disabled)}`;
  }
  const fixed = pair.sources.find((source) => connectionSourceKind(source.sourceId) === 'dispatcher_federation');
  if (fixed) {
    const record = pair.binding ?? value(fixed.binding), off = value(record?.disabledTools);
    if (off === undefined) return 'Fixed network namespace record: switches unavailable';
    const tools = networkDirectionTools(off); return `Fixed network namespace (retained) · Allowed: ${labels(tools.allowed)}; Off: ${labels(tools.disabled)}`;
  }
  const disabled = value(pair.saved?.disabledTools), enabled = value(pair.saved?.enabledTools);
  if (pair.saved && disabled !== undefined && (pair.machine || enabled !== undefined)) {
    const tools = pair.machine ? networkDirectionTools(disabled) : localDirectionTools({ disabledTools: disabled, enabledTools: enabled }); return `Saved · Allowed: ${labels(tools.allowed)}; Off: ${labels(tools.disabled)}`;
  }
  if (pair.saved) return `Saved disabled: ${disabled === undefined ? 'unavailable' : labels(disabled)}; starting on: ${enabled === undefined ? 'unavailable' : labels(enabled)}`;
  if (pair.manual && savedComplete && !pair.binding && !pair.sources.length) {
    const defaults = localDirectionTools(undefined);
    return `Configured manual link defaults · On: ${labels(defaults.allowed)}; Off: ${labels(defaults.disabled)}`;
  }
  if (!pair.binding && pair.sources.length) return `Retained starting lists: ${pair.sources.map((source) => { const b = value(source.binding); const off = value(b?.disabledTools), on = value(b?.enabledTools); return `${CONNECTION_SOURCE_LABELS[connectionSourceKind(source.sourceId)]}: disabled ${off === undefined ? 'unavailable' : labels(off)}, starting on ${on === undefined ? 'unavailable' : labels(on)}`; }).join(' · ')}`;
  const off = value(pair.binding?.disabledTools), on = value(pair.binding?.enabledTools);
  if (savedComplete && off !== undefined && (pair.machine || on !== undefined)) {
    const tools = pair.machine ? networkDirectionTools(off) : localDirectionTools(undefined, off, on); return `Binding record · Allowed: ${labels(tools.allowed)}; Off: ${labels(tools.disabled)}`;
  }
  return `Saved override unavailable; binding disabled: ${off === undefined ? 'unavailable' : labels(off)}; starting on: ${on === undefined ? 'unavailable' : labels(on)}`;
}
const kindWords = (kind: Pair['kind']) => kind === 'group-project' ? 'group project' : kind === 'unknown' ? 'target kind unavailable' : kind;

export async function readPassiveConnectionCard(c: RemoteDetailsCard, selected: string, options: ConnectionCardReadOptions): Promise<void> {
  if (!options.authorized()) throw new Error('revoked');
  if (!selected || selected.length > 200) { c.state = 'error'; c.summary = 'Connection identity unavailable'; c.notes.push('The selected connection identity exceeds the host display limit.'); return; }
  if (options.page?.source === 'tool-records') { renderSavedToolConnections(c, options.tools, options.page); return; }
  if (options.page?.source === 'group-records') { renderSavedGroupConnections(c, options.groups); return; }
  if (options.page?.source === 'canvas-records' || options.page?.source === 'zone-records') { renderSavedCanvasConnections(c, options.canvas, options.page); return; }
  if (options.page?.source === 'helpers' || options.page?.source === 'dispatcher-auto' || options.page?.source === 'helper-parent') {
    renderRegisteredConnections(c, options.registered, options.page); return;
  }
  const pageSource = options.page?.source, pageOffset = options.page?.offset ?? 0;
  const includes = (source: string) => !pageSource || pageSource === source;
  const refs = referenceNames(selected, options.name);
  const endpointTarget = options.endpoint?.target, endpointCache = options.endpoint?.readCache, projectPath = options.projectPath;
  const automatic = !pageSource && options.automatic?.state === 'ok' ? options.automatic.value : [], controllerProject = options.automaticControllerProjectPath;
  const hasAutomaticPair = (from: string, to: string) => automatic.some((pair) => pair.agentId === from && pair.targetId === to);
  const nativeKey = (from: string, to: string) => `${from}\0${to}`;
  let endpointProjects: Map<string, string> | undefined;
  try {
    const outgoing = bindingManager.readBindingsForDisplay(selected, { direction: 'outgoing', offset: pageSource === 'outgoing' ? pageOffset : 0, receipts: options.receipts });
    const incoming = bindingManager.readBindingsForDisplay(selected, { direction: 'incoming', offset: pageSource === 'incoming' ? pageOffset : 0, receipts: options.receipts });
    const directions = readConnectionDirectionsForDisplay(selected, { offset: pageSource === 'directions' ? pageOffset : 0, receipts: options.receipts });
    const sources = readCachedConnectionSourcesForDisplay(selected, { offset: pageSource === 'sources' ? pageOffset : 0, receipts: options.receipts });
    let manual: ReturnType<typeof readSavedDispatcherLinksForDisplay> | undefined;
    let manualMemory: ReturnType<typeof readDispatcherLinkMemoryForDisplay> | undefined;
    let endpointMetadata: ReturnType<typeof readSavedDispatcherEndpointMetadataForDisplay> | undefined;
    if (includes('manual-dispatcher') && projectPath && !options.dispatcher && !options.family?.parentId) {
      // Saved metadata and process-known state have different provenance. A
      // failed source field cannot erase independently readable bindings.
      try {
        manual = readSavedDispatcherLinksForDisplay(selected, projectPath, { offset: pageOffset, receipts: options.receipts });
      } catch { manual = { state: 'unavailable', reason: 'unreadable', inputs: [] }; }
      if (manual.state === 'ok') {
        try { manualMemory = readDispatcherLinkMemoryForDisplay(selected, projectPath, manual.value.rows, { receipts: options.receipts }); }
        catch { manualMemory = { state: 'unavailable', reason: 'unreadable', inputs: [] }; }
        if (endpointTarget && manual.value.rows.length) {
          if (manual.value.rows.some((link) => hasAutomaticPair(link.agentId, link.targetId))) endpointProjects = new Map();
          endpointMetadata = readSavedDispatcherEndpointMetadataForDisplay({ agentId: selected, projectPath, target: endpointTargetReceipt(options.authorized, endpointTarget) }, pageSource ? manual.value.rows.slice(0, 2) : manual.value.rows,
            { receipts: options.receipts, readLoadedCache: endpointCache, endpointProjects });
        }
      }
    }

    if (pageSource) {
      const source = pageSource === 'outgoing' ? outgoing : pageSource === 'incoming' ? incoming : pageSource === 'directions' ? directions : pageSource === 'sources' ? sources : manual;
      if (source?.state === 'ok') {
        const total = source.value.total;
        c.connectionPage = { source: pageSource, offset: pageOffset, projectOffset: 0, known: total, complete: !('complete' in source.value) || source.value.complete === true,
          next: pageOffset + 2 < total ? { offset: pageOffset + 2, projectOffset: 0 } : null };
      } else { c.state = 'error'; c.notes.push('The selected source page is unavailable; no empty page is inferred.'); }
    }
    const outComplete = outgoing.state === 'ok' && outgoing.value.nextOffset === null;
    const inComplete = incoming.state === 'ok' && incoming.value.nextOffset === null;
    const savedComplete = directions.state === 'ok' && directions.value.nextOffset === null;
    const pairs = new Map<string, Pair>();
    const key = (from: string, to: string, kind: Pair['kind'], partition = '') => `${from}\0${to}\0${kind}\0${partition}`;
    const ensure = (from: string, to: string, kind: Pair['kind'], partition = ''): Pair => { if (typeof from !== 'string' || !from || from.length > 512 || typeof to !== 'string' || !to || to.length > 512 || from !== selected && (to !== selected || kind !== 'agent')) throw new Error('connection_scope'); const id = key(from, to, kind, partition); let p = pairs.get(id); if (!p) { p = { from, to, kind, sources: [] }; pairs.set(id, p); } return p; };
    for (const [origin, page] of [['outgoing', outgoing], ['incoming', incoming]] as const) if ((includes(origin) || pageSource === 'sources') && page.state === 'ok') for (const b of pageSource && pageSource !== 'sources' ? page.value.rows.slice(0, 2) : page.value.rows) ensure(b.agentId, b.targetId, b.targetKind).binding = b;
    let limitedSourceDetails = 0, untypedIncomingSources = 0;
    if (includes('sources') && sources.state === 'ok') for (const p of pageSource ? sources.value.pairs.slice(0, 2) : sources.value.pairs) for (const source of p.sources) {
      const b = value(source.binding);
      if (b && (b.agentId !== p.agentId || b.targetId !== p.targetId)) throw new Error('connection_source_scope');
      let pair: Pair;
      if (b) pair = ensure(p.agentId, p.targetId, b.targetKind);
      else {
        limitedSourceDetails++;
        // A source's identity check and its field projection have independent
        // budgets. Keep an already admitted typed pair when fields hit a limit;
        // an untyped cache key cannot invent an incoming agent/widget identity.
        const admitted = [...pairs.values()].filter((candidate) => candidate.from === p.agentId && candidate.to === p.targetId && candidate.kind !== 'unknown');
        if (admitted.length === 1) pair = admitted[0];
        else if (p.agentId === selected) pair = ensure(p.agentId, p.targetId, 'unknown');
        else if (p.targetId === selected) { untypedIncomingSources++; continue; }
        else throw new Error('connection_source_scope');
      }
      pair.sources.push(source);
    }
    if (pageSource === 'sources') for (const [key, pair] of pairs) if (!pair.sources.length) pairs.delete(key);
    if (limitedSourceDetails) c.notes.push(`Details unavailable for ${limitedSourceDetails} retained source record${limitedSourceDetails === 1 ? '' : 's'}; independently known connection fields are preserved.`);
    if (untypedIncomingSources) c.notes.push(`${untypedIncomingSources} incoming source record${untypedIncomingSources === 1 ? ' lacks' : 's lack'} an independently admitted target kind; its connection details are unavailable.`);
    if (manual?.state === 'ok') for (const link of pageSource ? manual.value.rows.slice(0, 2) : manual.value.rows) {
      const collision = hasAutomaticPair(link.agentId, link.targetId);
      const pair = ensure(link.agentId, link.targetId, 'agent', collision ? 'manual' : ''); pair.manual = link;
      if (collision) {
        const folder = endpointProjects?.get(nativeKey(link.agentId, link.targetId));
        pair.identityGroup = folder && controllerProject && folder === controllerProject ? 'controller' : folder ? `manual:${folder}` : `manual-unconfirmed:${nativeKey(link.agentId, link.targetId)}`;
      }
      if (endpointTarget) {
        const metadata = endpointMetadata?.state === 'ok' ? endpointMetadata.value.rows.find((row) => row.agentId === link.agentId && row.targetId === link.targetId) : undefined;
        pair.manualFields = metadata ? endpointCardFields(metadata) : { saved: endpointMetadata?.state === 'unavailable' && endpointMetadata.reason === 'limit' ? 'Saved target details exceed this read’s limit' : 'Saved target details unavailable' };
      }
      if (manualMemory?.state === 'ok') pair.manualMemory = manualMemory.value.rows.find((state) => state.agentId === link.agentId && state.targetId === link.targetId);
    }
    if (includes('directions') && directions.state === 'ok') for (const d of pageSource ? directions.value.rows.slice(0, 2) : directions.value.rows) {
      const from = formatAgentAddress({ agentId: d.from.agentId, machine: d.from.machineId }), to = formatAgentAddress({ agentId: d.to.agentId, machine: d.to.machineId });
      const active = value(d.userLink) === true || value(d.cardLink) === true || !!value(d.makers)?.length;
      const uncertain = d.userLink.state !== 'ok' || d.cardLink.state !== 'ok' || d.makers.state !== 'ok';
      const existing = pairs.get(key(from, to, 'agent')); if (!existing && !active && !uncertain) continue;
      const pair = existing ?? ensure(from, to, 'agent'); pair.saved = d;
      const other = d.from.machineId ? d.from : d.to.machineId ? d.to : undefined; if (other?.machineId) { pair.machine = other.machineId.toLowerCase(); pair.remoteAgent = other.agentId; }
    }
    const ambiguousIdentities = new Set<string>(), nativeIdentities = new Set<string>();
    for (const direction of automatic) {
      if (options.dispatcher || direction.agentId !== selected && direction.targetId !== selected) throw new Error('automatic_connection_scope');
      const other = direction.agentId === selected ? direction.targetId : direction.agentId;
      const manualPair = pairs.get(key(direction.agentId, direction.targetId, 'agent', 'manual'));
      const nativePair = pairs.get(key(direction.agentId, direction.targetId, 'agent'));
      if (nativePair) { nativePair.identityGroup = 'native'; nativeIdentities.add(other); ambiguousIdentities.add(other); }
      if (manualPair && manualPair.identityGroup !== 'controller') ambiguousIdentities.add(other);
      // Native IDs do not join project-qualified manual records to the role.
      // Only the same exact privately admitted primary folder can converge.
      const pair = manualPair?.identityGroup === 'controller' ? manualPair : ensure(direction.agentId, direction.targetId, 'agent', 'automatic');
      pair.identityGroup = 'controller'; pair.automatic = direction;
    }
    for (const pair of pairs.values()) {
      const other = pair.from === selected ? pair.to : pair.from;
      if (!ambiguousIdentities.has(other) || pair.kind !== 'agent') continue;
      pair.labelScope = pair.identityGroup === 'controller' ? 'automatic' : pair.manual ? 'manual' : 'native';
      if (pair.labelScope !== 'native' && nativeIdentities.has(other)) pair.switchAssociationUnknown = true;
    }
    if (ambiguousIdentities.size) c.notes.push('Records sharing a native ID are listed by their separate configured source or native-ID record. Their endpoint projects are not verified equal here; names, direction grouping and source defaults are kept separate.');
    const dispatcherSource = (source: CachedSourceDisplay) => ['dispatcher_auto', 'dispatcher_link', 'dispatcher_federation'].includes(connectionSourceKind(source.sourceId));
    const needsDispatcher = options.dispatcher || [...pairs.values()].some((pair) => pair.sources.some(dispatcherSource) || !!pair.manual || !!pair.automatic);
    const localDispatcher = needsDispatcher ? readDispatcherEnablementForDisplay({ receipts: options.receipts }) : undefined;
    if (localDispatcher) {
      row(c, 'Host Dispatcher', localDispatcher.enabled.state === 'ok' ? localDispatcher.enabled.value ? 'On' : 'Off' : 'Unavailable from host metadata');
      const why = localDispatcher.reason.state === 'ok' ? localDispatcher.reason.value : undefined;
      row(c, 'Host Dispatcher availability', why === 'switch_off' ? 'Switch saved off' : why === 'experimental_off' ? 'Dispatcher flag saved off' : why === 'classic_layout' ? 'Classic session layout' : why === null ? 'No off reason recorded' : 'Reason unavailable from host metadata');
    }
    const own = options.dispatcher ? captureOwnPairingForDisplay({ receipts: options.receipts }) : undefined;
    const machines = new Map<string, ReturnType<typeof readPeerMetadataForDisplay>>();
    const grouped = new Map<string, { direction: 'to' | 'from' | 'two-way'; remote: boolean }>();
    const groupKey = (pair: Pair) => `${pair.kind}\0${pair.identityGroup ?? ''}\0${pair.from === selected ? pair.to : pair.from}`;
    for (const pair of pairs.values()) {
      const other = pair.from === selected ? pair.to : pair.from;
      if (pair.kind === 'agent' && !pair.machine) { const address = parseAgentAddress(other); if (address.machine) { pair.machine = address.machine; pair.remoteAgent = address.agentId; } }
      const key = groupKey(pair), existing = grouped.get(key);
      grouped.set(key, { direction: mergeConnectionDirection(existing?.direction, pair.from === selected ? 'to' : 'from'), remote: !!pair.machine });
    }
    const remoteCount = [...grouped.values()].filter((g) => g.remote).length;
    c.summary = remoteCount ? `${[...pairs.values()].filter((p) => !p.machine).length} local directions · ${remoteCount} remote connections` : `${pairs.size} known ${pairs.size === 1 ? 'direction' : 'directions'}`;
    for (const pair of pairs.values()) {
      const outgoingPair = pair.from === selected, other = outgoingPair ? pair.to : pair.from;
      if (pair.kind === 'agent' && !pair.machine) { const address = parseAgentAddress(other); if (address.machine) { pair.machine = address.machine; pair.remoteAgent = address.agentId; } }
      const makers = pair.saved?.makers;
      const makerField = makers && (makers.state !== 'ok' || !!makers.value.length);
      const fields = 3 + (pair.machine ? 3 + (options.dispatcher ? 1 : 0) : 0) + (makerField ? 1 : 0) + (pair.manual ? 3 : 0) + (pair.manual && pair.identityGroup ? 1 : 0) + (pair.automatic ? 1 : 0) + (pair.manualFields ? 1 + (pair.manualFields.memory ? 1 : 0) : 0);
      if (c.rows.length >= REMOTE_DETAILS_MAX_ROWS) { c.omitted += fields; continue; }
      const sourceBinding = pair.sources.map((source) => value(source.binding)).find((b) => !!b);
      const record = pair.binding ?? sourceBinding;
      // Match the local card's fallback order: a group project's project
      // name wins; an incoming agent's target label names THIS agent and must
      // never be borrowed as the sender's name.
      const ordinary = outgoingPair
        ? pair.kind === 'group-project' ? boundedName(value(record?.projectName)) ?? boundedName(value(record?.targetName)) ?? boundedName(value(record?.label))
          : boundedName(value(record?.targetName)) ?? boundedName(value(record?.label))
        : boundedName(value(record?.agentName));
      const independentSavedLink = value(pair.saved?.userLink) === true || value(pair.saved?.cardLink) === true || !!value(pair.saved?.makers)?.length;
      const savedOnlyIdentity = !!pair.manual && !pair.binding && !sourceBinding && !independentSavedLink;
      // A saved project-qualified manual entry does not authorize borrowing a
      // current cached name for a reused native ID in another project.
      const automaticOnlyIdentity = !!pair.automatic && !pair.binding && !sourceBinding && !independentSavedLink;
      const resolved = savedOnlyIdentity ? pair.manualFields?.displayName : pair.labelScope === 'native' ? ordinary : automaticOnlyIdentity ? boundedName(outgoingPair ? pair.automatic?.targetName : pair.automatic?.agentName) : (pair.kind === 'agent' && isDispatcherIdentityAgentId(other) ? refs.get(other) : undefined)
        ?? ordinary ?? boundedName(outgoingPair ? pair.automatic?.targetName : pair.automatic?.agentName) ?? (pair.kind === 'agent' ? refs.get(other) : undefined);
      if (savedOnlyIdentity) {
        const note = pair.manualFields?.primaryAdmitted ? 'Saved target settings are shown with host memory values separately. These observations do not confirm that this link works now.' : 'The saved target’s current project identity is not confirmed; its saved ID is shown.';
        if (!c.notes.includes(note)) c.notes.push(note);
      }
      const label = resolved ?? pair.remoteAgent ?? other;
      if (pair.machine && !resolved) {
        const note = 'A saved target name is unavailable or ambiguous in retained host metadata; its saved address is shown.';
        if (!c.notes.includes(note)) c.notes.push(note);
      }
      const name = display(label, 240) + (pair.labelScope === 'automatic' ? ' (automatic Dispatcher)' : pair.labelScope === 'manual' ? ' (saved Dispatcher link)' : pair.labelScope === 'native' ? ' (native-ID records)' : '');
      const bound = !!pair.binding;
      const complete = outgoingPair ? outComplete : inComplete;
      const status = bound ? 'binding recorded in host memory' : complete && pair.kind !== 'unknown' ? 'saved or retained, not bound now' : 'binding presence unavailable';
      const family = pair.kind === 'agent' && options.family ? options.family.parentId === other ? ' · orchestrator' : options.family.helperIds.has(other) ? ' · helper' : '' : '';
      row(c, name, `${kindWords(pair.kind)} · ${grouped.get(groupKey(pair))?.direction === 'two-way' ? 'two-way records' : outgoingPair ? 'sends to it' : 'sends to this agent'}${family} · ${outgoingPair ? 'outgoing' : 'incoming'} ${status}${pair.machine ? ` · saved network link · ${resolved ? 'names from retained metadata' : 'target name unavailable'}` : ''}`);
      row(c, `${name} ${outgoingPair ? 'outgoing' : 'incoming'} switches`, toolsFor(pair, savedComplete));
      const sourceLabels = new Set(pair.sources.map((source) => `${CONNECTION_SOURCE_LABELS[connectionSourceKind(source.sourceId)]}${source.removedByUser ? ' (removed here)' : !source.verified ? ' (unverified or unreconciled)' : ''}${source.binding.state !== 'ok' ? ' (details unavailable)' : ''}${dispatcherSource(source) && localDispatcher?.enabled.state === 'ok' && !localDispatcher.enabled.value ? ' (host Dispatcher off)' : ''}`));
      if (value(pair.saved?.userLink)) sourceLabels.add(CONNECTION_SOURCE_LABELS.user_link);
      if (value(pair.saved?.cardLink)) sourceLabels.add(CONNECTION_SOURCE_LABELS.card_link);
      if (value(pair.saved?.makers)?.length) sourceLabels.add(CONNECTION_SOURCE_LABELS.tool_link);
      const uncertainSource = pair.saved && (pair.saved.userLink.state !== 'ok' || pair.saved.cardLink.state !== 'ok' || pair.saved.makers.state !== 'ok');
      if (uncertainSource) sourceLabels.add('Saved source information unavailable');
      if (pair.automatic) sourceLabels.add('Connect to Dispatcher (saved policy)');
      if (pair.manual) sourceLabels.add(`Made by the Dispatcher (saved record${value(pair.manual.removalRecorded) === true || value(pair.manualMemory?.pendingRemoval) === true ? ', removal recorded' : ''})`);

      row(c, `${name} sources`, [...sourceLabels].join(', ') || (sources.state === 'ok' && sources.value.complete ? 'No source reported in the retained cache' : 'Source information unavailable'));
      if (pair.manual && pair.identityGroup) {
        const start = localDirectionTools(undefined);
        row(c, `${name} manual starting switches`, `Configured manual source defaults · On: ${labels(start.allowed)}; Off: ${labels(start.disabled)} · not effective tool authority`);
      }
      if (pair.automatic) {
        const start = localDirectionTools({ disabledTools: pair.automatic.disabledTools, enabledTools: pair.automatic.enabledTools });
        row(c, `${name} automatic starting switches`, `Configured source defaults · On: ${labels(start.allowed)}; Off: ${labels(start.disabled)} · not effective tool authority`);
      }
      if (pair.manualFields) {
        row(c, `${name} saved target`, pair.manualFields.saved);
        if (pair.manualFields.memory) row(c, `${name} host memory target`, pair.manualFields.memory);
      }
      if (pair.manual) {
        const queued = value(pair.manualMemory?.pendingRemoval), persisted = value(pair.manualMemory?.removalSaved), removed = value(pair.manual.removalRecorded);
        row(c, `${name} saved Dispatcher link`, removed === true ? 'Removal record found in saved settings' : removed === false ? 'No removal record in saved settings' : 'Saved removal status unavailable');
        const processRemoval = queued === true ? persisted === false ? 'Removal queued; last save failed' : persisted === true ? 'Removal queued; save was reported successful' : 'Removal queued; save status unavailable'
          : queued === false ? 'No queued removal reported in this host session' : 'Queued removal status unavailable';
        const policy = value(options.connectToDispatcher), enabled = value(localDispatcher?.enabled);
        const writes = manualMemory?.state === 'ok' ? manualMemory.value.storeWrites : undefined;
        const restrictions = [enabled === false ? 'Host Dispatcher off' : '', policy === false ? 'Selected Connect to Dispatcher off' : '',
          writes === 'recorded-blocked' ? 'Earlier store write failed' : '', removed === true ? 'Saved removal recorded' : '', queued === true ? 'Removal pending in host memory' : ''].filter(Boolean);
        row(c, `${name} manual source eligibility`, `${restrictions.length ? `Restriction evidence: ${restrictions.join('; ')}` : 'No restriction confirmed by the available selected records'} · ${queued === undefined ? 'Pending removal unknown' : queued ? 'Pending removal recorded' : 'No pending removal in host memory'} · Current endpoint eligibility and active/suspended status unknown: no qualified current endpoint census is available. Other sources and recorded bindings are independent.`);
        row(c, `${name} Dispatcher availability`, [enabled === false ? 'Host Dispatcher saved off' : enabled === undefined ? 'Host Dispatcher switch unavailable' : 'Host Dispatcher saved on',
          !options.dispatcher ? policy === false ? 'This agent’s Connect to Dispatcher is off' : policy === true ? 'This agent’s Connect to Dispatcher is on' : 'This agent’s Dispatcher setting unavailable' : '',
          processRemoval, writes === 'recorded-blocked' ? 'Last file-save check failed' : writes === 'recorded-writable' ? 'Earlier file-save check succeeded' : writes === 'unobserved' ? 'File-save checks not yet reported' : 'File-save status unavailable', 'Other endpoint eligibility not confirmed'].filter(Boolean).join(' · '));
      }
      if (makerField) row(c, `${name} made by`, makers.state === 'ok' ? makers.value.map((maker) => boundedName(value(maker.name)) || refs.get(formatAgentAddress({ agentId: maker.agentId, machine: maker.machineId })) || formatAgentAddress({ agentId: maker.agentId, machine: maker.machineId })).join(', ') : 'Unavailable from the saved record');
      if (pair.machine) {
        if (!machines.has(pair.machine)) machines.set(pair.machine, readPeerMetadataForDisplay(pair.machine, { receipts: options.receipts }));
        const peer = machines.get(pair.machine)!, metadata = value(peer), machine = retainedMachine(pair.machine); options.receipts.push(machineReceipt(pair.machine, hash(machine)));
        row(c, `${name} address`, other);
        row(c, `${name} host record`, `${machine.alias || value(metadata?.alias) || pair.machine} · ${machine.pairingRequired ? 'pairing reported required' : `retained transport: ${machine.state}`}${machine.snapshotMissing || machine.incomplete ? ' · snapshot missing or incomplete' : ''}`);
        row(c, `${name} last seen`, value(metadata?.lastSeen) || (metadata?.lastSeen.state === 'ok' ? 'Not recorded' : 'Unavailable from retained metadata'));
        if (options.dispatcher && own) {
          const peerPairing = capturePeerPairingForDisplay(pair.machine, { receipts: options.receipts });
          const publication = readFederationControllerForDisplay(pair.machine, { own, peer: peerPairing, receipts: options.receipts });
          const info = value(publication), matchesTarget = info?.agentId.state === 'ok' && info.agentId.value === pair.remoteAgent;
          let state = 'Controller publication association unavailable for this target';
          if (matchesTarget && info?.association === 'matched-retained') {
            const pause = readRegisteredFederationPauseForDisplay(pair.machine, { receipts: options.receipts });
            const enabled = info.enabled.state === 'ok' ? info.enabled.value ? 'On' : 'Off' : 'Unavailable';
            state = `Recorded Dispatcher: ${value(info.name) ?? 'name unavailable'} · ${enabled} · published presence: ${value(info.presence) ?? 'not reported'}`;
            if (pause.state !== 'ok') state += ' · request-service pause unavailable';
            else if (!pause.value.recorded) state += ' · no pause in the established service record';
            else {
              const applies = pause.value.appliesToEpoch(own, peerPairing);
              state += applies === true ? ` · pause recorded: ${pause.value.reason?.state === 'ok' ? pause.value.reason.text : 'reason withheld or unavailable'}`
                : applies === false ? ' · earlier pairing pause retained' : ' · pause pairing association unavailable';
            }
          } else if (matchesTarget && info?.association === 'mismatch') state = 'Recorded publication belongs to a different retained pairing';
          row(c, `${name} network record`, state);
        }
      }
    }
    for (const [label, read] of [['outgoing bindings', outgoing], ['incoming bindings', incoming], ['saved directions', directions]] as const) {
      if (read.state !== 'ok') c.notes.push(`${label[0].toUpperCase()}${label.slice(1)} are unavailable; no empty list is inferred.`);
      else if (read.value.omitted) c.notes.push(`${read.value.omitted} additional ${label} are outside this bounded page.`);
    }
    if (manual) {
      if (manual.state !== 'ok') c.notes.push('Saved manual Dispatcher link metadata is unavailable; no empty list or current link eligibility is inferred.');
      else {
        if (manual.value.omitted) c.notes.push(`${manual.value.omitted} additional saved Dispatcher link${manual.value.omitted === 1 ? ' is' : 's are'} outside this bounded page.`);
        if (manual.value.excludedProjectRecords) c.notes.push(`${manual.value.excludedProjectRecords} saved Dispatcher link records belong to another project association and were excluded.`);
        c.notes.push('Saved Dispatcher links show saved settings and removal reports from this host session. The saved target’s current project, availability and tool access are not confirmed by those records.');
      }
    }
    if (options.automatic?.state === 'unavailable') c.notes.push('Automatic Dispatcher source details are unavailable; no empty source list is inferred.');
    else if (options.automatic?.state === 'ok') c.notes.push(options.automatic.value.length ? 'Automatic Dispatcher directions come from saved selected-agent policy and an admitted controller identity. These configured directions do not establish current bindings, eligibility or effective tool access.' : 'The selected saved policy configures no automatic Dispatcher direction. Other connection sources remain independent.');
    if (sources.state !== 'ok') c.notes.push('Registered source metadata is unavailable. Other sources may hold these connections.');
    else {
      if (!sources.value.sourceStates.length) c.notes.push('No registered source inventory is retained for this read. Saved source coverage is unavailable.');
      const incomplete = sources.value.sourceStates.filter((source) => source.state !== 'known').length;
      if (incomplete) c.notes.push(`${incomplete} registered source inventories are partial or unavailable; additional source ownership may be missing.`);
      if (sources.value.omitted) c.notes.push(`${sources.value.omitted} additional cached source pairs are outside this bounded page.`);
    }
    if (!pageSource && !pairs.size && outComplete && inComplete && savedComplete && sources.state === 'ok' && sources.value.complete && sources.value.sourceStates.length && manual?.state !== 'unavailable' && options.automatic?.state !== 'unavailable') c.notes.push('No binding or active saved direction was reported in the available host records.');
    if (pageSource) c.notes.push('This page shows one selected source or binding inventory. Other sources are independent; pages are fresh observations, not one frozen snapshot.');
    c.notes.push('Names, bindings and source ownership use saved or retained host records. Additional configured connections may be missing from this retained view. Other agents’ current availability and effective tool authority are not confirmed here.');
    if (!pageSource && !pairs.size && (!outComplete || !inComplete || !savedComplete || sources.state !== 'ok' || !sources.value.complete || !sources.value.sourceStates.length || !!untypedIncomingSources || manual?.state === 'unavailable' || options.automatic?.state === 'unavailable')) { c.state = 'error'; c.summary = 'Connection information incomplete'; }
    if (!options.authorized()) throw new Error('revoked');
  } finally { c.notes.push(...refs.finish(options.receipts)); }
}

/** Project-qualified configured source rows stay separate from native-ID records.
 * Source defaults describe saved composition, never effective permission or MCP Connected. */
function renderRegisteredConnections(c: RemoteDetailsCard, read: DisplayValue<ConfiguredRegisteredConnectionPage> | undefined, query: RemoteDetailsQuery): void {
  if (read?.state !== 'ok') { c.state = 'error'; c.summary = 'Configured relationships unavailable'; c.notes.push('The selected registered relationship page is unavailable; no empty list is inferred.'); return; }
  const page = read.value;
  c.connectionPage = { source: query.source, offset: page.matchOffset, projectOffset: page.projectOffset, known: page.knownMatches, complete: page.complete,
    next: page.next ? { offset: page.next.matchOffset, projectOffset: page.next.projectOffset } : null };
  c.summary = `${page.knownMatches} known ${query.source === 'helpers' ? 'helper records' : query.source === 'helper-parent' ? 'saved parent references' : 'Dispatcher policy records'} in this project page${page.complete ? '' : ' · partial'}`;
  if (page.parentReference) row(c, 'Saved parent reference', `${page.parentReference.agentId}${page.parentReference.projectName?.state === 'ok' ? ` · ${page.parentReference.projectName.value}` : ' · project association unavailable'}`);
  for (const entry of page.entries) {
    const endpoint = entry.endpoint, fields = endpointCardFields({ agentId: '', targetId: endpoint.agentId, relationship: 'recorded',
      endpoint: { state: 'ok', value: { record: 'registered-primary', fields: endpoint.fields }, inputs: [] }, hostCache: entry.hostCache });
    const name = fields.displayName || endpoint.agentId, projectName = endpoint.projectName.state === 'ok' ? endpoint.projectName.value : 'Project name unavailable';
    // Include both stable project identity and display label when names collide.
    const label = `${name} · ${projectName}`;
    row(c, label, `${entry.source === 'helper' ? 'Direct helper' : entry.source === 'helper-parent' ? 'Selected helper’s parent' : 'Automatic Dispatcher source'} · ${entry.applicability === 'configured' ? 'two configured directions' : entry.applicability === 'disposed' ? 'disposed; no configured directions' : 'configured applicability unknown'} · project ${endpoint.projectId}`);
    if (endpoint.identityAmbiguous) row(c, `${label} identity`, 'This project record reuses the controller’s native ID. The endpoint association is ambiguous; configured directions are unavailable.');
    row(c, `${label} saved settings`, fields.saved);
    if (fields.memory) row(c, `${label} host memory`, fields.memory);
    for (const direction of entry.directions) {
      const tools = localDirectionTools(undefined, direction.disabledTools, direction.enabledTools);
      row(c, `${label} ${direction.from === 'selected' ? 'outgoing' : 'incoming'} starting switches`, `Source defaults · On: ${labels(tools.allowed)}; Off: ${labels(tools.disabled)} · not effective tool authority`);
    }
  }
  if (page.unknownRows) c.notes.push(`${page.unknownRows} relationship records could not be classified safely in this project page.`);
  if (page.unavailableProjects) c.notes.push(`${page.unavailableProjects} project inventories are unavailable or exceed this read's bounds.`);
  c.notes.push('Saved configured relationships are project-qualified and separate from native-ID bindings. Host-memory observations are shown separately. No current run, MCP handshake, reachability or effective tool authority is established.');
  c.notes.push('At most eight related endpoints are shown per page. Pages are separately authorized observations; changing inventories can shift continuation.');
}

/** Recorded source data stays independent of operational collection/permission. */
function renderSavedToolConnections(c: RemoteDetailsCard, read: DisplayValue<SavedToolConnectionPage> | undefined, query: RemoteDetailsQuery): void {
  if (read?.state !== 'ok') { c.state = 'error'; c.summary = 'Saved tool records unavailable'; c.notes.push('The selected saved tool-source page is unavailable; no empty list is inferred.'); return; }
  const page = read.value;
  c.connectionPage = { source: query.source, offset: page.offset, projectOffset: page.projectOffset, known: page.knownMatches, complete: page.complete, next: page.next };
  c.summary = `${page.knownMatches} known saved tool records in this project page${page.complete ? '' : ' · partial'}`;
  for (const entry of page.rows) {
    const endpointId = entry.direction === 'outgoing' ? entry.targetId : entry.agentId;
    const fields = entry.endpoint ? endpointCardFields({ agentId: entry.agentId, targetId: entry.targetId, relationship: 'recorded', endpoint: entry.endpoint }) : undefined;
    const projectName = entry.sourceProjectName.state === 'ok' ? entry.sourceProjectName.value : 'Project name unavailable';
    const name = `${fields?.displayName || endpointId} · ${projectName}`;
    row(c, name, `Saved tool-created ${entry.targetKind} record · ${entry.direction} · source project ${entry.sourceProjectId} · current source eligibility unconfirmed`);
    const tools = localDirectionTools(undefined, entry.disabledTools, entry.enabledTools);
    row(c, `${name} starting switches`, `Source defaults · On: ${labels(tools.allowed)}; Off: ${labels(tools.disabled)} · not effective tool authority`);
    row(c, `${name} saved declaration`, entry.declaredScope === 'granted' ? 'Grant-scoped creation recorded; current grant not evaluated here' : entry.declaredScope === 'helper-family' ? 'Helper-family creation recorded; current owner/helper membership not evaluated here' : 'Creation scope unavailable');
    if (entry.createdAt) row(c, `${name} recorded`, entry.createdAt);
    if (fields) row(c, `${name} saved target`, fields.saved);
  }
  if (page.unknownRows) c.notes.push(`${page.unknownRows} candidate tool-source records could not be classified safely.`);
  if (page.unavailableProjects) c.notes.push(`${page.unavailableProjects} saved tool-source inventories are unavailable or exceed this read's bounds.`);
  c.notes.push('These are selected project-qualified saved records, not a source collection or live binding report. Current owner membership, grants, availability and effective tool authority remain separate.');
}

/** Independently saved source projection; never merged by native ID with another source. */
function renderSavedCanvasConnections(c: RemoteDetailsCard, read: DisplayValue<SavedCanvasConnectionPage> | undefined, query: RemoteDetailsQuery): void {
  const source = query.source === 'zone-records' ? 'zone' : 'Canvas';
  if (read?.state !== 'ok') { c.state = 'error'; c.summary = `Saved ${source} records unavailable`; c.notes.push('This selected saved-source page is unavailable; no empty list is inferred.'); return; }
  const page = read.value;
  c.connectionPage = { source: query.source, offset: page.offset, projectOffset: page.projectOffset, known: page.knownMatches, complete: page.complete, next: page.next };
  c.summary = `${page.knownMatches} known saved ${source} relationships in this store page${page.complete ? '' : ' · partial'}`;
  for (const entry of page.rows) {
    const id = entry.direction === 'outgoing' ? entry.targetId : entry.agentId;
    const fields = entry.endpoint ? endpointCardFields({ agentId: entry.agentId, targetId: entry.targetId, relationship: 'recorded', endpoint: entry.endpoint }) : undefined;
    const store = entry.sourceName.state === 'ok' ? entry.sourceName.value : 'Store name unavailable', name = `${fields?.displayName || id} · ${store}`;
    row(c, name, `Saved ${source} ${entry.targetKind} record · ${entry.direction} · ${entry.sourceScope === 'app' ? 'Home store' : `project ${entry.sourceProjectId}`} · current eligibility unconfirmed`);
    row(c, `${name} saved label`, entry.savedLabel);
    if (entry.startingTools === 'recorded') {
      const tools = localDirectionTools(undefined, entry.disabledTools, []);
      row(c, `${name} starting switches`, `Recorded starting list · On: ${labels(tools.allowed)}; Off: ${labels(tools.disabled)}${entry.unrecognizedTools ? `; ${entry.unrecognizedTools} unrecognized tool names withheld` : ''} · not effective tool authority`);
    } else row(c, `${name} starting switches`, entry.startingTools === 'absent' ? 'No starting switch list saved; saved directions and bindings remain separate' : 'Starting switch list unavailable; saved directions and bindings remain separate');
    if (fields) row(c, `${name} saved target`, fields.saved);
  }
  if (page.unknownRows) c.notes.push(`${page.unknownRows} candidate records or bounded expansion segments could not be classified safely.`);
  if (page.unavailableStores) c.notes.push(`${page.unavailableStores} saved stores are unavailable or exceed this read’s bounds.`);
  c.notes.push('Saved project-qualified Canvas records or a preview of saved active-canvas zone containment (first saved canvas when no active key is recorded). Unsaved host changes, group scope/membership, user removal, current bindings and effective authority are separate; no source collection is run. Names and labels are bounded display text.');
}

function renderSavedGroupConnections(c: RemoteDetailsCard, read: DisplayValue<SavedGroupConnectionPage> | undefined): void {
  if (read?.state !== 'ok') { c.state = 'error'; c.summary = 'Saved group records unavailable'; c.notes.push('The selected saved group-source page is unavailable; no empty membership is inferred.'); return; }
  const page = read.value;
  c.connectionPage = { source: 'group-records', offset: page.offset, projectOffset: 0, known: page.knownMatches, complete: page.complete, next: page.next };
  c.summary = `${page.knownMatches} known selected group records in this registry page${page.complete ? '' : ' · partial'}`;
  for (const entry of page.rows) {
    row(c, entry.name, `Saved group-project record · ${entry.groupId} · ${entry.membership === 'auto' ? 'auto-join policy' : entry.membership === 'excluded' ? 'excluded' : 'explicit entry'} · saved applicability ${entry.applicability}`);
    row(c, `${entry.name} scope`, `${entry.scope} scope · ${entry.reach} reach · ${entry.host === 'local-contract' ? 'local host record contract' : entry.host === 'loaded-local' ? 'host matches loaded local identity' : entry.host === 'loaded-other' ? 'recorded other host' : 'host association unavailable'}`);
    row(c, `${entry.name} saved switches`, entry.disabledTools ? `${entry.switchSource === 'member' ? 'Selected member' : 'Group default'} disabled tools: ${entry.disabledTools.join(', ') || 'none'}${entry.unrecognizedTools ? `; ${entry.unrecognizedTools} unrecognized names withheld` : ''} · not effective tool authority` : entry.switchSource === 'invalid' ? 'Saved switch list unavailable' : 'No switch list saved; no effective defaults inferred');
  }
  if (page.unknownRows) c.notes.push(`${page.unknownRows} candidate group relationships have unconfirmed host/project association or applicability.`);
  if (page.unavailableGroups) c.notes.push(`${page.unavailableGroups} saved membership records are unavailable or exceed this read’s bounds.`);
  c.notes.push('Only selected saved membership/policy fields are shown. Loaded identity comparison is display evidence, not pairing or transport authority. Pending owner changes, current resolution/bindings, network availability and effective permissions are separate; no migration or collection is run.');
}
