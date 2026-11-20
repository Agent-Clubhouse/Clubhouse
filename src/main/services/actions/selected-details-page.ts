/** Existing in-memory engine only. No init, execution, receipt refresh or history API. */
import { createHash } from 'crypto';
import { agentActionGroups, ACTION_OUTCOMES, isActionRunTime } from '../../../shared/agent-action-groups';
import { describeAction, type ActionNames, type Action } from '../../../shared/actions';
import { REMOTE_ACTION_PAGE_SIZE, REMOTE_ACTION_PAGE_SOURCE, REMOTE_ACTION_RELATIONSHIP_LIMIT, type RemoteActionRelationshipPage, type RemoteActionRelationshipRow } from '../../../shared/remote-action-page';
import type { DisplayReceipt } from '../display-settings';
import type { ActionsEngine } from './engine';
import { display } from '../remote-details-presentation';
export interface SelectedActionSubject { agentId: string; projectId?: string; dispatcher: boolean }
export interface SelectedActionPageOptions {
  offset: number; selection?: string;
  authorized(): boolean;
  target: DisplayReceipt;
  receipts: DisplayReceipt[];
  /** A fresh passive display-name resolver per observation; no probes or mutable loaders. */
  names(): ActionNames;
  /** Captured existing engine identity only, not a getter that initializes it. */
  sourceCurrent(): boolean;
}
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 240;
export function unavailableActionRelationshipPage(offset: number, reason: Extract<RemoteActionRelationshipPage, { state: 'unavailable' }>['reason']): RemoteActionRelationshipPage {
  return { version: 1, source: REMOTE_ACTION_PAGE_SOURCE, state: 'unavailable', offset: Number.isSafeInteger(offset) && offset >= 0 && offset <= REMOTE_ACTION_RELATIONSHIP_LIMIT && offset % REMOTE_ACTION_PAGE_SIZE === 0 ? offset : 0, reason, observedAt: Date.now(), notes: ['Selected recorded Actions are unavailable; an empty relationship list is not inferred.'] };
}
export function readSelectedActionRelationshipPage(engine: Pick<ActionsEngine, 'list' | 'lastRunForDisplay'>, input: SelectedActionSubject, options: SelectedActionPageOptions): RemoteActionRelationshipPage {
  // Capture scalar arguments before any caller-owned authority/name callbacks.
  const subject = { agentId: input?.agentId, projectId: input?.projectId, dispatcher: input?.dispatcher }, offset = options.offset, expectedSelection = options.selection;
  const authorized = options.authorized, target = options.target, sourceCurrent = options.sourceCurrent, names = options.names, receipts = options.receipts;
  const unavailable = (reason: Extract<RemoteActionRelationshipPage, { state: 'unavailable' }>['reason']) => unavailableActionRelationshipPage(offset, reason);
  const admitted = () => {
    try { return authorized() && target.current() && sourceCurrent(); }
    catch { // telemetry-exempt: failed private admission withholds this source.
      return false;
    }
  };
  if (!admitted()) return unavailable('changed');
  if (!id(subject.agentId) || typeof subject.dispatcher !== 'boolean' || !subject.dispatcher && !id(subject.projectId) || subject.projectId !== undefined && !id(subject.projectId)
    || !Number.isSafeInteger(offset) || offset < 0 || offset > REMOTE_ACTION_RELATIONSHIP_LIMIT || offset % REMOTE_ACTION_PAGE_SIZE
    || expectedSelection !== undefined && !/^[a-f0-9]{64}$/.test(expectedSelection) || offset > 0 && !expectedSelection || !Array.isArray(receipts)) return unavailable('invalid');
  const snapshot = (): { selection: string; totalRelationships: number; uniqueActions: number; rows: RemoteActionRelationshipRow[] } | 'invalid' | 'limit' | 'changed' => {
    const all = engine.list();
    if (!Array.isArray(all)) return 'invalid';
    if (all.length > REMOTE_ACTION_RELATIONSHIP_LIMIT) return 'limit';
    const seen = new Set<string>();
    for (const a of all) {
      if (!a || !id(a.id) || seen.has(a.id) || typeof a.enabled !== 'boolean' || !Number.isSafeInteger(a.createdAt) || a.createdAt < 0) return 'invalid';
      seen.add(a.id);
    }
    const visible = all.filter((a) => a.owner.kind !== 'app').sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const grouped = agentActionGroups(visible, subject.agentId, subject.projectId);
    const groups = subject.dispatcher ? [{ group: 'dispatcher' as const, list: visible.filter((a) => a.owner.kind === 'dispatcher') }]
      : [{ group: 'owned' as const, list: grouped.owned }, { group: 'targeting' as const, list: grouped.targeting }, { group: 'triggered-by' as const, list: grouped.triggeredBy }];
    const related: Array<{ group: RemoteActionRelationshipRow['group']; action: Action }> = groups.flatMap(({ group, list }) => list.map((action) => ({ group, action })));
    if (related.length > REMOTE_ACTION_RELATIONSHIP_LIMIT) return 'limit';
    const selection = hash([subject, related.map((r) => [r.action.id, r.group])]);
    if (expectedSelection !== undefined && expectedSelection !== selection || offset > 0 && offset >= related.length) return 'changed';
    const resolver = names(), runs = new Map<string, ReturnType<ActionsEngine['lastRunForDisplay']>>();
    const rows = related.slice(offset, offset + REMOTE_ACTION_PAGE_SIZE).map(({ action, group }) => {
      if (!runs.has(action.id)) runs.set(action.id, engine.lastRunForDisplay(action.id));
      const last = runs.get(action.id);
      return { key: hash([subject, action.id, group]), name: display(typeof action.name === 'string' && action.name ? action.name : 'Action name unavailable', 240), group,
        enabled: action.enabled === true, description: display(describeAction(action, resolver)),
        ...(last && ACTION_OUTCOMES.includes(last.outcome) && { lastRun: { outcome: last.outcome, ...(isActionRunTime(last.startedAt) && { startedAt: last.startedAt }) } }) };
    });
    return { selection, totalRelationships: related.length, uniqueActions: new Set(related.map((r) => r.action.id)).size, rows };
  };
  try {
    const value = snapshot(); if (typeof value === 'string') return unavailable(value);
    if (!admitted()) return unavailable('changed');
    const signature = hash(value);
    receipts.push({ current: () => {
      try { return admitted() && hash(snapshot()) === signature && admitted(); }
      catch { // telemetry-exempt: changed/unreadable private receipt prevents serialization.
        return false;
      }
    } });
    return { version: 1, source: REMOTE_ACTION_PAGE_SOURCE, state: 'recorded', offset, ...value, next: offset + REMOTE_ACTION_PAGE_SIZE < value.totalRelationships ? offset + REMOTE_ACTION_PAGE_SIZE : null,
      observedAt: Date.now(), notes: ['Relationship rows are grouped by owner, target and trigger, ordered by saved creation time and stable identity. One Action may appear in multiple groups.',
        'Descriptions and last-run outcome/time use recorded host display fields. They do not confirm execution, delivery or current tool authority.'] };
  } catch { // telemetry-exempt: no raw Action definitions or engine errors cross this display boundary.
    return unavailable('unreadable');
  }
}
