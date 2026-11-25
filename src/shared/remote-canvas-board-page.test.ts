import { describe, expect, it } from 'vitest';
import { isRemoteCanvasBoardPage, isRemoteCanvasBoardQuery, type RemoteCanvasBoardContext, type RemoteCanvasBoardPage } from './remote-canvas-board-page';
import { isRemoteInventoryPage, isRemoteInventoryQuery, isRemoteRowPagedInventoryPage, isRemoteRowPagedInventoryQuery, REMOTE_INVENTORY_SOURCES } from './remote-inventory-page';
import { isRemoteDetailsQuery } from './remote-details-query';
import { isRemoteAgentDetails, REMOTE_DETAILS_CARD_IDS, type RemoteAgentDetails } from './remote-agent-details';
import { isRemoteCanvasMembershipQuery } from './remote-canvas-membership-page';

const member = 'a'.repeat(64), selection = 'b'.repeat(64);
const view = (i: number, extra: Record<string, unknown> = {}) => ({ key: i.toString(16).padStart(64, '0'), type: 'anchor', label: `View ${i}`, member: false, x: i, y: i, w: 10, h: 10, z: i, ...extra });
const page = (patch: Record<string, unknown> = {}, views: unknown[] = [{ ...view(0), key: member, type: 'agent', label: 'Selected', member: true }, view(1)]): RemoteCanvasBoardPage => ({
  version: 1, source: 'selected-canvas-board', agentId: 'a1', projectId: 'p1', member, selection, observedAt: 1, notes: [],
  state: 'recorded', scope: 'project', canvasId: 'board-1', viewId: 'view-1', name: 'Board', views, total: views.length, ...patch } as RemoteCanvasBoardPage);
const context: Required<RemoteCanvasBoardContext> = { agentId: 'a1', projectId: 'p1', member, selection, scope: 'project', canvasId: 'board-1', viewId: 'view-1' };

describe('selected board query', () => {
  it('accepts exactly card, source, member and selection with literal card/source and 64-hex ids', () => {
    expect(isRemoteCanvasBoardQuery({ card: 'canvases', source: 'selected-canvas-board', member, selection })).toBe(true);
    expect(isRemoteDetailsQuery({ card: 'canvases', source: 'selected-canvas-board', member, selection })).toBe(true);
  });
  it.each([
    ['offset', { offset: 0 }], ['projectOffset', { projectOffset: 0 }], ['raw canvasId', { canvasId: 'board-1' }], ['missing member', { member: undefined }],
    ['short member', { member: 'a'.repeat(63) }], ['uppercase selection', { selection: 'B'.repeat(64) }], ['other card', { card: 'actions' }],
  ] as const)('refuses %s', (_label, patch) => {
    const value = Object.fromEntries(Object.entries({ card: 'canvases', source: 'selected-canvas-board', member, selection, ...patch }).filter(([, v]) => v !== undefined));
    expect(isRemoteCanvasBoardQuery(value)).toBe(false); expect(isRemoteDetailsQuery(value)).toBe(false);
  });
  it('is excluded from the row-paged guards, and membership queries refuse the member key', () => {
    const board = { card: 'canvases', source: 'selected-canvas-board', member, selection };
    expect(isRemoteInventoryQuery(board)).toBe(false); expect(isRemoteRowPagedInventoryQuery(board)).toBe(false);
    expect(isRemoteCanvasMembershipQuery({ card: 'canvases', source: 'selected-canvas-memberships', member, selection })).toBe(false);
    expect((REMOTE_INVENTORY_SOURCES as readonly string[]).includes('selected-canvas-board')).toBe(false);
  });
});

