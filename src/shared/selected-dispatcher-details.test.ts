import { describe, expect, it } from 'vitest';
import { isRemoteAgentDetails, REMOTE_DETAILS_MAX_BYTES, REMOTE_DETAILS_CARD_IDS } from './remote-agent-details';
import { isSelectedDispatcherActionsPage, isSelectedDispatcherActionsQuery, isSelectedDispatcherConnectionPage, isSelectedDispatcherDetails, isSelectedDispatcherPage, isSelectedDispatcherPageQuery, type SelectedDispatcherDetails } from './selected-dispatcher-details';

const roleFixture = (): SelectedDispatcherDetails => ({ version: 1, role: 'dispatcher', agentId: 'role1', details: {
  version: 1, agentId: 'role1', readOnly: true, readAt: 1, providerId: 'claude-code', running: false, status: 'sleeping', spawnedAt: null, sessionId: null, nativeSessionId: null,
  settings: null, cards: REMOTE_DETAILS_CARD_IDS.map((id) => ({ id, title: id, state: 'ok', summary: '', rows: [], notes: [], omitted: 0, observedAt: 1 })),
} });

describe('selected Dispatcher full wrapper validation', () => {
  it('accepts only a matching whole role Details response', () => { expect(isSelectedDispatcherDetails(roleFixture())).toBe(true); });
  it.each([
    { role: 'controller' }, { role: 'agent' }, { version: 2 }, { agentId: 'other' }, { agentId: '' }, { receipt: {} }, { machine: 'other' },
  ])('rejects a wrong binding or private/additional wrapper field %j', (patch) => {
    expect(isSelectedDispatcherDetails({ ...roleFixture(), ...patch })).toBe(false);
  });
  it.each(['helperPageOnly', 'connectionPageOnly', 'inventoryPageOnly'])('rejects partial page kind %s', (kind) => {
    const value = roleFixture();
    Object.assign(value.details, { [kind]: true });
    expect(isSelectedDispatcherDetails(value)).toBe(false);
  });
  it('rejects a malformed inventory partial injection at both the Details validator and the role wrapper', () => {
    // The selected inventory validator now rejects inventoryPageOnly without a page; the wrapper must reject it independently.
    const value = roleFixture(); Object.assign(value.details, { inventoryPageOnly: true });
    expect(isRemoteAgentDetails(value.details, value.agentId)).toBe(false);
    expect(isSelectedDispatcherDetails(value)).toBe(false);
  });
  it('enforces the full UTF-8 wrapper bound, even when character count is below the byte limit', () => {
    const value = roleFixture();
    value.details.cards[0].rows = Array.from({ length: 100 }, () => ({ label: '中'.repeat(512), value: '中'.repeat(512) }));
    expect(isRemoteAgentDetails(value.details, value.agentId)).toBe(true);
    expect(JSON.stringify(value).length).toBeLessThan(REMOTE_DETAILS_MAX_BYTES);
    expect(isSelectedDispatcherDetails(value)).toBe(false);
  });
  it('rejects settings identity substitution and malformed nested Details', () => {
    const value = roleFixture(); Object.assign(value.details, { settings: { version: 1, agentId: 'other', readOnly: true, provider: 'CLI', model: 'model', runtime: 'chat', access: 'Ask first', executionPolicy: 'defaults', autoSleep: null, context: null, setup: { state: 'ok', managed: false, template: null, instructions: 'None', skills: null, mcps: null } } });
    expect(isSelectedDispatcherDetails(value)).toBe(false);
    expect(isSelectedDispatcherDetails({ ...roleFixture(), details: null })).toBe(false);
  });
});

describe('selected Dispatcher Connections page validation', () => {
  const query = { card: 'connections' as const, source: 'outgoing' as const, offset: 25, projectOffset: 0 };
  const page = (patch: Record<string, unknown> = {}, pagePatch: Record<string, unknown> = {}) => {
    const value = roleFixture();
    Object.assign(value.details, { connectionPageEnvelope: 1, connectionPageOnly: true, connectionPages: 1 }, patch);
    value.details.cards = value.details.cards.map((c) => c.id === 'connections' ? { ...c, connectionPage: { source: 'outgoing', offset: 25, projectOffset: 0, next: null, known: 1, complete: true, ...pagePatch } } : { ...c, requested: false }) as never;
    return value;
  };
  it('accepts only the requested page of the bound role', () => {
    expect(isSelectedDispatcherConnectionPage(page(), query)).toBe(true);
    expect(isSelectedDispatcherDetails(page())).toBe(false);
  });
  it.each([
    ['another source', {}, { source: 'incoming' }], ['another offset', {}, { offset: 0 }], ['another project offset', {}, { projectOffset: 25 }],
    ['a whole read', { connectionPageOnly: undefined, connectionPageEnvelope: undefined }, {}], ['a helper page', { helperPageOnly: true }, {}],
  ] as const)('rejects %s', (_label, patch, pagePatch) => {
    expect(isSelectedDispatcherConnectionPage(page(patch, pagePatch), query)).toBe(false);
  });
  it('rejects extra wrapper fields, other cards and malformed queries', () => {
    expect(isSelectedDispatcherConnectionPage({ ...page(), receipt: {} }, query)).toBe(false);
    expect(isSelectedDispatcherConnectionPage(page(), { ...query, card: 'orchestrate' } as never)).toBe(false);
    expect(isSelectedDispatcherConnectionPage(page(), { card: 'actions', source: 'selected-action-relationships' } as never)).toBe(false);
  });
});

