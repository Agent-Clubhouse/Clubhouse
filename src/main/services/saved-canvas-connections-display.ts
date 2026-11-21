/** Primary-only selected saved Canvas/zone relationships. No owner load, collection or effect. */
import { app } from 'electron';
import { REMOVED_CANVAS_VIEW_TYPES, reconcilePersistedWires } from '../../shared/canvas-persistence';
import { CONNECTION_SWITCHES } from '../../shared/connection-grants';
import type { DisplayReceipt, DisplayValue } from './display-settings';
import { readRegisteredProjectRootsForDisplay } from './registered-project-roots-display';
import { createReadOnlyMetadataBudget, readReadOnlyConnectionSourceMetadata, ReadOnlyMetadataLimitError, type ReadOnlyConnectionSourceMetadata } from './read-only-agent-target-witness';
import { readConnectionEndpointMetadataForDisplay, type AdmittedConnectionEndpoint, type ConnectionEndpointMetadata } from './connection-endpoint-metadata-display';
import { display } from './remote-details-presentation';
import { hasAsciiControl } from '../../shared/ascii-control';

export interface SavedCanvasConnection {
  agentId: string; targetId: string; targetKind: 'agent' | 'browser' | 'group-project' | 'terminal';
  direction: 'outgoing' | 'incoming';
  source: 'canvas' | 'zone'; sourceScope: 'app' | 'project'; sourceProjectId?: string;
  sourceName: DisplayValue<string>; savedLabel: string;
  disabledTools: string[]; unrecognizedTools: number; startingTools: 'recorded' | 'absent' | 'invalid';
  endpoint?: DisplayValue<ConnectionEndpointMetadata>;
}
export interface SavedCanvasConnectionPage {
  rows: SavedCanvasConnection[]; knownMatches: number; complete: boolean; unknownRows: number; unavailableStores: number;
  projectOffset: number; offset: number; next: { projectOffset: number; offset: number } | null;
}
interface View { id: string; type: string; agentId?: string; projectId?: string; displayName?: string; pluginWidgetType?: string; metadata?: { groupProjectId?: string }; containedViewIds?: string[] }
interface Canvas { id: string; views: View[] }
interface Pair { agentId: string; targetId: string; targetKind: SavedCanvasConnection['targetKind']; label: string; disabledTools?: unknown }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const key = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 200 && !hasAsciiControl(v);
const local = (v: string) => !v.includes('||') && !v.includes('@');
const current = (r: DisplayReceipt) => { try { return r.current(); } catch { return false; } };
function combine(rs: readonly DisplayReceipt[]): DisplayReceipt { const captured = [...new Set(rs)]; return { current: () => captured.every(current) }; }
const kinds = new Set(['agent', 'browser', 'group-project', 'terminal']);

/** Validate before traversal. Raw text/metadata/config is never retained in the result or receipts. */
function canvases(raw: unknown): Canvas[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 4096) throw new Error('Invalid saved Canvas inventory.');
  const out: Canvas[] = [], ids = new Set<string>(), viewIds = new Set<string>(); let visits = raw.length, membershipVisits = 0;
  for (const c of raw) {
    if (!record(c) || !key(c.id) || ids.has(c.id) || !Array.isArray(c.views) || (visits += c.views.length) > 4096) throw new Error('Ambiguous or oversized saved Canvas inventory.');
    ids.add(c.id); const views: View[] = [];
    for (const v of c.views) {
      if (!record(v) || !key(v.id) || typeof v.type !== 'string' || viewIds.has(v.id)) throw new Error('Ambiguous saved Canvas view.');
      viewIds.add(v.id); if (REMOVED_CANVAS_VIEW_TYPES.has(v.type)) continue;
      if (!['agent', 'anchor', 'plugin', 'sticky-note', 'zone'].includes(v.type)) throw new Error('Unknown saved Canvas view.');
      if (v.type === 'agent' && v.agentId !== null && !key(v.agentId)) throw new Error('Invalid agent view.');
      if (v.projectId !== undefined && !key(v.projectId)) throw new Error('Invalid agent project association.');
      const view: View = { id: v.id, type: v.type, ...(key(v.agentId) && { agentId: v.agentId }), ...(key(v.projectId) && { projectId: v.projectId }),
        ...(typeof v.displayName === 'string' && v.displayName.length <= 1024 && { displayName: display(v.displayName, 240) }),
        ...(typeof v.pluginWidgetType === 'string' && v.pluginWidgetType.length <= 200 && { pluginWidgetType: v.pluginWidgetType }) };
      if (record(v.metadata) && key(v.metadata.groupProjectId)) view.metadata = { groupProjectId: v.metadata.groupProjectId };
      if (v.type === 'zone') {
        if (!Array.isArray(v.containedViewIds) || (membershipVisits += v.containedViewIds.length) > 4096 || !v.containedViewIds.every(key)) throw new Error('Invalid or oversized zone membership.');
        view.containedViewIds = [...v.containedViewIds];
      }
      views.push(view);
    }
    out.push({ id: c.id, views });
  }
  return out;
}

