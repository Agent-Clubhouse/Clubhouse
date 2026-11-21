/** One selected, membership-bound saved board, redacted to layout and labels. Never navigation, hydration or a write. */
import { REMOTE_CANVAS_MEMBERSHIP_SOURCE } from './remote-canvas-membership-page';

export const REMOTE_CANVAS_BOARD_SOURCE = 'selected-canvas-board' as const;
export const REMOTE_CANVAS_BOARD_MAX_VIEWS = 500;
export const REMOTE_CANVAS_BOARD_VIEW_TYPES = ['agent', 'anchor', 'plugin', 'sticky-note', 'zone'] as const;
/** Names one row of a current membership page by its opaque key and that page's selection. No raw ids. */
export interface RemoteCanvasBoardQuery { card: 'canvases'; source: typeof REMOTE_CANVAS_BOARD_SOURCE; member: string; selection: string }
export interface RemoteCanvasBoardView {
  /** The member view's key is the membership row key; other keys are opaque and never derived by clients. */
  key: string; type: typeof REMOTE_CANVAS_BOARD_VIEW_TYPES[number]; label: string; member: boolean;
  x: number; y: number; w: number; h: number; z: number;
}
export type RemoteCanvasBoardPage = { version: 1; source: typeof REMOTE_CANVAS_BOARD_SOURCE; agentId: string; projectId: string; member: string; selection: string; observedAt: number; notes: string[] } & (
  | { state: 'unavailable'; reason: 'changed' | 'invalid' | 'unreadable' | 'limit' | 'unsupported' }
  | { state: 'recorded'; scope: 'app' | 'project'; canvasId: string; viewId: string; name: string; views: RemoteCanvasBoardView[]; total: number }
);
/** What the requester already holds from the membership page row it asked about. */
export interface RemoteCanvasBoardContext { agentId: string; projectId: string; member: string; selection: string; scope?: 'app' | 'project'; canvasId?: string; viewId?: string }

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: object, allowed: string[]) => Object.keys(v).every((key) => allowed.includes(key));
const text = (v: unknown, max = 240): v is string => typeof v === 'string' && !!v && v.length <= max && Array.from(v).every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const REASONS = ['changed', 'invalid', 'unreadable', 'limit', 'unsupported'];

/** Exactly card, source, member and selection: membership paging keys (offset) are refused. */
export function isRemoteCanvasBoardQuery(value: unknown): value is RemoteCanvasBoardQuery {
  return record(value) && keys(value, ['card', 'source', 'member', 'selection']) && value.card === 'canvases' && value.source === REMOTE_CANVAS_BOARD_SOURCE
    && hash(value.member) && hash(value.selection);
}

/** Shape, bounds and, when given, the requester's ownership context (agent, project, row, selection and board). */
export function isRemoteCanvasBoardPage(value: unknown, context?: RemoteCanvasBoardContext): value is RemoteCanvasBoardPage {
  if (!record(value) || value.version !== 1 || value.source !== REMOTE_CANVAS_BOARD_SOURCE || !text(value.agentId) || !text(value.projectId)
    || !hash(value.member) || !hash(value.selection) || !finite(value.observedAt) || value.observedAt <= 0
    || !Array.isArray(value.notes) || value.notes.length > 10 || !value.notes.every((note) => text(note, 2048))) return false;
  if (context && (value.agentId !== context.agentId || value.projectId !== context.projectId || value.member !== context.member || value.selection !== context.selection)) return false;
  const common = ['version', 'source', 'agentId', 'projectId', 'member', 'selection', 'observedAt', 'notes', 'state'];
  if (value.state === 'unavailable') return keys(value, [...common, 'reason']) && REASONS.includes(String(value.reason));
  if (value.state !== 'recorded' || !keys(value, [...common, 'scope', 'canvasId', 'viewId', 'name', 'views', 'total'])
    || !['app', 'project'].includes(String(value.scope)) || !text(value.canvasId, 200) || !text(value.viewId, 200) || !text(value.name)
    || !Number.isSafeInteger(value.total) || !Array.isArray(value.views) || value.views.length !== value.total || value.views.length > REMOTE_CANVAS_BOARD_MAX_VIEWS) return false;
  if (context && (context.scope !== undefined && value.scope !== context.scope || context.canvasId !== undefined && value.canvasId !== context.canvasId
    || context.viewId !== undefined && value.viewId !== context.viewId)) return false;
  const views = value.views as unknown[];
  if (!views.every((v) => record(v) && keys(v, ['key', 'type', 'label', 'member', 'x', 'y', 'w', 'h', 'z']) && hash(v.key)
    && (REMOTE_CANVAS_BOARD_VIEW_TYPES as readonly string[]).includes(String(v.type)) && text(v.label) && typeof v.member === 'boolean'
    && finite(v.x) && finite(v.y) && finite(v.w) && finite(v.h) && finite(v.z) && v.w >= 0 && v.h >= 0)) return false;
  const list = views as RemoteCanvasBoardView[];
  if (new Set(list.map((v) => v.key)).size !== list.length) return false;
  const members = list.filter((v) => v.member);
  return members.length === 1 && members[0].key === value.member && members[0].type === 'agent';
}

/** The board source is never advertised; it rides on the advertised membership source (mixed-version safety). */
export const boardSourceAdmitted = (inventorySources: readonly string[] | undefined) => !!inventorySources?.includes(REMOTE_CANVAS_MEMBERSHIP_SOURCE);
