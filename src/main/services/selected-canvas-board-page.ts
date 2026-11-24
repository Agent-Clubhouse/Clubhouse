/** One selected, membership-bound saved board from the same passive primary read as memberships. No recovery, content or write. */
import { createHash } from 'crypto';
import { REMOVED_CANVAS_VIEW_TYPES } from '../../shared/canvas-persistence';
import { isRemoteCanvasBoardQuery, REMOTE_CANVAS_BOARD_MAX_VIEWS, REMOTE_CANVAS_BOARD_SOURCE, REMOTE_CANVAS_BOARD_VIEW_TYPES, type RemoteCanvasBoardPage, type RemoteCanvasBoardQuery, type RemoteCanvasBoardView } from '../../shared/remote-canvas-board-page';
import type { AgentConfigTarget } from './agent-config-reader';
import type { DisplayReceipt } from './display-settings';
import { display } from './remote-details-presentation';
import { collectSelectedCanvasMemberships } from './selected-canvas-membership-page';

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const label = (v: unknown, fallback: string) => display(typeof v === 'string' && v.trim() ? v : fallback, 240);
const FALLBACK: Record<RemoteCanvasBoardView['type'], string> = { agent: 'Agent', anchor: 'Anchor', plugin: 'Plugin widget', 'sticky-note': 'Sticky note', zone: 'Zone' };
class InvalidBoard extends Error {}

export async function readSelectedCanvasBoardPage(target: AgentConfigTarget, query: RemoteCanvasBoardQuery, options: {
  authorized(): boolean; target: DisplayReceipt; receipts: DisplayReceipt[];
}): Promise<RemoteCanvasBoardPage> {
  if (!isRemoteCanvasBoardQuery(query)) throw new Error('Invalid selected board query.');
  const member = query.member, selection = query.selection;
  const base = { version: 1 as const, source: REMOTE_CANVAS_BOARD_SOURCE, agentId: target.agent.id, projectId: target.project.id, member, selection, observedAt: Date.now(),
    notes: ['Saved layout and labels of one board that contains the selected agent. Board content, other agents’ names and other boards are not shared.',
      'A separate host observation of saved primary files, not the live canvas. It is not editable here.'] };
  const unavailable = (reason: Extract<RemoteCanvasBoardPage, { state: 'unavailable' }>['reason']): RemoteCanvasBoardPage => ({ ...base, state: 'unavailable', reason });
  const collected = await collectSelectedCanvasMemberships(target, options);
  if (collected.state === 'unavailable') return unavailable(collected.reason);
  const row = collected.selection === selection ? collected.rows.find((r) => r.key === member) : undefined;
  if (!row) return unavailable('changed');
  const board = collected.stores.find((store) => store.scope === row.scope)?.raw.find((b) => record(b) && b.id === row.canvasId);
  if (!record(board) || !Array.isArray(board.views)) return unavailable('changed');
  try {
    // Only the view types the page contract knows; any other (future) type is left out rather than failing the page.
    // The shared membership walk currently refuses unknown types first, so this is defense in depth.
    const shown = board.views.filter((v) => record(v) && typeof v.type === 'string' && !REMOVED_CANVAS_VIEW_TYPES.has(v.type)
      && (REMOTE_CANVAS_BOARD_VIEW_TYPES as readonly string[]).includes(v.type)) as Array<Record<string, unknown>>;
    if (shown.length > REMOTE_CANVAS_BOARD_MAX_VIEWS) return unavailable('limit');
    const views = shown.map((v): RemoteCanvasBoardView => {
      const type = v.type as RemoteCanvasBoardView['type'], isMember = v.id === row.viewId;
      const position = record(v.position) ? v.position : {}, size = record(v.size) ? v.size : {};
      const geometry = [position.x, position.y, size.width, size.height, v.zIndex ?? 0];
      if (!geometry.every((n) => typeof n === 'number' && Number.isFinite(n)) || Number(size.width) < 0 || Number(size.height) < 0) throw new InvalidBoard();
      // Only the member view is named (the selected agent, already in this Details body). Other agents stay generic.
      const text = isMember ? label(target.agent.name, 'Agent') : type === 'agent' ? 'Agent'
        : type === 'anchor' ? label(v.label ?? v.displayName ?? v.title, FALLBACK.anchor) : label(v.displayName ?? v.title, FALLBACK[type]);
      return { key: isMember ? member : hash([member, v.id]), type, label: text, member: isMember,
        x: position.x as number, y: position.y as number, w: size.width as number, h: size.height as number, z: (v.zIndex ?? 0) as number };
    });
    if (views.filter((v) => v.member).length !== 1) return unavailable('changed');
    return { ...base, state: 'recorded', scope: row.scope, canvasId: row.canvasId, viewId: row.viewId, name: label(board.name, 'Board name not recorded'), views, total: views.length };
  } catch { // telemetry-exempt: closed source status only; no board content or raw errors leave the host
    return unavailable('invalid');
  }
}

/** Premeasure against what remains of the response budget: an oversized board is unavailable, never a failed read. */
export function fitSelectedCanvasBoardPage(page: RemoteCanvasBoardPage, remaining: number): RemoteCanvasBoardPage {
  if (Buffer.byteLength(JSON.stringify(page)) <= remaining) return page;
  const { version, source, agentId, projectId, member, selection, observedAt, notes } = page;
  return { version, source, agentId, projectId, member, selection, observedAt, notes, state: 'unavailable', reason: 'limit' };
}