/** Selected-only equivalent of the local zone expansion; never builds unrelated cross products.
 * Work admissions count all wire/contained-member/selected candidate visits. Exhaustion is explicit. */
function zonePairs(raw: unknown, views: View[], selected: string): { pairs: Pair[]; limited: boolean } {
  if (!Array.isArray(raw) || raw.length > 4096) throw new Error('Invalid saved zone wires.');
  const byId = new Map(views.map((v, i) => [v.id, { v, i }])), byAgent = new Map<string, View>(), zones = new Map<string, { agents: View[]; widgets: View[]; selected: boolean }>(), seen = new Set<string>(), pairs: Pair[] = [];
  for (const v of views) if (v.type === 'agent' && v.agentId && !byAgent.has(v.agentId)) byAgent.set(v.agentId, v);
  let left = 65536, limited = false;
  const charge = () => { if (--left < 0) { limited = true; return false; } return true; };
  const contents = (id: string): { agents: View[]; widgets: View[]; selected: boolean } => {
    if (zones.has(id)) return zones.get(id)!;
    const zone = byId.get(id)?.v, result = { agents: [] as View[], widgets: [] as View[], selected: false }; if (zone?.type !== 'zone') return result;
    const found: Array<{ v: View; i: number }> = [];
    for (const member of zone.containedViewIds ?? []) { if (!charge()) break; const v = byId.get(member); if (v) found.push(v); }
    for (const { v } of [...new Set(found)].sort((a, b) => a.i - b.i)) {
      if (v.type === 'agent' && v.agentId) { result.agents.push(v); if (v.agentId === selected) result.selected = true; }
      if (v.type === 'plugin' && (v.pluginWidgetType === 'plugin:browser:webview' || v.pluginWidgetType === 'plugin:group-project:group-project' && v.metadata?.groupProjectId)) result.widgets.push(v);
    }
    zones.set(id, result); return result;
  };
  const emit = (from: string, target: string, kind: Pair['targetKind'], label: string) => {
    if (!charge()) return;
    if (from !== selected && !(kind === 'agent' && target === selected) || kind === 'agent' && from === target) return;
    const pair = JSON.stringify([from, target]); if (seen.has(pair)) return;
    if (pairs.length >= 4096) { limited = true; return; } seen.add(pair); pairs.push({ agentId: from, targetId: target, targetKind: kind, label });
  };
  const widget = (from: string, v: View) => v.pluginWidgetType === 'plugin:browser:webview' ? emit(from, v.id, 'browser', v.displayName ?? v.id) : emit(from, v.metadata!.groupProjectId!, 'group-project', v.displayName ?? v.metadata!.groupProjectId!);
  const wireIds = new Set<string>();
  for (const w of raw) {
    if (!charge()) break;
    if (!record(w) || !key(w.id) || wireIds.has(w.id) || !key(w.sourceZoneId) || !key(w.targetId) || !['zone', 'agent', 'browser', 'group-project'].includes(String(w.targetType))) throw new Error('Invalid or ambiguous zone wire.');
    wireIds.add(w.id); const source = contents(w.sourceZoneId), sa = source.agents;
    if (w.targetType === 'agent') {
      const target = byAgent.get(w.targetId); if (!target?.agentId) continue;
      for (const a of sa) { if (!charge()) break; if (a.agentId === selected || target.agentId === selected) emit(a.agentId!, target.agentId, 'agent', target.displayName ?? target.agentId); }
      if (target.agentId === selected) for (const v of source.widgets) { if (!charge()) break; widget(selected, v); }
    } else if (w.targetType === 'zone') {
      const target = contents(w.targetId), ta = target.agents;
      if (source.selected) {
        for (const a of ta) { if (!charge()) break; emit(selected, a.agentId!, 'agent', a.displayName ?? a.agentId!); }
        for (const v of target.widgets) { if (!charge()) break; widget(selected, v); }
      }
      if (target.selected) {
        for (const a of sa) { if (!charge()) break; emit(a.agentId!, selected, 'agent', selected); }
        for (const v of source.widgets) { if (!charge()) break; widget(selected, v); }
      }
    } else if (source.selected) emit(selected, w.targetId, w.targetType as Pair['targetKind'], w.targetId);
    if (limited) break;
  }
  return { pairs, limited };
}

