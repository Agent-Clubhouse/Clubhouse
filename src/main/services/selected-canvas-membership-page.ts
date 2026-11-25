/** Fixed Home + admitted selected-project primary files. No board payload export or root scan. */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { REMOVED_CANVAS_VIEW_TYPES } from '../../shared/canvas-persistence';
import { DISPATCHER_PROJECT_ID } from '../../shared/dispatcher-types';
import { isDisposedAgent } from '../../shared/agent-helpers';
import { isRemoteCanvasMembershipQuery, REMOTE_CANVAS_MEMBERSHIP_MAX_ITEMS, REMOTE_CANVAS_MEMBERSHIP_PAGE_SIZE, REMOTE_CANVAS_MEMBERSHIP_SOURCE, type RemoteCanvasMembershipPage, type RemoteCanvasMembershipQuery, type RemoteCanvasMembershipRow } from '../../shared/remote-canvas-membership-page';
import type { AgentConfigTarget } from './agent-config-reader';
import type { DisplayReceipt } from './display-settings';
import { createReadOnlyMetadataBudget, readReadOnlyConnectionSourceMetadata, ReadOnlyMetadataLimitError, type ReadOnlyConnectionSourceMetadata } from './read-only-agent-target-witness';
import { isDispatcherIdentityAgentId } from './dispatcher/dispatcher-service';
import { display } from './remote-details-presentation';

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 200 && display(v, 240) === v;
class InvalidMembership extends Error {}
class MembershipLimit extends Error {}
const current = (receipt: DisplayReceipt) => { try { return receipt.current(); } catch { return false; /* telemetry-exempt: failed source/target receipt withholds the metadata page */ } };

/** Missing primary is not empty when any recovery key exists. Stat only: never
 * open backup contents, including empty, malformed or linked recovery files. */
function missingRecoveryReceipt(root: string, prefix: string, primary: DisplayReceipt): DisplayReceipt {
  const check = () => {
    if (!current(primary)) return false;
    for (const name of ['canvas-instances-backup.json', 'canvas-instances-backup.json.bak']) {
      try { fs.lstatSync(path.join(root, prefix, name)); return false; }
      catch (error) { // telemetry-exempt: absence is expected; any other metadata failure withholds the page
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      }
    }
    return current(primary);
  };
  if (!check()) throw new Error('Canvas recovery state unavailable.');
  return { current: check };
}

export type SelectedCanvasMemberships = { state: 'recorded'; rows: RemoteCanvasMembershipRow[]; selection: string; stores: Array<{ scope: 'app' | 'project'; raw: unknown[] }> }
  | { state: 'unavailable'; reason: Extract<RemoteCanvasMembershipPage, { state: 'unavailable' }>['reason'] };

