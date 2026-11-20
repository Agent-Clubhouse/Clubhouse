import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { readCachedConnectionSourcesForDisplay, registerPersistedBindingSource, rebuildPersistedBindings, claimSourceBinding, releaseSourceBinding, inspectConnectionGuidance, markBindingRemovedByUser, markSourceRemovedByUser, _resetPersistedBindingSourcesForTesting, SOURCE_DISPLAY_REGISTRY_LIMIT, SOURCE_DISPLAY_KEY_LIMIT, SOURCE_DISPLAY_PAGE, type PersistedBinding } from './persisted-bindings';
let root: string;
const selected = 'selected-agent';
const wire = (agentId = selected, targetId = 'target-agent', extra: Record<string, unknown> = {}): PersistedBinding => ({ agentId, targetId, targetKind: 'agent', label: 'Selected label', agentName: 'Source name', targetName: 'Target name', projectName: 'Project name', instructions: { '*': 'PRIVATE_INSTRUCTIONS' }, ...extra });
const capture = (agentId = selected, offset = 0) => { const receipts: Array<{ current(): boolean }> = []; return { value: readCachedConnectionSourcesForDisplay(agentId, { offset, receipts }), receipts }; };
const disk = async () => Object.fromEntries(await Promise.all((await fs.promises.readdir(root)).sort().map(async (name) => { const file = path.join(root, name), stat = await fs.promises.stat(file); return [name, { bytes: (await fs.promises.readFile(file)).toString('base64'), ino: stat.ino, mtimeMs: stat.mtimeMs }]; })));
const source = (id = 'fixture-source', bindings = [wire()]) => { const collect = vi.fn(async () => bindings), inspect = vi.fn(async () => bindings); const descriptor = { id, prune: true, readOnlyCollect: true as const, collect, inspect }; const stop = registerPersistedBindingSource(descriptor); return { descriptor, collect, inspect, stop, bindings }; };
beforeEach(async () => { root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clubhouse-source-display-'))); bindingManager._resetForTesting(); bindingManager.setConnectionToolsSource(null, null); bindingManager.setConnectionInstructionsSource(null); _resetPersistedBindingSourcesForTesting(); });
afterEach(async () => { _resetPersistedBindingSourcesForTesting(); bindingManager._resetForTesting(); vi.restoreAllMocks(); await fs.promises.rm(root, { recursive: true, force: true }); });
it('never calls cold collectors or inspectors, even ones advertised as read-only, or mutates actual files/listeners', async () => {
  const write = vi.fn(async () => { fs.writeFileSync(path.join(root, 'marker'), 'reader invoked callback'); return [wire()]; }); registerPersistedBindingSource({ id: 'cold-source', readOnlyCollect: true, collect: write, inspect: write });
  const before = await disk(), listener = vi.fn(); bindingManager.onChange(listener); const all = vi.spyOn(bindingManager, 'getAllBindings'); const { value, receipts } = capture();
  expect.soft(value).toMatchObject({ state: 'ok', value: { scope: 'registered-cache-only', complete: false, pairs: [], total: 0, sourceStates: [{ sourceId: 'cold-source', state: 'unavailable', reason: 'uninitialized' }] } }); expect.soft(receipts[0].current()).toBe(true); expect.soft(write).not.toHaveBeenCalled(); expect.soft(listener).not.toHaveBeenCalled(); expect.soft(all).not.toHaveBeenCalled(); expect.soft(await disk()).toEqual(before);
});
it('projects only selected safe cached originals and ownership provenance without collection/inspection/notification', async () => {
  const s = source('fixture-source', [wire(), wire('sender-agent', selected), wire('PRIVATE_OTHER_AGENT', 'PRIVATE_OTHER_TARGET', { label: 'PRIVATE_OTHER_LABEL' })]); await rebuildPersistedBindings(); s.collect.mockClear(); s.inspect.mockClear(); const listener = vi.fn(); bindingManager.onChange(listener); const before = await disk(), all = vi.spyOn(bindingManager, 'getAllBindings'), { value, receipts } = capture();
  expect.soft(value).toMatchObject({ state: 'ok', value: { total: 2, pairs: [{ agentId: selected, targetId: 'target-agent', sources: [{ sourceId: 'fixture-source', provenance: 'last-reconciled', verified: true, removedByUser: false, copies: 1, binding: { state: 'ok', value: { label: { value: 'Selected label' }, disabledTools: { value: [] } } } }] }, { agentId: 'sender-agent', targetId: selected, sources: [{ sourceId: 'fixture-source', provenance: 'last-reconciled', binding: { state: 'ok' } }] }] } });
  expect.soft(JSON.stringify(value)).not.toMatch(/PRIVATE_|instructions|rawConfig|credential|receipts|current/); expect.soft(receipts[0].current()).toBe(true); expect.soft(s.collect).not.toHaveBeenCalled(); expect.soft(s.inspect).not.toHaveBeenCalled(); expect.soft(listener).not.toHaveBeenCalled(); expect.soft(all).not.toHaveBeenCalled(); expect.soft(await disk()).toEqual(before);
});
it('distinguishes known empty warmed cache from cold unknown coverage', async () => { const s = source('empty-source', []); expect(capture().value).toMatchObject({ value: { sourceStates: [{ state: 'unavailable' }] } }); await rebuildPersistedBindings(); s.collect.mockClear(); expect(capture().value).toMatchObject({ value: { total: 0, complete: true, sourceStates: [{ state: 'known' }] } }); expect(s.collect).not.toHaveBeenCalled(); });
it('uses a separately warmed inspection without invoking it again', async () => { const s = source(); await inspectConnectionGuidance(selected, 'target-agent'); s.collect.mockClear(); s.inspect.mockClear(); expect(capture().value).toMatchObject({ value: { pairs: [{ sources: [{ provenance: 'last-inspected', binding: { state: 'ok' } }] }], sourceStates: [{ state: 'known' }] } }); expect(s.collect).not.toHaveBeenCalled(); expect(s.inspect).not.toHaveBeenCalled(); });
it('retains independently available explicit claims while marking collection coverage partial', () => { const s = source(); claimSourceBinding(s.descriptor.id, wire()); expect(capture().value).toMatchObject({ value: { total: 1, sourceStates: [{ state: 'partial', reason: 'uninitialized' }], pairs: [{ sources: [{ provenance: 'claimed-cache', verified: false, binding: { state: 'ok' } }] }] } }); expect(s.collect).not.toHaveBeenCalled(); });
it('retains unverified selected pairs as unknown ownership with independent safe metadata', async () => { registerPersistedBindingSource({ id: 'partial', collect: async () => ({ bindings: [wire()], unverified: [{ agentId: selected, targetId: 'target-agent' }, { agentId: selected, targetId: 'unverified-agent' }] }) }); await rebuildPersistedBindings(); const { value } = capture(); expect(value).toMatchObject({ value: { total: 2, pairs: [{ sources: [{ verified: false, binding: { state: 'ok' } }] }, { targetId: 'unverified-agent', sources: [{ verified: false, copies: null, binding: { state: 'unavailable' } }] }] } }); });
it('discards failed-current-source cache rather than adopting old guidance as a fresh listing', async () => { const s = source(); await rebuildPersistedBindings(); s.collect.mockRejectedValueOnce(new Error('fixture unavailable')); await rebuildPersistedBindings(); s.collect.mockClear(); expect(capture().value).toMatchObject({ value: { total: 0, sourceStates: [{ state: 'unavailable' }] } }); expect(s.collect).not.toHaveBeenCalled(); });
it.each(['claim-label', 'claim-tools', 'release', 'pair-removal', 'source-removal', 'unregister', 'replacement', 'descriptor-id', 'unrelated'])('rechecks selected cache/registry receipts after %s', async (change) => {
  const s = source(); await rebuildPersistedBindings(); const { receipts } = capture(); expect(receipts[0].current()).toBe(true);
  if (change === 'claim-label') claimSourceBinding(s.descriptor.id, wire(selected, 'target-agent', { label: 'Changed label' }));
  if (change === 'claim-tools') claimSourceBinding(s.descriptor.id, wire(selected, 'target-agent', { disabledTools: ['read_output'] }));
  if (change === 'release') releaseSourceBinding(s.descriptor.id, selected, 'target-agent'); if (change === 'pair-removal') markBindingRemovedByUser(selected, 'target-agent'); if (change === 'source-removal') markSourceRemovedByUser(s.descriptor.id, selected, 'target-agent'); if (change === 'unregister') s.stop(); if (change === 'replacement') source(s.descriptor.id); if (change === 'descriptor-id') s.descriptor.id = 'changed-id'; if (change === 'unrelated') claimSourceBinding(s.descriptor.id, wire('PRIVATE_OTHER_AGENT', 'PRIVATE_OTHER_TARGET'));
  // Adding an unrelated pair does not change the selected page/count or source coverage.
  expect(receipts[0].current()).toBe(change === 'unrelated');
});
it('groups corresponding source ownership without duplicating the selected pair', async () => { source('first'); source('second'); await rebuildPersistedBindings(); expect(capture().value).toMatchObject({ value: { total: 1, pairs: [{ sources: [{ sourceId: 'first' }, { sourceId: 'second' }] }] } }); });
it('bounds total registered sources before enumerating their retained keys', () => { for (let i = 0; i <= SOURCE_DISPLAY_REGISTRY_LIMIT; i++) source(`source-${i}`, []); expect(capture().value).toMatchObject({ state: 'unavailable', reason: 'limit' }); });
it('counts nonmatching retained keys and preserves a later independently readable source', () => { const large = source('large'); for (let i = 0; i <= SOURCE_DISPLAY_KEY_LIMIT; i++) claimSourceBinding(large.descriptor.id, wire(`other-${i}`, 'elsewhere')); const small = source('small'); claimSourceBinding(small.descriptor.id, wire()); expect(capture().value).toMatchObject({ value: { total: 1, sourceStates: [{ sourceId: 'large', state: 'unavailable', reason: 'limit' }, { sourceId: 'small', state: 'partial' }], pairs: [{ sources: [{ sourceId: 'small' }] }] } }); });
it('pages selected pairs and reports prior-page omissions explicitly', () => { const s = source(); for (let i = 0; i <= SOURCE_DISPLAY_PAGE; i++) claimSourceBinding(s.descriptor.id, wire(selected, `target-${i}`)); expect(capture().value).toMatchObject({ value: { total: SOURCE_DISPLAY_PAGE + 1, omitted: 1, nextOffset: SOURCE_DISPLAY_PAGE } }); expect(capture(selected, SOURCE_DISPLAY_PAGE).value).toMatchObject({ value: { pairs: [{ targetId: `target-${SOURCE_DISPLAY_PAGE}` }], omitted: SOURCE_DISPLAY_PAGE, nextOffset: null } }); });
it('keeps original-copy count and membership available when display-original admission is exceeded', async () => { source('many-copies', Array.from({ length: 101 }, () => wire())); await rebuildPersistedBindings(); expect(capture().value).toMatchObject({ value: { total: 1, pairs: [{ sources: [{ copies: 101, binding: { state: 'unavailable', reason: 'limit' } }] }] } }); });
it('withholds conflicting original kinds while retaining the selected outgoing cache membership', async () => { source('mixed', [wire(), wire(selected, 'target-agent', { targetKind: 'browser' })]); await rebuildPersistedBindings(); expect(capture().value).toMatchObject({ value: { pairs: [{ sources: [{ binding: { state: 'unavailable' } }] }] } }); });
it('detaches caller edits from cached fields and later private receipt comparison', () => { const s = source(); claimSourceBinding(s.descriptor.id, wire(selected, 'target-agent', { disabledTools: ['read_output'] })); const { value, receipts } = capture(); if (value.state === 'ok') { const b = value.value.pairs[0].sources[0].binding; if (b.state === 'ok' && b.value.disabledTools.state === 'ok') b.value.disabledTools.value.push('PRIVATE_CALLER_TOOL'); } expect(capture().value).toMatchObject({ value: { pairs: [{ sources: [{ binding: { value: { disabledTools: { value: ['read_output'] } } } }] }] } }); expect(receipts[0].current()).toBe(true); });
it.each(['', 'x'.repeat(201), null])('does not retain invalid selected key %s', (key) => { const { value, receipts } = capture(key as string); expect(value.state).toBe('unavailable'); expect(receipts).toHaveLength(0); });
it.each([-1, 0.5, SOURCE_DISPLAY_KEY_LIMIT + 1])('does not retain invalid offset %s', (offset) => { const { value, receipts } = capture(selected, offset); expect(value.state).toBe('unavailable'); expect(receipts).toHaveLength(0); });

it('does not disclose an unrelated widget owner when its widget ID collides with the selected agent', async () => {
  source('mixed-targets', [wire(), wire('PRIVATE_WIDGET_OWNER', selected, { targetKind: 'browser', label: 'PRIVATE_WIDGET_LABEL' })]); await rebuildPersistedBindings(); const { value } = capture(); expect.soft(value).toMatchObject({ value: { total: 1, complete: true, pairs: [{ agentId: selected }] } }); expect.soft(JSON.stringify(value)).not.toMatch(/PRIVATE_WIDGET/);
});
it('withholds unknown incoming scope rather than adopting raw pair keys as agent relationships', async () => {
  registerPersistedBindingSource({ id: 'unknown-incoming', collect: async () => ({ bindings: [], unverified: [{ agentId: 'PRIVATE_UNKNOWN_OWNER', targetId: selected }] }) }); await rebuildPersistedBindings(); const { value } = capture(); expect.soft(value).toMatchObject({ value: { total: 0, complete: false, sourceStates: [{ state: 'partial', reason: 'unverified' }] } }); expect.soft(JSON.stringify(value)).not.toContain('PRIVATE_UNKNOWN_OWNER');
});

it('bounds incoming identity work and withholds owner IDs outside that admitted scope', async () => {
  const rows = Array.from({ length: 6 }, (_, i) => Array.from({ length: 100 }, () => wire(i === 5 ? 'PRIVATE_UNADMITTED_OWNER' : `sender-${i}`, selected))).flat(); source('many-incoming-copies', rows); await rebuildPersistedBindings(); const { value } = capture();
  expect.soft(value).toMatchObject({ value: { total: 5, complete: false, sourceStates: [{ state: 'partial', reason: 'limit' }] } }); expect.soft(JSON.stringify(value)).not.toContain('PRIVATE_UNADMITTED_OWNER');
});
it('bounds projected original work independently of known outgoing membership', async () => {
  const rows = Array.from({ length: 6 }, (_, i) => Array.from({ length: 100 }, () => wire(selected, `target-${i}`))).flat(); source('many-outgoing-copies', rows); await rebuildPersistedBindings(); const { value } = capture(); expect(value.state).toBe('ok');
  if (value.state === 'ok') { expect(value.value.total).toBe(6); expect(value.value.complete).toBe(true); expect(value.value.pairs[4].sources[0].binding.state).toBe('ok'); expect(value.value.pairs[5].sources[0].binding).toMatchObject({ state: 'unavailable', reason: 'limit' }); }
});

it('fences producer replacement even after an identical safe cache page is rebuilt', async () => {
  const first = source('stable-id'); await rebuildPersistedBindings(); const old = capture(); expect(old.receipts[0].current()).toBe(true);
  first.stop(); source('stable-id'); await rebuildPersistedBindings(); const fresh = capture();
  const safe = (value: unknown) => JSON.stringify(value, (key, v) => key === 'inputs' ? undefined : v);
  expect(safe(fresh.value)).toBe(safe(old.value)); expect(old.receipts[0].current()).toBe(false); expect(fresh.receipts[0].current()).toBe(true);
});

it.each([
  { prune: undefined, unrelated: false }, { prune: false, unrelated: false },
  { prune: undefined, unrelated: true }, { prune: false, unrelated: true },
])('includes a later non-pruning claim after established listing %j', async ({ prune, unrelated }) => {
  const collect = vi.fn(async () => unrelated ? [wire('other-agent', 'other-target')] : []);
  registerPersistedBindingSource({ id: 'non-pruning', ...(prune !== undefined && { prune }), collect });
  await rebuildPersistedBindings(); collect.mockClear();
  const old = capture(); expect(old.value).toMatchObject({ state: 'ok', value: { total: 0, complete: true } }); expect(old.receipts[0].current()).toBe(true);
  expect(claimSourceBinding('non-pruning', wire())).toBe('created');
  expect(bindingManager.getBindingsForAgent(selected)).toMatchObject([{ agentId: selected, targetId: 'target-agent', label: 'Selected label' }]);
  const fresh = capture();
  expect.soft(fresh.value).toMatchObject({ state: 'ok', value: { total: 1, complete: false, sourceStates: [{ sourceId: 'non-pruning', state: 'partial', reason: 'unlisted' }], pairs: [{ agentId: selected, targetId: 'target-agent', sources: [{ sourceId: 'non-pruning', binding: { state: 'ok', value: { label: { value: 'Selected label' } } } }] }] } });
  expect.soft(old.receipts[0].current()).toBe(false); expect.soft(collect).not.toHaveBeenCalled();
});

it.each([undefined, false])('includes a later incoming non-pruning claim with prune=%s', async (prune) => {
  registerPersistedBindingSource({ id: 'incoming-claim', ...(prune !== undefined && { prune }), collect: async () => [] }); await rebuildPersistedBindings(); const old = capture(); expect(old.value).toMatchObject({ value: { complete: true, total: 0 } });
  expect(claimSourceBinding('incoming-claim', wire('sender-agent', selected))).toBe('created');
  const fresh = capture(); expect.soft(fresh.value).toMatchObject({ value: { total: 1, complete: false, sourceStates: [{ state: 'partial', reason: 'unlisted' }], pairs: [{ agentId: 'sender-agent', targetId: selected, sources: [{ verified: false, provenance: 'claimed-cache', binding: { state: 'ok' } }] }] } }); expect.soft(old.receipts[0].current()).toBe(false);
});
it('includes selected later inspection keys outside an established empty listing', async () => {
  const inspect = vi.fn(async () => [wire()]); registerPersistedBindingSource({ id: 'inspected-extra', collect: async () => [], inspect }); await rebuildPersistedBindings(); const old = capture(); expect(old.value).toMatchObject({ value: { complete: true, total: 0 } });
  await inspectConnectionGuidance(selected, 'target-agent'); inspect.mockClear(); const fresh = capture();
  expect.soft(fresh.value).toMatchObject({ value: { total: 1, complete: false, sourceStates: [{ state: 'partial', reason: 'unlisted' }], pairs: [{ sources: [{ sourceId: 'inspected-extra', provenance: 'last-inspected', verified: false, binding: { state: 'ok' } }] }] } }); expect.soft(old.receipts[0].current()).toBe(false); expect.soft(inspect).not.toHaveBeenCalled();
});
it('charges repeated keys in every traversed inventory while preserving a later readable source', async () => {
  const count = Math.floor(SOURCE_DISPLAY_KEY_LIMIT / 3) + 1; source('triple-inventory', Array.from({ length: count }, (_, i) => wire(i ? `other-${i}` : selected, 'target-agent'))); await rebuildPersistedBindings(); const small = source('small-later'); claimSourceBinding(small.descriptor.id, wire());
  const { value } = capture(); expect(value).toMatchObject({ value: { complete: false, total: 1, sourceStates: [{ sourceId: 'triple-inventory', state: 'unavailable', reason: 'limit' }, { sourceId: 'small-later', state: 'partial' }], pairs: [{ sources: [{ sourceId: 'small-later', binding: { state: 'ok' } }] }] } });
});
it('does not adopt a later inspected widget collision from the new inventory union', async () => {
  registerPersistedBindingSource({ id: 'inspected-widget', collect: async () => [], inspect: async () => [wire('PRIVATE_LATER_WIDGET_OWNER', selected, { targetKind: 'browser', label: 'PRIVATE_LATER_WIDGET_LABEL' })] }); await rebuildPersistedBindings(); await inspectConnectionGuidance('PRIVATE_LATER_WIDGET_OWNER', selected);
  const { value } = capture(); expect.soft(value).toMatchObject({ value: { complete: true, total: 0, pairs: [] } }); expect.soft(JSON.stringify(value)).not.toMatch(/PRIVATE_LATER_WIDGET/);
});
it('reads a later guidance-only claim after an ordinary failed inspection removed the inspected cache', async () => {
  const inspect = vi.fn(async (): Promise<PersistedBinding[]> => { throw new Error('fixture inspection unavailable'); });
  registerPersistedBindingSource({ id: 'guidance-only', collect: async () => [], inspect }); await rebuildPersistedBindings(); await inspectConnectionGuidance(selected, 'target-agent');
  expect(capture().value).toMatchObject({ value: { total: 0, complete: false, sourceStates: [{ state: 'unavailable' }] } });
  expect(claimSourceBinding('guidance-only', wire())).toBe('created'); inspect.mockClear();
  expect(capture().value).toMatchObject({ value: { total: 1, complete: false, sourceStates: [{ state: 'partial', reason: 'unlisted' }], pairs: [{ sources: [{ provenance: 'claimed-cache', binding: { state: 'ok' } }] }] } }); expect(inspect).not.toHaveBeenCalled();
});
