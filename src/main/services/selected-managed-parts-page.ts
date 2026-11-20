/** Only chosen configured IDs, from an already admitted durable snapshot. No payload or grant resolution. */
import { createHash } from 'crypto';
import { isRemoteInventoryQuery, REMOTE_INVENTORY_MAX_ITEMS, REMOTE_INVENTORY_PAGE_SIZE, type RemoteInventoryPage, type RemoteInventoryQuery, type RemoteManagedPartRecord } from '../../shared/remote-inventory-page';
import type { AgentConfigTarget } from './agent-config-reader';
import type { DisplayReceipt } from './display-settings';
import { managedAgents } from './managed-agents';
import { display } from './remote-details-presentation';
import { isAssetId } from './asset-catalog/validation';
import { GRANT_GATED_SKILL_IDS } from '../../shared/managed-agents-types';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function readSelectedManagedPartsPage(target: AgentConfigTarget, query: RemoteInventoryQuery, options: {
  authorized(): boolean; target: DisplayReceipt; receipts: DisplayReceipt[];
}): Promise<RemoteInventoryPage> {
  if (!isRemoteInventoryQuery(query)) throw new Error('Invalid selected inventory query.');
  const base = { version: 1 as const, source: query.source, offset: query.offset ?? 0, observedAt: Date.now(), notes: [] as string[] };
  const unavailable = (reason: Extract<RemoteInventoryPage, { state: 'unavailable' }>['reason']): RemoteInventoryPage => ({ ...base, state: 'unavailable', reason });
  const current = () => options.authorized() && options.target.current();
  if (!current()) return unavailable('changed');
  const setup = target.agent.managed;
  if (!setup || setup.version !== 1) return unavailable('unsupported');
  const kind = query.source === 'selected-managed-blocks' ? 'block' : query.source === 'selected-managed-skills' ? 'skill' : 'mcp';
  const selected = kind === 'block' ? setup.blocks : kind === 'skill' ? setup.skills : setup.mcps;
  if (!Array.isArray(selected) || selected.some((id) => !isAssetId(id))) return unavailable('invalid');
  if (selected.length > REMOTE_INVENTORY_MAX_ITEMS) return unavailable('limit');
  // Full setup resolution owns grant-derived applicability. A configured-only
  // page must never turn a saved grant-gated skill choice into applicability.
  const ids = selected.filter((id) => kind !== 'skill' || !GRANT_GATED_SKILL_IDS.includes(id));
  const selection = hash([target.agent.id, target.project.id, target.project.path, query.source, selected]);
  if (query.selection && query.selection !== selection || base.offset !== 0 && base.offset >= ids.length) return unavailable('changed');
  const rows: RemoteManagedPartRecord[] = [];
  if (!ids.length) return { ...base, state: 'recorded', selection, total: 0, rows, next: null, notes: ['The selected configured list is empty; no catalog heads were read.'] };
  try {
    // A new bounded reader per page keeps the existing catalog 4MiB / 100-head
    // limits. Only 25 selected heads are queried, never the full setup.
    const reader = await managedAgents().openSetupMetadataForDisplay();
    options.receipts.push(reader.receipt);
    if (!current()) return unavailable('changed');
    for (let index = base.offset; index < Math.min(base.offset + REMOTE_INVENTORY_PAGE_SIZE, ids.length); index++) {
      const head = await reader.head(ids[index]);
      if (!current()) return unavailable('changed');
      const key = hash([selection, index]);
      rows.push(head?.kind === kind ? { key, kind, state: 'recorded', name: display(head.name, 240), revision: head.revision, builtin: head.builtin }
        : { key, kind, state: 'missing', name: null });
    }
    if (!current() || !reader.receipt.current()) return unavailable('changed');
    return { ...base, state: 'recorded', selection, total: ids.length, rows, next: base.offset + rows.length < ids.length ? base.offset + REMOTE_INVENTORY_PAGE_SIZE : null,
      notes: ['Selected configured parts only. Grant-gated skill choices are withheld; implicit, grant-derived and runtime-reported parts are separate.', 'Committed library metadata, observed separately per page. Payload integrity, installation and provider loading are not verified.'] };
  } catch { // telemetry-exempt: no private catalog paths, payloads or error text leave the host.
    return unavailable(current() ? 'unreadable' : 'changed');
  }
}
