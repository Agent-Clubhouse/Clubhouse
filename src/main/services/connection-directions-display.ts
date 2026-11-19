/** Bounded selected saved connection metadata, not an authority or runtime binding reader. */
import type { AgentAddress } from '../../shared/connection-grants';
import { directionKey } from '../../shared/connection-grants';
import { peekStoredSettingsSync } from './settings-store';
import type { DisplayValue, DisplayReceipt } from './display-settings';

export const CONNECTION_DISPLAY_BYTES = 1024 * 1024;
export const CONNECTION_DISPLAY_SCAN = 4096;
export const CONNECTION_DISPLAY_PAGE = 100;
export interface ConnectionDirectionDisplay {
  from: AgentAddress;
  to: AgentAddress;
  disabledTools: DisplayValue<string[]>;
  enabledTools: DisplayValue<string[]>;
  userLink: DisplayValue<boolean>;
  cardLink: DisplayValue<boolean>;
  makers: DisplayValue<Array<{ agentId: string; machineId: string; name: DisplayValue<string | null> }>>;
}
export interface ConnectionDirectionPage {
  rows: ConnectionDirectionDisplay[];
  total: number;
  offset: number;
  omitted: number;
  nextOffset: number | null;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 200;
const date = (v: unknown): v is string => typeof v === 'string' && v.length <= 128 && Number.isFinite(Date.parse(v));
function address(v: unknown): AgentAddress | undefined {
  if (!record(v) || !identifier(v.agentId) || v.machineId !== undefined && (typeof v.machineId !== 'string' || v.machineId.length > 200)) return;
  return { agentId: v.agentId, ...(v.machineId && { machineId: v.machineId as string }) };
}
function projectDirections(agentId: string, offset: number): DisplayValue<ConnectionDirectionPage> {
  const inputs = [{ field: 'Selected committed connection metadata', source: 'primary' as const, observedAt: Date.now() }];
  const known = <T>(value: T): DisplayValue<T> => ({ state: 'ok', value, inputs });
  const unknown = <T>(reason: 'invalid' | 'unreadable' | 'limit' = 'invalid'): DisplayValue<T> => ({ state: 'unavailable', reason, inputs });
  if (!identifier(agentId) || !Number.isInteger(offset) || offset < 0 || offset > CONNECTION_DISPLAY_SCAN) return unknown();
  const raw = peekStoredSettingsSync('connection-grants.json', { maxBytes: CONNECTION_DISPLAY_BYTES });
  if (raw === 'unreadable') return unknown('unreadable');
  if (raw === 'missing' && peekStoredSettingsSync('connection-grants.json.bak', { maxBytes: CONNECTION_DISPLAY_BYTES }) !== 'missing') return unknown('unreadable');
  if (raw !== 'missing' && (!Array.isArray(raw.directions) || raw.version !== undefined && raw.version !== 1)) return unknown();
  const directions: unknown[] = raw === 'missing' ? [] : raw.directions as unknown[];
  if (directions.length > CONNECTION_DISPLAY_SCAN) return unknown('limit');
  const selected: ConnectionDirectionDisplay[] = [], keys = new Set<string>();
  for (const r of directions) {
    if (!record(r)) return unknown();
    // Malformed fields on provably unrelated ends cannot erase selected info.
    if (record(r.from) && identifier(r.from.agentId) && record(r.to) && identifier(r.to.agentId)
      && r.from.agentId !== agentId && r.to.agentId !== agentId) continue;
    const from = address(r.from), to = address(r.to);
    if (!from || !to) return unknown();
    if (!(from.agentId === agentId && !from.machineId || to.agentId === agentId && !to.machineId)) continue;
    const key = directionKey(from, to); if (keys.has(key)) return unknown(); keys.add(key);
    const tools = (v: unknown): DisplayValue<string[]> => v === undefined ? known([])
      : !Array.isArray(v) ? unknown() : v.length > 100 ? unknown('limit')
      : v.every((tool) => identifier(tool) && tool.length <= 100) ? known([...new Set(v as string[])]) : unknown();
    const link = (v: unknown): DisplayValue<boolean> => v === undefined ? known(false)
      : record(v) && date(v.createdAt) ? known(true) : unknown();
    const makers = (): ConnectionDirectionDisplay['makers'] => {
      if (r.agentLinks === undefined) return known([]);
      if (!Array.isArray(r.agentLinks)) return unknown();
      if (r.agentLinks.length > 50) return unknown('limit');
      const out: Array<{ agentId: string; machineId: string; name: DisplayValue<string | null> }> = [];
      for (const maker of r.agentLinks) {
        if (!record(maker) || !identifier(maker.agentId) || !identifier(maker.machineId) || !date(maker.createdAt)
          || maker.removedAt !== undefined && !date(maker.removedAt)) return unknown();
        if (maker.removedAt !== undefined) continue;
        out.push({ agentId: maker.agentId, machineId: maker.machineId, name: maker.name === undefined || maker.name === '' ? known(null)
          : typeof maker.name !== 'string' ? unknown() : maker.name.length > 200 ? unknown('limit') : known(maker.name) });
      }
      return known(out);
    };
    selected.push({ from, to, disabledTools: tools(r.disabledTools), enabledTools: tools(r.enabledTools), userLink: link(r.link), cardLink: link(r.cardLink), makers: makers() });
  }
  const rows = selected.slice(offset, offset + CONNECTION_DISPLAY_PAGE);
  return known({ rows, total: selected.length, offset, omitted: selected.length - rows.length,
    nextOffset: offset + rows.length < selected.length ? offset + rows.length : null });
}
const signature = (value: DisplayValue<ConnectionDirectionPage>) => JSON.stringify(value, (key, v) => key === 'inputs' ? undefined : v);
/** No raw file/record is retained: a selected key, page and bounded safe signature only. */
function pageReceipt(agentId: string, offset: number, admitted: string): DisplayReceipt {
  return { current: () => { try { return signature(projectDirections(agentId, offset)) === admitted; } catch { return false; } } };
}
export function readConnectionDirectionsForDisplay(agentId: string, options: { offset?: number; receipts?: DisplayReceipt[] } = {}): DisplayValue<ConnectionDirectionPage> {
  const offset = options.offset ?? 0, value = projectDirections(agentId, offset);
  if (identifier(agentId) && Number.isInteger(offset) && offset >= 0 && offset <= CONNECTION_DISPLAY_SCAN) options.receipts?.push(pageReceipt(agentId, offset, signature(value)));
  return value;
}
