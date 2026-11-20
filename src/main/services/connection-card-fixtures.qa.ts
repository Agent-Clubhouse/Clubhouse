/** Contract fixtures for older Details assembly tests. These model already
 * scoped passive reader DTOs; real reader/privacy/currentness proof is separate. */
import type { McpBinding } from './clubhouse-mcp/types';
import type { BindingDisplayRow, BindingDisplayDirection } from './clubhouse-mcp/binding-manager';
import type { AgentConnectionSources } from '../../shared/connection-sources';
import type { ConnectionDirection } from '../../shared/connection-grants';
const known = <T>(value: T) => ({ state: 'ok' as const, value, inputs: [] });
const missing = () => ({ state: 'unavailable' as const, inputs: [] });
export function fixtureBindingPage(raw: McpBinding[], id: string, direction: BindingDisplayDirection, project: (b: McpBinding, inputs: []) => BindingDisplayRow) {
  const rows = raw.filter((b) => direction === 'outgoing' ? b.agentId === id : b.targetKind === 'agent' && b.targetId === id && b.agentId !== id).map((b) => project(b, []));
  return known({ rows: rows.slice(0, 50), total: rows.length, offset: 0, omitted: Math.max(0, rows.length - 50), nextOffset: rows.length > 50 ? 50 : null });
}
export function fixtureSourcePage(raw: AgentConnectionSources, id: string, project: (b: McpBinding, inputs: []) => BindingDisplayRow) {
  const pairs = (raw?.pairs ?? []).filter((p) => p.agentId === id || p.targetId === id).filter((p) => p.sources.length).map((p) => ({ agentId: p.agentId, targetId: p.targetId,
    sources: p.sources.map((s) => ({ sourceId: s.sourceId, provenance: p.inspection ? 'last-inspected' as const : 'last-reconciled' as const, verified: true, removedByUser: false, copies: 1,
      binding: known(project({ agentId: p.agentId, targetId: p.targetId, targetKind: 'agent', label: p.inspection?.targetName ?? p.targetId, agentName: p.inspection?.agentName, targetName: p.inspection?.targetName }, [])) })) }));
  const sourceStates = [...new Set(raw?.unreadable ?? [])].map((sourceId) => ({ sourceId, state: 'unavailable' as const, reason: 'uninitialized' as const }));
  // The legacy empty fixture models an established known-empty source read,
  // not an uninitialized production registry.
  if (!sourceStates.length) sourceStates.push({ sourceId: 'fixture-established', state: 'known' as never, reason: undefined as never });
  return known({ scope: 'registered-cache-only' as const, complete: !(raw?.unreadable?.length), pairs: pairs.slice(0, 50), sourceStates, total: pairs.length, offset: 0, omitted: Math.max(0, pairs.length - 50), nextOffset: pairs.length > 50 ? 50 : null });
}
export function fixtureDirectionPage(raw: ConnectionDirection[], id: string) {
  const rows = raw.filter((d) => d.from.agentId === id && !d.from.machineId || d.to.agentId === id && !d.to.machineId).map((d) => ({ from: d.from, to: d.to, disabledTools: known(d.disabledTools ?? []), enabledTools: known(d.enabledTools ?? []), userLink: known(!!d.link), cardLink: known(!!d.cardLink), makers: known((d.agentLinks ?? []).filter((m) => !m.removedAt).map((m) => ({ agentId: m.agentId, machineId: m.machineId, name: known(m.name ?? null) }))) }));
  return known({ rows: rows.slice(0, 100), total: rows.length, offset: 0, omitted: Math.max(0, rows.length - 100), nextOffset: rows.length > 100 ? 100 : null });
}
export function fixturePeerMetadata(raw: { alias?: string; lastSeen?: string } | undefined) { return raw ? known({ alias: known(raw.alias ?? null), lastSeen: known(raw.lastSeen ?? null) }) : missing(); }
