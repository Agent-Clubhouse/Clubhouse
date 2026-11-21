import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bindingManager, BINDING_DISPLAY_PAGE, BINDING_DISPLAY_OWNERS, BINDING_DISPLAY_SCAN, type BindingDisplayDirection } from './binding-manager';
const selected = 'selected-agent';
const bind = (agentId = selected, targetId = 'target-agent', targetKind: 'agent' | 'browser' | 'terminal' | 'plugin' | 'group-project' = 'agent') => bindingManager.bind(agentId, { targetId, targetKind, label: `${targetKind} label`, agentName: 'Source name', targetName: 'Target name', projectName: 'Project name' });
const read = (direction: BindingDisplayDirection = 'outgoing', offset = 0, key = selected) => { const receipts: Array<{ current(): boolean }> = []; return { value: bindingManager.readBindingsForDisplay(key, { direction, offset, receipts }), receipts }; };
beforeEach(() => { bindingManager._resetForTesting(); bindingManager.setConnectionToolsSource(null, null); bindingManager.setConnectionInstructionsSource(null); });
afterEach(() => { bindingManager._resetForTesting(); bindingManager.setConnectionToolsSource(null, null); bindingManager.setConnectionInstructionsSource(null); vi.restoreAllMocks(); });
it('projects only selected outgoing safe fields and selected incoming agent directions without invoking resolvers, global lists or notifications', () => {
  bind(); bind('source-agent', selected); bind('widget-owner', selected, 'browser'); bind('other-agent', 'other-target');
  bindingManager.setInstructions(selected, 'target-agent', { '*': 'PRIVATE_INSTRUCTIONS' }); Object.assign(bindingManager.getBindingsForAgent(selected)[0], { rawConfig: 'PRIVATE_CONFIG', env: { key: 'PRIVATE_CREDENTIAL' } });
  const callback = vi.fn(() => { throw new Error('display must not invoke resolver'); }); bindingManager.setConnectionToolsSource(callback, callback); bindingManager.setConnectionInstructionsSource(callback); const notify = vi.fn(); bindingManager.onChange(notify);
  const all = vi.spyOn(bindingManager, 'getAllBindings'), ordinary = vi.spyOn(bindingManager, 'getBindingsForAgent'), version = bindingManager.getVersion();
  const outgoing = read(), incoming = read('incoming');
  expect.soft(outgoing.value).toMatchObject({ state: 'ok', value: { total: 1, rows: [{ agentId: selected, targetId: 'target-agent', agentName: { value: 'Source name' }, disabledTools: { value: [] }, enabledTools: { value: [] } }] } });
  expect.soft(incoming.value).toMatchObject({ state: 'ok', value: { total: 1, rows: [{ agentId: 'source-agent', targetId: selected, targetKind: 'agent' }] } });
  expect.soft(JSON.stringify([outgoing.value, incoming.value])).not.toMatch(/PRIVATE_|other-agent|other-target|widget-owner|instructions|rawConfig|credential|receipts|current/);
  expect.soft(outgoing.receipts[0].current()).toBe(true); expect.soft(incoming.receipts[0].current()).toBe(true); expect.soft(all).not.toHaveBeenCalled(); expect.soft(ordinary).not.toHaveBeenCalled(); expect.soft(callback).not.toHaveBeenCalled(); expect.soft(notify).not.toHaveBeenCalled(); expect.soft(bindingManager.getVersion()).toBe(version);
});
it('keeps verified empty outgoing and incoming distinct from unavailable scanning', () => { expect(read().value).toMatchObject({ state: 'ok', value: { total: 0, rows: [], omitted: 0, nextOffset: null } }); expect(read('incoming').value).toMatchObject({ state: 'ok', value: { total: 0, rows: [] } }); });
it('keeps known outgoing when incoming owner budget is unavailable, counting empty owners too', () => {
  bind(); for (let i = 0; i < BINDING_DISPLAY_OWNERS; i++) { const id = `other-${i}`; bind(id, 'elsewhere'); bindingManager.getBindingsForAgent(id).length = 0; }
  expect(read().value).toMatchObject({ state: 'ok', value: { total: 1 } }); expect(read('incoming').value).toMatchObject({ state: 'unavailable', reason: 'limit' });
});
it.each(['outgoing', 'incoming'] as const)('counts all rows including nonmatches in %s scan admission', (direction) => {
  bind(direction === 'outgoing' ? selected : 'other-agent'); const bucket = bindingManager.getBindingsForAgent(direction === 'outgoing' ? selected : 'other-agent');
  bucket.push(...Array.from({ length: BINDING_DISPLAY_SCAN }, (_, i) => ({ agentId: direction === 'outgoing' ? selected : 'other-agent', targetId: `elsewhere-${i}`, targetKind: 'agent' as const, label: 'safe' })));
  expect(read(direction).value).toMatchObject({ state: 'unavailable', reason: 'limit' });
});
it('pages selected rows explicitly without a false complete/empty claim', () => {
  for (let i = 0; i <= BINDING_DISPLAY_PAGE; i++) bind(selected, `target-${i}`);
  expect(read().value).toMatchObject({ state: 'ok', value: { total: BINDING_DISPLAY_PAGE + 1, offset: 0, omitted: 1, nextOffset: BINDING_DISPLAY_PAGE } });
  const last = read('outgoing', BINDING_DISPLAY_PAGE); expect(last.value).toMatchObject({ state: 'ok', value: { rows: [{ targetId: `target-${BINDING_DISPLAY_PAGE}` }], total: BINDING_DISPLAY_PAGE + 1, omitted: BINDING_DISPLAY_PAGE, nextOffset: null } });
  if (last.value.state === 'ok') expect(last.value.value.rows).toHaveLength(1);
});
it.each(['label', 'source-name', 'target-name', 'project-name', 'disabled', 'enabled', 'remove', 'incoming', 'reset', 'instructions', 'unrelated'])('rechecks selected safe page after later %s edit', (change) => {
  bind(); bind('source-agent', selected); bind('other-agent', 'elsewhere'); const outgoing = read(), incoming = read('incoming'); expect(outgoing.receipts[0].current()).toBe(true); expect(incoming.receipts[0].current()).toBe(true);
  const row = bindingManager.getBindingsForAgent(selected)[0];
  if (change === 'label') row.label = 'New label'; if (change === 'source-name') row.agentName = 'New source'; if (change === 'target-name') row.targetName = 'New target'; if (change === 'project-name') row.projectName = 'New project';
  if (change === 'disabled') row.disabledTools = ['read_output']; if (change === 'enabled') row.enabledTools = ['wake_agent']; if (change === 'remove') bindingManager.unbind(selected, 'target-agent');
  if (change === 'incoming') bindingManager.getBindingsForAgent('source-agent')[0].label = 'Changed incoming'; if (change === 'reset') bindingManager._resetForTesting(); if (change === 'instructions') row.instructions = { '*': 'PRIVATE_NEW_INSTRUCTIONS' }; if (change === 'unrelated') bindingManager.getBindingsForAgent('other-agent')[0].label = 'PRIVATE_OTHER_LABEL';
  expect.soft(outgoing.receipts[0].current()).toBe(['incoming', 'instructions', 'unrelated'].includes(change)); expect.soft(incoming.receipts[0].current()).toBe(change !== 'incoming' && change !== 'reset');
});
it('attests page and counts only, permitting off-page metadata changes with unchanged selected page/count', () => {
  for (let i = 0; i <= BINDING_DISPLAY_PAGE; i++) bind(selected, `target-${i}`); const first = read(), last = read('outgoing', BINDING_DISPLAY_PAGE);
  bindingManager.getBindingsForAgent(selected)[BINDING_DISPLAY_PAGE].label = 'New off-page label'; expect(first.receipts[0].current()).toBe(true); expect(last.receipts[0].current()).toBe(false);
});
it.each(['wrong-owner', 'invalid-kind', 'duplicate', 'invalid-target'])('refuses ambiguous or malformed selected %s identity', (kind) => {
  bind(); const bucket = bindingManager.getBindingsForAgent(selected), row = bucket[0]; if (kind === 'wrong-owner') row.agentId = 'unrelated-agent'; if (kind === 'invalid-kind') row.targetKind = 'unknown' as never; if (kind === 'duplicate') bucket.push({ ...row }); if (kind === 'invalid-target') row.targetId = 'x'.repeat(513);
  expect(read().value.state).toBe('unavailable');
});
it.each(['bad-tools', 'long-tools', 'bad-name', 'long-name'])('preserves independent names and tools for %s selected field', (kind) => {
  bind(); const row = bindingManager.getBindingsForAgent(selected)[0]; if (kind === 'bad-tools') row.disabledTools = 'read_output' as never; if (kind === 'long-tools') row.disabledTools = Array.from({ length: 101 }, () => 'read_output'); if (kind === 'bad-name') row.targetName = {} as never; if (kind === 'long-name') row.targetName = 'x'.repeat(1025);
  const { value } = read(); expect(value.state).toBe('ok'); if (value.state === 'ok') { const fields = value.value.rows[0]; expect(fields.disabledTools.state).toBe(kind.includes('tools') ? 'unavailable' : 'ok'); expect(fields.targetName.state).toBe(kind.includes('name') ? 'unavailable' : 'ok'); expect(fields.label).toMatchObject({ state: 'ok', value: 'agent label' }); }
});
it('retains long qualified remote incoming IDs while refusing browser ID collisions', () => { const remote = 'a'.repeat(200) + '@' + 'b'.repeat(200); bind(remote, selected); bind('widget-owner', selected, 'terminal'); const result = read('incoming'); expect(result.value).toMatchObject({ state: 'ok', value: { total: 1, rows: [{ agentId: remote }] } }); });
it('never consults private instruction accessors and detaches names/tool arrays from the ordinary cache', () => {
  bind(); const original = bindingManager.getBindingsForAgent(selected)[0]; original.disabledTools = ['read_output']; const getter = vi.fn(() => { throw new Error('private instruction read'); }); Object.defineProperty(original, 'instructions', { configurable: true, get: getter });
  const { value, receipts } = read(); expect(value.state).toBe('ok'); if (value.state === 'ok') { const row = value.value.rows[0]; if (row.disabledTools.state === 'ok') row.disabledTools.value.push('PRIVATE_CALLER_TOOL'); if (row.label.state === 'ok') row.label.value = 'PRIVATE_CALLER_NAME'; }
  expect(read().value).toMatchObject({ value: { rows: [{ label: { value: 'agent label' }, disabledTools: { value: ['read_output'] } }] } }); expect(original.disabledTools).toEqual(['read_output']); expect(original.label).toBe('agent label'); expect(receipts[0].current()).toBe(true); expect(getter).not.toHaveBeenCalled();
});
it.each(['empty', 'long-key', 'null-key', 'negative-offset', 'fraction-offset', 'large-offset', 'invalid-direction'])('omits read receipts for invalid %s admission', (kind) => {
  const receipts: Array<{ current(): boolean }> = []; const value = bindingManager.readBindingsForDisplay(kind === 'empty' ? '' : kind === 'long-key' ? 'x'.repeat(201) : kind === 'null-key' ? null as never : selected, { direction: kind === 'invalid-direction' ? 'other' as never : 'outgoing', offset: kind === 'negative-offset' ? -1 : kind === 'fraction-offset' ? 0.5 : kind === 'large-offset' ? BINDING_DISPLAY_SCAN + 1 : 0, receipts }); expect(value.state).toBe('unavailable'); expect(receipts).toHaveLength(0);
});