/** Home + registered project stores, max16 stores/page; <=4MiB/key and separate
 * <=8MiB instance/source bodies, <=4096 graph/wire rows, <=65536 zone work visits.
 * Up to8 selected rows and direct registered endpoint queries. Keep all private
 * receipts through final response; saved preview never attests live/current binding/tool authority. */
export function readSavedCanvasConnectionsForDisplay(selected: { agentId: string; projectId: string; projectPath: string; receipt: DisplayReceipt }, source: 'canvas' | 'zone', options: {
  authorized(): boolean; receipts: DisplayReceipt[]; projectOffset?: number; offset?: number;
}): DisplayValue<SavedCanvasConnectionPage> {
  const observedAt = Date.now(), inputs = [{ field: `Selected saved ${source} relationships`, source: 'primary' as const, observedAt }];
  const unknown = (reason: 'invalid' | 'changed' | 'limit' | 'unreadable'): DisplayValue<SavedCanvasConnectionPage> => ({ state: 'unavailable', reason, inputs });
  const offset = options.offset ?? 0, projectOffset = options.projectOffset ?? 0;
  if (!selected || !key(selected.agentId) || !['canvas', 'zone'].includes(source) || !Array.isArray(options.receipts) || !Number.isInteger(offset) || offset < 0 || offset > 4096 || !Number.isInteger(projectOffset) || projectOffset < 0 || projectOffset > 4096) return unknown('invalid');
  const target = selected.receipt, authorized = options.authorized, receipts = options.receipts, start = receipts.length;
  const admitted = () => { try { return authorized() && current(target); } catch { return false; } }; if (!admitted()) return unknown('changed');
  const roots = readRegisteredProjectRootsForDisplay(selected, { authorized, receipts, offset: Math.max(0, projectOffset - 1) }); if (roots.state !== 'ok') return roots;
  const home = app.getPath('home'); receipts.push({ current: () => app.getPath('home') === home });
  const stores = [...(projectOffset === 0 ? [{ path: home, id: undefined, name: { state: 'ok' as const, value: 'Home', inputs }, ordinal: 0 }] : []), ...roots.value.roots.map((r, i) => ({ ...r, ordinal: Math.max(1, projectOffset) + i }))].slice(0, 16);
  const instanceBudget = createReadOnlyMetadataBudget(), sourceBudget = createReadOnlyMetadataBudget(), rows: SavedCanvasConnection[] = [], queries: AdmittedConnectionEndpoint[] = [], positions: number[] = [];
  let knownMatches = 0, unknownRows = 0, unavailableStores = 0, complete = true, deferred: number | undefined;
  for (const [index, store] of stores.entries()) {
    if (!admitted() || !current(roots.value.receipt)) return unknown('changed');
    const prefix = `.clubhouse/${store.id === undefined ? 'plugin-data' : 'plugin-data-local'}/canvas/kv/`;
    const read = (name: string, budget = sourceBudget) => { const r = readReadOnlyConnectionSourceMetadata(store.path, (prefix + name + '.json') as ReadOnlyConnectionSourceMetadata, { budget }); receipts.push(r.receipt); return r; };
    try {
      const instances = read('canvas-instances', instanceBudget); let graph: Canvas[] = [];
      if (instances.missing) { if (!read('canvas-instances-backup', instanceBudget).missing) throw new Error('Only recovery Canvas key is present.'); }
      else graph = canvases(instances.raw);
      const data = read(source === 'canvas' ? 'canvas-wires' : 'canvas-zone-wires'); if (data.missing) continue;
      let views = graph.flatMap((c) => c.views), pairs: Pair[];
      if (source === 'zone') {
        const active = read('canvas-active-id', instanceBudget); const chosen = active.missing ? graph[0] : graph.find((c) => c.id === active.raw);
        if (!chosen) throw new Error('Saved active Canvas unavailable.'); views = chosen.views;
        const expanded = zonePairs(data.raw, views, selected.agentId); pairs = expanded.pairs; if (expanded.limited) { complete = false; unknownRows++; }
      } else {
        if (!Array.isArray(data.raw) || data.raw.length > 4096) throw new Error('Saved wire limit.');
        const valid: Pair[] = [];
        for (const w of data.raw) {
          if (!record(w) || !key(w.agentId) || !key(w.targetId) || !kinds.has(String(w.targetKind)) || typeof w.label !== 'string' || !w.label || w.label.length > 1024) { complete = false; unknownRows++; continue; }
          valid.push({ agentId: w.agentId, targetId: w.targetId, targetKind: w.targetKind as Pair['targetKind'], label: w.label, disabledTools: w.disabledTools });
        }
        pairs = reconcilePersistedWires(valid, views);
      }
      const endpointPaths = new Map<string, Set<string | undefined>>();
      for (const v of views) if (v.type === 'agent' && v.agentId) {
        const paths = endpointPaths.get(v.agentId) ?? new Set<string | undefined>();
        paths.add(v.projectId === selected.projectId ? selected.projectPath : v.projectId ? roots.value.projectPaths.get(v.projectId) : store.id ? store.path : undefined);
        endpointPaths.set(v.agentId, paths);
      }
      const endpointPath = (agentId: string): string | undefined => {
        const paths = endpointPaths.get(agentId); return paths?.size === 1 && !paths.has(undefined) ? paths.values().next().value : undefined;
      };
      const selectedPath = endpointPath(selected.agentId);
      const association = combine([target, ...receipts.slice(start)]);
      for (const p of pairs) {
        const outgoing = p.agentId === selected.agentId; if (!outgoing && !(p.targetKind === 'agent' && p.targetId === selected.agentId)) continue;
        if (!selectedPath) { complete = false; unknownRows++; continue; } if (selectedPath !== selected.projectPath) continue;
        if (++knownMatches > 4096) { knownMatches = 4096; complete = false; unknownRows++; break; }
        if (knownMatches <= offset || rows.length >= 8) continue;
        const disabled = p.disabledTools === undefined ? [] : p.disabledTools;
        const validTools = Array.isArray(disabled) && disabled.length <= 64 && disabled.every(key);
        const knownTools = validTools ? (disabled as string[]).filter((t) => CONNECTION_SWITCHES.some((s) => s.tool === t)) : [];
        const row: SavedCanvasConnection = { agentId: p.agentId, targetId: p.targetId, targetKind: p.targetKind, direction: outgoing ? 'outgoing' : 'incoming', source, sourceScope: store.id ? 'project' : 'app', ...(store.id && { sourceProjectId: store.id }), sourceName: store.name, savedLabel: display(p.label, 240), disabledTools: knownTools, startingTools: p.disabledTools === undefined ? 'absent' : validTools ? 'recorded' : 'invalid', unrecognizedTools: validTools ? (disabled as string[]).length - knownTools.length : -1 };
        const position = rows.push(row) - 1, otherId = outgoing ? p.targetId : p.agentId, otherPath = endpointPath(otherId);
        if (p.targetKind === 'agent' && otherPath && local(otherId)) { queries.push({ agentId: otherId, projectPath: otherPath, association }); positions.push(position); }
        else if (p.targetKind === 'agent') row.endpoint = { state: 'unavailable', reason: 'invalid', inputs };
      }
    } catch (error) {
      if (error instanceof ReadOnlyMetadataLimitError && error.reason === 'aggregate' && index > 0) { deferred = store.ordinal; break; }
      unavailableStores++; complete = false;
    }
  }
  if (!admitted()) return unknown('changed');
  if (queries.length) { const metadata = readConnectionEndpointMetadataForDisplay(queries, { receipts }); for (let i = 0; i < positions.length; i++) rows[positions[i]].endpoint = metadata.state === 'ok' ? metadata.value[i] : { state: 'unavailable', reason: metadata.reason, inputs: metadata.inputs }; }
  const final = combine([target, ...receipts.slice(start)]); receipts.push(final); if (!admitted() || !final.current()) return unknown('changed');
  if (offset > 0 && offset >= knownMatches) return unknown('changed');
  const nextRoot = deferred ?? (stores.length && stores[stores.length - 1].ordinal < roots.value.total ? stores[stores.length - 1].ordinal + 1 : undefined);
  return { state: 'ok', inputs, value: { rows, knownMatches, complete, unknownRows, unavailableStores, projectOffset, offset,
    next: knownMatches > offset + rows.length ? { projectOffset, offset: offset + rows.length } : nextRoot !== undefined ? { projectOffset: nextRoot, offset: 0 } : null } };
}
