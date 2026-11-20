import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { readSelectedOutgoingWiresForDisplay } from './selected-outgoing-wires-display';
import { isRemoteOutgoingWires, REMOTE_OUTGOING_WIRE_KINDS } from '../../shared/remote-agent-details';
import type { DisplayReceipt } from './display-settings';

beforeEach(() => { bindingManager._resetForTesting(); bindingManager.setConnectionToolsSource(null, null); bindingManager.setConnectionInstructionsSource(null); });
afterEach(() => { vi.restoreAllMocks(); bindingManager._resetForTesting(); });
const bind = (targetId: string, extra = {}) => bindingManager.bind('selected', { targetId, targetKind: 'agent', label: 'Safe label', ...extra });
const read = (receipts: DisplayReceipt[] = [], authorized = () => true, target = { current: () => true }) => readSelectedOutgoingWiresForDisplay('selected', { receipts, authorized, target });

it('projects only names and kinds from the selected outgoing bucket, without global enumeration or endpoint lookup', () => {
  for (const kind of REMOTE_OUTGOING_WIRE_KINDS) bind(kind, { targetKind: kind, targetName: `Safe ${kind}`, projectName: 'Safe group', instructions: { '*': 'PRIVATE_INSTRUCTIONS' } });
  bindingManager.bind('PRIVATE_OTHER', { targetId: 'selected', targetKind: 'agent', label: 'PRIVATE_INCOMING' });
  const all = vi.spyOn(bindingManager, 'getAllBindings'), receipts: DisplayReceipt[] = [], result = read(receipts);
  expect(result).toEqual({ source: 'selected-outgoing-binding-records', state: 'recorded', total: 5, omitted: 0,
    rows: REMOTE_OUTGOING_WIRE_KINDS.map((kind) => ({ kind, name: kind === 'group-project' ? 'Safe group' : `Safe ${kind}` })) });
  expect(isRemoteOutgoingWires(result)).toBe(true); expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|targetId|agentId|instructions/);
  expect(all).not.toHaveBeenCalled(); expect(receipts.every((r) => r.current())).toBe(true);
  bindingManager.updateBinding('selected', 'agent', { targetName: 'Changed' }); expect(receipts.some((r) => !r.current())).toBe(true);
});

it('distinguishes verified empty, bounded omissions, and invalid selected evidence', () => {
  expect(read()).toMatchObject({ state: 'recorded', rows: [], total: 0, omitted: 0 });
  for (let i = 0; i < 51; i++) bind(String(i));
  expect(read()).toMatchObject({ state: 'recorded', rows: expect.any(Array), total: 51, omitted: 1 });
  expect(isRemoteOutgoingWires(read())).toBe(true);
  const unavailable = readSelectedOutgoingWiresForDisplay('', { receipts: [], authorized: () => true, target: { current: () => true } });
  expect(unavailable).toMatchObject({ state: 'unavailable', reason: 'invalid' }); expect(unavailable).not.toHaveProperty('rows');
});

it('leaves unattested names unknown, redacts before bounding, and never falls back to raw target IDs', () => {
  bind('PRIVATE_TARGET_ID', { label: 'x'.repeat(1025), targetName: 'x'.repeat(1025) });
  bind('secret', { label: 'apiKey="PRIVATE_SECRET"\n' + 'x'.repeat(400) });
  const result = read(); expect(result).toMatchObject({ state: 'recorded', rows: [{ kind: 'agent', name: null }, { kind: 'agent', name: expect.any(String) }] });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|\\n/); expect(isRemoteOutgoingWires(result)).toBe(true);
});

it.each(['revoked', 'target-changed'])('does not read when selected admission is %s', (mode) => {
  const reader = vi.spyOn(bindingManager, 'readBindingsForDisplay');
  expect(read([], () => mode !== 'revoked', { current: () => mode !== 'target-changed' })).toMatchObject({ state: 'unavailable', reason: 'changed' });
  expect(reader).not.toHaveBeenCalled();
});

it('keeps unrelated mutations current and does not let returned DTO edits retarget its receipt', () => {
  bind('target'); const receipts: DisplayReceipt[] = [], result = read(receipts);
  if (result.state !== 'recorded') throw new Error('Expected selected evidence');
  result.rows[0].name = 'Caller edit'; bindingManager.bind('unrelated', { targetId: 'other', targetKind: 'agent', label: 'Other' });
  expect(receipts.every((r) => r.current())).toBe(true); expect(read()).toMatchObject({ rows: [{ name: 'Safe label' }] });
});

it.each([
  { source: 'retained-source-cache', state: 'recorded', rows: [], total: 0, omitted: 0 },
  { source: 'selected-outgoing-binding-records', state: 'recorded', rows: [{ name: 'Name', kind: 'unknown' }], total: 1, omitted: 0 },
  { source: 'selected-outgoing-binding-records', state: 'recorded', rows: [{ name: 'Name', kind: 'agent', targetId: 'PRIVATE_ID' }], total: 1, omitted: 0 },
  { source: 'selected-outgoing-binding-records', state: 'recorded', rows: [], total: 1, omitted: 0 },
  { source: 'selected-outgoing-binding-records', state: 'unavailable', reason: 'invalid', rows: [] },
])('rejects ambiguous or expanded Wires payload %#', (value) => { expect(isRemoteOutgoingWires(value)).toBe(false); });
