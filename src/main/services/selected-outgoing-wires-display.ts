/** One already-admitted selected bucket only. No global binding/source/endpoint lookup. */
import type { RemoteOutgoingWires } from '../../shared/remote-agent-details';
import type { DisplayReceipt } from './display-settings';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { display } from './remote-details-presentation';

export function readSelectedOutgoingWiresForDisplay(selected: string, options: {
  authorized(): boolean; target: DisplayReceipt; receipts: DisplayReceipt[];
}): RemoteOutgoingWires {
  const source = 'selected-outgoing-binding-records' as const;
  const admitted = () => options.authorized() && options.target.current();
  if (!admitted()) return { source, state: 'unavailable', reason: 'changed' };
  try {
    const read = bindingManager.readBindingsForDisplay(selected, { direction: 'outgoing', receipts: options.receipts });
    if (!admitted()) return { source, state: 'unavailable', reason: 'changed' };
    if (read.state !== 'ok') return { source, state: 'unavailable', reason: read.reason ?? 'unreadable' };
    const text = (v: { state: string; value?: string | null }) => v.state === 'ok' && typeof v.value === 'string' && v.value ? v.value : undefined;
    return { source, state: 'recorded', total: read.value.total, omitted: read.value.omitted,
      rows: read.value.rows.map((record) => {
        const name = (record.targetKind === 'group-project' ? text(record.projectName) : undefined) ?? text(record.targetName) ?? text(record.label);
        return { name: name ? display(name, 240) : null, kind: record.targetKind };
      }) };
  } catch { return { source, state: 'unavailable', reason: 'unreadable' }; }
}