describe('selected Dispatcher Actions page validation (#14)', () => {
  const selection = 'a'.repeat(64), query = { card: 'actions' as const, source: 'selected-action-relationships' as const, offset: 25, selection };
  const row = (i: number) => ({ key: i.toString(16).padStart(64, '0'), name: `Made ${i}`, group: 'dispatcher', enabled: false, description: 'Once → Message Dispatcher' });
  const page = (patch: Record<string, unknown> = {}, pagePatch: Record<string, unknown> = {}) => {
    const value = roleFixture();
    Object.assign(value.details, { inventoryPages: 1, inventorySources: ['selected-action-relationships'], inventoryPageOnly: true,
      inventoryPage: { version: 1, source: 'selected-action-relationships', state: 'recorded', offset: 25, selection, next: null, totalRelationships: 30, uniqueActions: 30, rows: [25, 26, 27, 28, 29].map(row), observedAt: 1, notes: [], ...pagePatch } }, patch);
    value.details.cards = value.details.cards.map((c) => ({ ...c, summary: '', ...(c.id !== 'actions' && { requested: false }) })) as never;
    return value;
  };
  it('accepts only the requested Actions page of the bound role, never as a whole read or a Connections page', () => {
    expect(isRemoteAgentDetails(page().details, 'role1')).toBe(true);
    expect(isSelectedDispatcherActionsPage(page(), query)).toBe(true); expect(isSelectedDispatcherPage(page(), query)).toBe(true);
    expect(isSelectedDispatcherDetails(page())).toBe(false);
    expect(isSelectedDispatcherConnectionPage(page(), { card: 'connections', source: 'outgoing', offset: 25, projectOffset: 0 })).toBe(false);
  });
  it.each([
    ['another offset', {}, { offset: 0, next: 25 }], ['another selection', {}, { selection: 'b'.repeat(64) }], ['a whole read', { inventoryPageOnly: undefined, inventoryPage: undefined }, {}],
    ['a connection page flag', { connectionPageOnly: true }, {}], ['a helper page flag', { helperPageOnly: true }, {}], ['a malformed row set', {}, { rows: [] }],
  ] as const)('rejects %s', (_label, patch, pagePatch) => {
    expect(isSelectedDispatcherActionsPage(page(patch, pagePatch), query)).toBe(false);
  });
  it('binds selection only when the query carries one, and accepts an unavailable page at the asked offset', () => {
    expect(isSelectedDispatcherActionsPage(page({}, { offset: 0, next: 25, totalRelationships: 30, rows: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24].map(row) }), { card: 'actions', source: 'selected-action-relationships' })).toBe(true);
    const unavailable = page({}, {}); unavailable.details.inventoryPage = { version: 1, source: 'selected-action-relationships', state: 'unavailable', offset: 25, reason: 'changed', observedAt: 1, notes: [] };
    expect(isSelectedDispatcherActionsPage(unavailable, query)).toBe(true);
  });
  it('rejects extra wrapper fields, another role agent, a page over the byte cap and malformed queries', () => {
    expect(isSelectedDispatcherActionsPage({ ...page(), receipt: {} }, query)).toBe(false);
    expect(isSelectedDispatcherActionsPage({ ...page(), agentId: 'other' }, query)).toBe(false);
    // 25 rows of 2048 lone surrogates serialize to about 307 KB: valid text, over the 256 KiB wrapper cap.
    const big = page({}, { offset: 0, next: 25, rows: Array.from({ length: 25 }, (_, i) => ({ ...row(i), description: '\ud800'.repeat(2048) })) });
    expect(isRemoteAgentDetails(big.details, 'role1')).toBe(true); expect(isSelectedDispatcherActionsPage(big, { ...query, offset: 0 })).toBe(false);
    for (const bad of [{ ...query, projectOffset: 0 }, { ...query, selection: undefined }, { ...query, offset: 30 }, { ...query, selection: 'XYZ' }, { card: 'canvases', source: 'selected-canvas-memberships' }, { card: 'actions', source: 'selected-managed-skills' }]) {
      expect(isSelectedDispatcherActionsQuery(bad)).toBe(false); expect(isSelectedDispatcherPageQuery(bad)).toBe(false);
    }
    expect(isSelectedDispatcherPageQuery({ card: 'connections', source: 'outgoing' })).toBe(true); expect(isSelectedDispatcherPageQuery(query)).toBe(true);
  });
});