/** One passive observation of the Home and selected-project primaries: memberships, their selection and the parsed stores. */
export async function collectSelectedCanvasMemberships(target: AgentConfigTarget, options: {
  authorized(): boolean; target: DisplayReceipt; receipts: DisplayReceipt[];
}): Promise<SelectedCanvasMemberships> {
  const unavailable = (reason: Extract<SelectedCanvasMemberships, { state: 'unavailable' }>['reason']): SelectedCanvasMemberships => ({ state: 'unavailable', reason });
  const admitted = () => options.authorized() && current(options.target);
  if (!admitted()) return unavailable('changed');
  if (target.project.id === DISPATCHER_PROJECT_ID || isDispatcherIdentityAgentId(target.agent.id) || isDisposedAgent(target.agent)) return unavailable('unsupported');
  const home = app.getPath('home'), firstReceipt = options.receipts.length;
  options.receipts.push({ current: () => app.getPath('home') === home });
  const stores = [
    { scope: 'app' as const, root: home, prefix: '.clubhouse/plugin-data/canvas/kv/' },
    { scope: 'project' as const, root: target.project.path, prefix: '.clubhouse/plugin-data-local/canvas/kv/' },
  ];
  const budget = createReadOnlyMetadataBudget(), rows: RemoteCanvasMembershipRow[] = [], parsed: Array<{ scope: 'app' | 'project'; raw: unknown[] }> = [];
  let visits = 0;
  try {
    for (const store of stores) {
      if (!admitted()) return unavailable('changed');
      const source = readReadOnlyConnectionSourceMetadata(store.root, (store.prefix + 'canvas-instances.json') as ReadOnlyConnectionSourceMetadata, { budget });
      options.receipts.push(source.receipt);
      if (source.missing) { options.receipts.push(missingRecoveryReceipt(store.root, store.prefix, source.receipt)); continue; }
      if (!Array.isArray(source.raw) || !source.raw.length) throw new InvalidMembership();
      parsed.push({ scope: store.scope, raw: source.raw });
      const boards = new Set<string>(), views = new Set<string>();
      for (const board of source.raw) {
        if (++visits > REMOTE_CANVAS_MEMBERSHIP_MAX_ITEMS) throw new MembershipLimit();
        if (!record(board) || !id(board.id) || boards.has(board.id) || !Array.isArray(board.views)) throw new InvalidMembership();
        boards.add(board.id);
        for (const view of board.views) {
          if (++visits > REMOTE_CANVAS_MEMBERSHIP_MAX_ITEMS) throw new MembershipLimit();
          if (!record(view) || !id(view.id) || views.has(view.id) || typeof view.type !== 'string') throw new InvalidMembership();
          views.add(view.id);
          if (REMOVED_CANVAS_VIEW_TYPES.has(view.type)) continue;
          if (!['agent', 'anchor', 'plugin', 'sticky-note', 'zone'].includes(view.type)) throw new InvalidMembership();
          if (view.type !== 'agent') continue;
          if (view.agentId !== null && !id(view.agentId) || view.projectId !== undefined && !id(view.projectId)) throw new InvalidMembership();
          if (view.agentId !== target.agent.id) continue;
          if (store.scope === 'app' && view.projectId === undefined) throw new InvalidMembership();
          if (view.projectId !== undefined && view.projectId !== target.project.id) continue;
          rows.push({ key: hash([target.agent.id, target.project.id, store.scope, board.id, view.id]),
            scope: store.scope, canvasId: board.id, viewId: view.id, name: display(typeof board.name === 'string' && board.name ? board.name : 'Board name not recorded', 240) });
        }
      }
    }
    const receipts = [...options.receipts.slice(firstReceipt)];
    const combined = { current: () => admitted() && receipts.every(current) };
    options.receipts.push(combined);
    if (!combined.current()) return unavailable('changed');
    rows.sort((a, b) => { const left = JSON.stringify([a.scope, a.canvasId, a.viewId]), right = JSON.stringify([b.scope, b.canvasId, b.viewId]); return left < right ? -1 : left > right ? 1 : 0; });
    return { state: 'recorded', rows, selection: hash([target.agent.id, target.project.id, target.project.path, home, rows]), stores: parsed };
  } catch (error) { // telemetry-exempt: closed source status only; no paths, recovery data or raw errors leave the host
    return unavailable(!admitted() ? 'changed' : error instanceof ReadOnlyMetadataLimitError || error instanceof MembershipLimit ? 'limit' : error instanceof InvalidMembership ? 'invalid' : 'unreadable');
  }
}

export async function readSelectedCanvasMembershipPage(target: AgentConfigTarget, query: RemoteCanvasMembershipQuery, options: {
  authorized(): boolean; target: DisplayReceipt; receipts: DisplayReceipt[];
}): Promise<RemoteCanvasMembershipPage> {
  if (!isRemoteCanvasMembershipQuery(query)) throw new Error('Invalid selected Canvas query.');
  const base = { version: 1 as const, source: REMOTE_CANVAS_MEMBERSHIP_SOURCE, agentId: target.agent.id, projectId: target.project.id, offset: query.offset ?? 0, observedAt: Date.now(), notes: [] as string[] };
  const unavailable = (reason: Extract<RemoteCanvasMembershipPage, { state: 'unavailable' }>['reason']): RemoteCanvasMembershipPage => ({ ...base, state: 'unavailable', reason });
  const collected = await collectSelectedCanvasMemberships(target, options);
  if (collected.state === 'unavailable') return unavailable(collected.reason);
  const { rows, selection } = collected;
  if (query.selection && query.selection !== selection || base.offset !== 0 && base.offset >= rows.length) return unavailable('changed');
  return { ...base, state: 'recorded', selection, rows: rows.slice(base.offset, base.offset + REMOTE_CANVAS_MEMBERSHIP_PAGE_SIZE), total: rows.length,
    next: base.offset + REMOTE_CANVAS_MEMBERSHIP_PAGE_SIZE < rows.length ? base.offset + REMOTE_CANVAS_MEMBERSHIP_PAGE_SIZE : null,
    notes: ['Saved Home and selected-project membership metadata only. Live unsaved membership is not inspected; board contents are not shared.', 'Every page is a separate primary-file observation. Membership alone does not authorize opening an omitted board.'] };
}