describe('selected board page', () => {
  it('accepts a bounded page and its full ownership context', () => {
    expect(isRemoteCanvasBoardPage(page())).toBe(true); expect(isRemoteCanvasBoardPage(page(), context)).toBe(true);
    expect(isRemoteInventoryPage(page())).toBe(true); expect(isRemoteRowPagedInventoryPage(page())).toBe(false);
  });
  it.each(['agentId', 'projectId', 'member', 'selection', 'scope', 'canvasId', 'viewId'] as const)('rejects a page for another %s (wrong board / wrong row)', (field) => {
    const wrong = { ...context, [field]: field === 'scope' ? 'app' : field === 'member' || field === 'selection' ? 'd'.repeat(64) : 'other' };
    expect(isRemoteCanvasBoardPage(page(), wrong)).toBe(false);
  });
  it('rejects wrong focus: a member view whose key is not the row, two members, none, or a non-agent member', () => {
    expect(isRemoteCanvasBoardPage(page({}, [{ ...view(0), type: 'agent', member: true }, view(1)]))).toBe(false);
    expect(isRemoteCanvasBoardPage(page({}, [{ ...view(0), key: member, type: 'agent', member: true }, { ...view(1), type: 'agent', member: true }]))).toBe(false);
    expect(isRemoteCanvasBoardPage(page({}, [view(0), view(1)]))).toBe(false);
    expect(isRemoteCanvasBoardPage(page({}, [{ ...view(0), key: member, member: true }]))).toBe(false);
  });
  it.each([
    ['an extra field', { extra: 1 }], ['a raw agent id field', { agentIds: ['x'] }], ['total mismatch', { total: 3 }], ['unknown state', { state: 'partial' }],
  ] as const)('rejects %s', (_label, patch) => { expect(isRemoteCanvasBoardPage(page(patch))).toBe(false); });
  it('rejects non-finite or negative geometry, duplicate keys, unknown types, content fields and more than 500 views', () => {
    const memberView = { ...view(0), key: member, type: 'agent', label: 'Selected', member: true };
    for (const bad of [{ x: Number.NaN }, { w: -1 }, { type: 'iframe' }, { content: 'note' }, { label: '' }]) expect(isRemoteCanvasBoardPage(page({}, [memberView, view(1, bad)]))).toBe(false);
    expect(isRemoteCanvasBoardPage(page({}, [memberView, view(1), view(1)]))).toBe(false);
    expect(isRemoteCanvasBoardPage(page({}, [memberView, ...Array.from({ length: 500 }, (_, i) => view(i + 1))]))).toBe(false);
    expect(isRemoteCanvasBoardPage(page({}, [memberView, ...Array.from({ length: 499 }, (_, i) => view(i + 1))]))).toBe(true);
  });
  it('accepts an unavailable page with identity only', () => {
    const unavailable = { version: 1, source: 'selected-canvas-board', agentId: 'a1', projectId: 'p1', member, selection, observedAt: 1, notes: [], state: 'unavailable', reason: 'limit' };
    expect(isRemoteCanvasBoardPage(unavailable, context)).toBe(true); expect(isRemoteCanvasBoardPage({ ...unavailable, views: [] })).toBe(false);
  });
});

describe('board page in a Details body', () => {
  const body = (sources: string[], inventoryPage: unknown = page()): RemoteAgentDetails => ({ version: 1, agentId: 'a1', readOnly: true, readAt: 1, providerId: 'claude-code', running: false, status: 'sleeping', spawnedAt: null,
    sessionId: null, nativeSessionId: null, settings: null, inventoryPages: 1, inventorySources: sources, inventoryPageOnly: true, inventoryPage,
    cards: REMOTE_DETAILS_CARD_IDS.map((id) => ({ id, title: id, state: 'ok', summary: '', rows: [], notes: [], omitted: 0, observedAt: 1, ...(id !== 'canvases' && { requested: false }) })) } as unknown as RemoteAgentDetails);
  it('is admitted only when the advertised sources include memberships (the board is never advertised)', () => {
    expect(isRemoteAgentDetails(body(['selected-action-relationships', 'selected-canvas-memberships']), 'a1')).toBe(true);
    expect(isRemoteAgentDetails(body(['selected-action-relationships']), 'a1')).toBe(false);
    expect(isRemoteAgentDetails(body(['selected-action-relationships', 'selected-canvas-memberships', 'selected-canvas-board']), 'a1')).toBe(false);
  });
  it('binds the page agent to the Details agent and maps it to the canvases card', () => {
    expect(isRemoteAgentDetails(body(['selected-canvas-memberships'], page({ agentId: 'other' })), 'a1')).toBe(false);
    const wrongCard = body(['selected-canvas-memberships']); wrongCard.cards = wrongCard.cards.map((c) => c.id === 'canvases' ? { ...c, requested: false } : c.id === 'skills-mcp' ? { ...c, requested: undefined } : c) as never;
    expect(isRemoteAgentDetails(wrongCard, 'a1')).toBe(false);
  });
});
