import { describe, expect, it } from 'vitest';
import { isRemoteAgentDetails, REMOTE_DETAILS_MAX_BYTES, REMOTE_DETAILS_CARD_IDS } from './remote-agent-details';
import { isSelectedDispatcherDetails, type SelectedDispatcherDetails } from './selected-dispatcher-details';

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
  it('explicitly rejects a malformed managed inventory partial injection accepted as an unknown additive field by the old Details validator', () => {
    const value = roleFixture(); Object.assign(value.details, { inventoryPageOnly: true });
    expect(isRemoteAgentDetails(value.details, value.agentId)).toBe(true);
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
