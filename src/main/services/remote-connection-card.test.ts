import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
const m = vi.hoisted(() => ({ names: new Map<string, string>(), satellites: new Map<string, Record<string, unknown>>(), side: vi.fn(), legacy: vi.fn(() => { throw new Error('legacy side-effectful reader'); }), ownOn: false }));
vi.mock('./log-service', () => ({ appLog: m.side }));
vi.mock('./annex-network-profile', () => ({ annexEphemeralSession: () => false }));
vi.mock('./annex-device-signal', () => ({ devicesChanged: m.side, onDevicesChanged: m.side }));
vi.mock('./annex-network-channel', () => ({ broadcast: m.legacy, localMember: m.legacy, setMembersProvider: m.legacy, setSelfPairingProvider: m.legacy, setUnknownPeerReasonProvider: m.legacy, onNetworkMessage: m.legacy }));
vi.mock('./annex-settings', () => ({ getSettings: m.legacy, networkEnabled: m.legacy }));
vi.mock('./annex-identity', () => ({ getIdentity: m.legacy, computeFingerprint: m.legacy }));
vi.mock('./annex-tls', () => ({ certificateFingerprint: m.legacy, sameCertificateFingerprint: m.legacy }));
vi.mock('./annex-client', () => ({ getSatellite: (id: string) => m.satellites.has(id) ? { ...m.satellites.get(id) } : null }));
vi.mock('./actions/details-names', () => ({ actionDetailsNames: () => ({ names: { agent: (id: string) => m.names.get(id) }, notices: () => [] }) }));
vi.mock('./dispatcher/dispatcher-service', () => ({ getDispatcherAgentId: () => 'selected-agent', isDispatcherIdentityAgentId: () => false, dispatcherDisplayName: m.legacy, getDispatcherState: m.legacy, isDispatcherEnabled: m.legacy, onDispatcherChanged: m.side }));
vi.mock('./dispatcher/dispatcher-settings', () => ({ readDispatcherEnablementForDisplay: (options: { receipts: Array<{ current(): boolean }> }) => { const admitted = m.ownOn; options.receipts.push({ current: () => m.ownOn === admitted }); return { enabled: { state: 'ok', value: admitted, inputs: [] }, reason: { state: 'unavailable', inputs: [] } }; } }));
vi.mock('./connection-sources', () => ({ listConnectionSources: m.legacy }));
vi.mock('./connection-grants-store', () => ({ getConnectionDirection: m.legacy, listConnectionDirectionsForInspection: m.legacy }));
import { readPassiveConnectionCard } from './remote-connection-card';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { registerPersistedBindingSource, rebuildPersistedBindings, claimSourceBinding, markSourceRemovedByUser, readCachedConnectionSourcesForDisplay, _resetPersistedBindingSourcesForTesting, type PersistedBinding } from './persisted-bindings';
import * as peers from './annex-peers';
import * as membership from './annex-network-membership';
import { setFederationRequestRouter } from './dispatcher-federation-policy';
import { createFederationRequestStore } from './dispatcher-federation-requests';
import { resetAllSettingsStoresForTests } from './settings-store';
import { card, section } from './remote-details-presentation';
import { connectionSourceKind } from '../../shared/connection-sources';
import { mergeConnectionDirection } from '../../shared/remote-connections';
import { CONNECTION_SWITCHES } from '../../shared/connection-grants';
const selected = 'selected-agent', machine = 'aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa', own = 'own-pairing-1111', peer = 'peer-pairing-2222', at = '2026-11-19T00:00:00Z';
let root: string; const stops: Array<() => void> = [], stores = new Set<ReturnType<typeof createFederationRequestStore>>();
const wire = (agentId = selected, targetId = 'target-agent', extra: Record<string, unknown> = {}): PersistedBinding => ({ agentId, targetId, targetKind: 'agent', label: 'Target label', agentName: 'Source name', targetName: 'Target name', instructions: { '*': 'PRIVATE_INSTRUCTIONS' }, ...extra });
const put = (file: string, value: unknown) => fs.promises.writeFile(path.join(root, file), JSON.stringify(value));
const disk = async () => Object.fromEntries(await Promise.all((await fs.promises.readdir(root)).sort().map(async (name) => { const f = path.join(root, name), stat = await fs.promises.stat(f); return [name, { bytes: (await fs.promises.readFile(f)).toString('base64'), ino: stat.ino, mtimeMs: stat.mtimeMs }]; })));
const direction = (target = 'target-agent', foreign = false, extra: Record<string, unknown> = {}) => ({ from: { agentId: selected }, to: { agentId: target, ...(foreign && { machineId: machine }) }, disabledTools: [], link: { createdAt: at }, updatedAt: at, ...extra });
const read = async (dispatcher = false) => { const c = card('connections', 'Connections'), receipts: Array<{ current(): boolean }> = []; await section(c, () => readPassiveConnectionCard(c, selected, { receipts, authorized: () => true, dispatcher, name: 'Selected' })); return { c, receipts }; };
beforeEach(async () => { root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clubhouse-connection-card-'))); vi.spyOn(app, 'getPath').mockReturnValue(root); resetAllSettingsStoresForTests(); peers.resetForTests(); bindingManager._resetForTesting(); bindingManager.setConnectionToolsSource(null, null); bindingManager.setConnectionInstructionsSource(null); _resetPersistedBindingSourcesForTesting(); m.names.clear(); m.satellites.clear(); m.side.mockClear(); m.legacy.mockClear(); m.ownOn = false; });
afterEach(async () => { for (const stop of stops.splice(0)) stop(); stores.clear(); resetAllSettingsStoresForTests(); peers.resetForTests(); _resetPersistedBindingSourcesForTesting(); bindingManager._resetForTesting(); vi.restoreAllMocks(); await fs.promises.rm(root, { recursive: true, force: true }); });
it('projects actual selected binding/source/direction records without raw instructions, unrelated agents, legacy readers or writes', async () => {
  const collect = vi.fn(async () => [wire(), wire('sender-agent', selected), wire('PRIVATE_OTHER_AGENT', 'PRIVATE_OTHER_TARGET', { label: 'PRIVATE_OTHER_LABEL' })]); registerPersistedBindingSource({ id: 'orchestrator-connections', collect }); await rebuildPersistedBindings(); collect.mockClear();
  await put('connection-grants.json', { version: 1, directions: [direction('target-agent', false, { disabledTools: ['read_output'], PRIVATE_CONFIG: 'PRIVATE_CONFIG' })] });
  const before = await disk(), all = vi.spyOn(bindingManager, 'getAllBindings'), { c, receipts } = await read();
  expect.soft(c.state).toBe('ok'); expect.soft(c.rows.some((r) => r.label === 'Target name')).toBe(true); expect.soft(c.rows.find((r) => r.label === 'Target name outgoing switches')?.value).toContain('Off: Read output'); expect.soft(c.rows.some((r) => r.value.includes('Made by an agent'))).toBe(true);
  expect.soft(JSON.stringify(c)).not.toMatch(/PRIVATE_|instructions|rawConfig|publicKey|tlsCertificate/); expect.soft(receipts.every((r) => r.current())).toBe(true); expect.soft(all).not.toHaveBeenCalled(); expect.soft(collect).not.toHaveBeenCalled(); expect.soft(m.legacy).not.toHaveBeenCalled(); expect.soft(await disk()).toEqual(before);
});
it('matches local group naming order and never borrows this target’s label as an incoming sender name', async () => {
  bindingManager.bind(selected, { targetId: 'group', targetKind: 'group-project', label: 'Fallback group', targetName: 'Target role', projectName: 'Group public name' });
  bindingManager.bind('sender-agent', { targetId: selected, targetKind: 'agent', label: 'This selected target label' }); m.names.set('sender-agent', 'Sender cached name');
  bindingManager.bind('PRIVATE_WIDGET_OWNER', { targetId: selected, targetKind: 'browser', label: 'PRIVATE_WIDGET_LABEL' });
  const { c } = await read(); expect(c.rows.some((r) => r.label === 'Group public name')).toBe(true); expect(c.rows.some((r) => r.label === 'Sender cached name')).toBe(true); expect(JSON.stringify(c)).not.toMatch(/This selected target label|PRIVATE_WIDGET/);
});
it('keeps corrupt saved overrides unknown instead of claiming default allowed switches or recovering the file', async () => {
  bindingManager.bind(selected, wire()); bindingManager.setDisabledTools(selected, 'target-agent', [], ['wake_agent']); await fs.promises.writeFile(path.join(root, 'connection-grants.json'), '{broken'); await put('connection-grants.json.bak', { version: 1, directions: [direction()] }); const before = await disk(), { c } = await read();
  const text = c.rows.find((r) => r.label.endsWith('outgoing switches'))?.value; expect.soft(text).toContain('Saved override unavailable'); expect.soft(text).not.toContain('Allowed:'); expect.soft(await disk()).toEqual(before); expect(m.legacy).not.toHaveBeenCalled();
});
it('uses network wake defaults independently of the local opt-in flag', async () => {
  await put('connection-grants.json', { version: 1, directions: [direction('remote-target', true)] }); const { c } = await read(); const text = c.rows.find((r) => r.label.endsWith('outgoing switches'))!.value; const wake = CONNECTION_SWITCHES.find((t) => t.tool === 'wake_agent')!.label;
  expect(text.split('; Off:')[0]).toContain(wake); expect(text.split('; Off:')[1]).not.toContain(wake);
});
it('does not initialize cold corrupt credential/membership stores or run a cold saved source just for display', async () => {
  await put('connection-grants.json', { version: 1, directions: [direction('remote-target', true)] });
  for (const file of ['annex-peers.json', 'annex-network.json']) { await fs.promises.writeFile(path.join(root, file), '{broken'); await put(file + '.bak', { PRIVATE: 'PRIVATE_BACKUP' }); await fs.promises.writeFile(path.join(root, `.${file}.tmp-${process.pid + 100000}-1`), 'keep'); }
  const collect = vi.fn(async () => { fs.writeFileSync(path.join(root, 'unexpected-marker'), 'called'); return []; }); registerPersistedBindingSource({ id: 'cold-source', readOnlyCollect: true, collect, inspect: collect });
  const get = vi.spyOn(peers, 'getPeer'), list = vi.spyOn(peers, 'listPeers'), before = await disk(), { c } = await read();
  expect.soft(c.rows.some((r) => r.value.includes(`remote-target@${machine}`))).toBe(true); expect.soft(c.notes.join(' ')).toContain('partial or unavailable'); expect.soft(JSON.stringify(c)).not.toContain('PRIVATE_'); expect.soft(get).not.toHaveBeenCalled(); expect.soft(list).not.toHaveBeenCalled(); expect.soft(collect).not.toHaveBeenCalled(); expect.soft(await disk()).toEqual(before); expect(m.legacy).not.toHaveBeenCalled();
});
it.each(['binding', 'removal', 'reference-name', 'transport'])('retains actual selected display receipts through later %s change', async (change) => {
  if (change === 'reference-name' || change === 'transport') { await put('connection-grants.json', { version: 1, directions: [direction('remote-target', true)] }); m.names.set(`remote-target@${machine}`, 'Remote before'); m.satellites.set(machine, { alias: 'Desk', state: 'connected', snapshot: null }); }
  else { registerPersistedBindingSource({ id: 'source', collect: async () => [] }); await rebuildPersistedBindings(); claimSourceBinding('source', wire()); }
  const { c, receipts } = await read(); expect(receipts.every((r) => r.current())).toBe(true); expect(c.rows.length).toBeGreaterThan(0);
  if (change === 'binding') bindingManager.updateBinding(selected, 'target-agent', { targetName: 'Changed target' }); if (change === 'removal') markSourceRemovedByUser('source', selected, 'target-agent'); if (change === 'reference-name') m.names.set(`remote-target@${machine}`, 'Remote after'); if (change === 'transport') m.satellites.set(machine, { alias: 'Desk', state: 'disconnected', snapshot: null });
  expect(receipts.some((r) => !r.current())).toBe(true);
});
it('rejects an inconsistent unscoped reader reply before any unrelated row is emitted', async () => {
  vi.spyOn(bindingManager, 'readBindingsForDisplay').mockReturnValue({ state: 'ok', inputs: [], value: { rows: [{ agentId: 'PRIVATE_UNRELATED_OWNER', targetId: 'PRIVATE_UNRELATED_TARGET', targetKind: 'agent', label: { state: 'ok', value: 'PRIVATE_UNRELATED_LABEL', inputs: [] } } as never], total: 1, offset: 0, omitted: 0, nextOffset: null } });
  const { c } = await read(); expect.soft(c.state).toBe('error'); expect.soft(c.rows).toEqual([]); expect.soft(JSON.stringify(c)).not.toContain('PRIVATE_');
});
async function federation(target = 'remote-controller', publishedTarget = target) {
  await put('annex-peers.json', [{ fingerprint: machine, alias: 'Peer', role: 'member', kind: 'desktop', pairingId: peer, pairedAt: at, lastSeen: at, tlsCertificateFingerprint: 'PRIVATE_PIN', tlsCertificatePem: 'PRIVATE_CERT', publicKey: 'PRIVATE_KEY' }]); const held = peers.listPeers()[0];
  await put('annex-network.json', { removals: [], confirmations: {}, renamedAt: {}, removedNames: {}, selfPairing: { id: own, joinedAt: at } }); membership.ownPairing();
  await put('dispatcher-federation.json', { controllers: { [machine]: { agentId: publishedTarget, name: 'Dispatcher controller', displayName: publishedTarget === target ? 'Remote controller' : 'PRIVATE_UNRELATED_CONTROLLER', enabled: false, state: 'asleep', ownPairingId: own, pairingId: peer } } });
  await put('connection-grants.json', { version: 1, directions: [direction(target, true, { disabledTools: [] })] });
  await put('dispatcher-federation-requests.json', { version: 1, requests: [], paused: { [machine]: 'Wait for operator' }, pauseEpochs: { [machine]: { sender: own, receiver: peer } }, crossings: {} });
  const store = createFederationRequestStore(); stores.add(store); store.get(); const legacy = vi.fn(m.legacy); const stop = setFederationRequestRouter({ readPauseForDisplay: store.readPauseForDisplay, offer: legacy, allowed: legacy, pauseReason: legacy, before: legacy, cause: legacy } as never); stops.push(stop);
  return { held, store, legacy, stop };
}
it.each(['pin', 'router', 'publication', 'local-switch'])('uses actual recorded controller/pause evidence and retains independent %s receipts', async (change) => {
  const f = await federation(); const get = vi.spyOn(peers, 'getPeer'), list = vi.spyOn(peers, 'listPeers'), ownReader = vi.spyOn(membership, 'ownPairing'), before = await disk(), { c, receipts } = await read(true);
  expect.soft(c.rows.find((r) => r.label.endsWith('network record'))?.value).toContain('Recorded Dispatcher: Remote controller · Off · published presence: asleep · pause recorded: Wait for operator'); expect.soft(receipts.every((r) => r.current())).toBe(true); expect.soft(JSON.stringify(c)).not.toMatch(/PRIVATE_|pairing-1111|pairing-2222|sender|receiver/); expect.soft(get).not.toHaveBeenCalled(); expect.soft(list).not.toHaveBeenCalled(); expect.soft(ownReader).not.toHaveBeenCalled(); expect.soft(f.legacy).not.toHaveBeenCalled(); expect.soft(await disk()).toEqual(before);
  if (change === 'pin') f.held.tlsCertificateFingerprint = 'PRIVATE_NEW_PIN'; if (change === 'router') stops.push(setFederationRequestRouter({ readPauseForDisplay: f.store.readPauseForDisplay } as never)); if (change === 'publication') await put('dispatcher-federation.json', { controllers: {} }); if (change === 'local-switch') m.ownOn = true;
  expect(receipts.some((r) => !r.current())).toBe(true);
});
it('does not serialize another controller’s publication when the selected target identity differs', async () => { await federation('remote-agent', 'different-controller'); const { c } = await read(true); expect.soft(c.rows.find((r) => r.label.endsWith('network record'))?.value).toContain('association unavailable'); expect.soft(JSON.stringify(c)).not.toContain('PRIVATE_UNRELATED_CONTROLLER'); });
it('shows fixed network namespace records instead of treating an ordinary saved override as effective', async () => {
  const address = `remote-controller@${machine}`; registerPersistedBindingSource({ id: 'dispatcher-federation', collect: async () => [wire(selected, address, { disabledTools: ['read_output', 'wake_agent'] })] }); await rebuildPersistedBindings(); await put('connection-grants.json', { version: 1, directions: [direction('remote-controller', true, { disabledTools: [] })] });
  const { c } = await read(); const text = c.rows.find((r) => r.label.endsWith('outgoing switches'))?.value; expect.soft(text).toContain('Fixed network namespace (retained)'); expect.soft(text?.split('; Off:')[1]).toContain('Read output'); expect.soft(text?.split('; Off:')[1]).toContain('Wake it');
});

it('keeps cold source coverage unknown instead of presenting a verified empty Connections list', async () => { const { c } = await read(); expect(c.state).toBe('error'); expect(c.summary).toBe('Connection information incomplete'); expect(c.notes.join(' ')).toContain('Saved source coverage is unavailable'); expect(c.notes.join(' ')).not.toContain('No binding or active saved direction was reported'); });
it('preserves row and reader omissions without querying omitted target names or hosts', async () => {
  for (let i = 0; i < 70; i++) bindingManager.bind(selected, { targetId: `target-${i}`, targetKind: 'agent', label: `Target ${i}` });
  const { c } = await read(); expect(c.rows.length).toBe(100); expect(c.omitted).toBeGreaterThan(0); expect(c.notes.join(' ')).toContain('20 additional outgoing bindings are outside this bounded page'); expect(c.summary).toBe('50 known directions');
});

it('uses shared local source identities and keeps unknown prototype-shaped source IDs unclassified', () => { expect(connectionSourceKind('connections-card')).toBe('card_link'); expect(connectionSourceKind('dispatcher-federation')).toBe('dispatcher_federation'); expect(connectionSourceKind('constructor')).toBe('other'); expect(connectionSourceKind('__proto__')).toBe('other'); expect(mergeConnectionDirection(mergeConnectionDirection('to', 'from'), 'from')).toBe('two-way'); });
it('refuses revoked admission before reading any selected binding or primary file', async () => { const binding = vi.spyOn(bindingManager, 'readBindingsForDisplay'), c = card('connections', 'Connections'); await expect(readPassiveConnectionCard(c, selected, { receipts: [], authorized: () => false })).rejects.toThrow('revoked'); expect(binding).not.toHaveBeenCalled(); expect(c.rows).toEqual([]); });

it.each(['typed-incoming', 'unbound-incoming', 'widget-and-unrelated'] as const)('preserves independently known Connections when selected source originals hit their limit: %s', async (mode) => {
  const rows = Array.from({ length: 5 }, (_, i) => Array.from({ length: 100 }, () => wire(selected, `target-${i}`, { targetName: `Known target ${i}`, instructions: { '*': 'PRIVATE_SOURCE_TEXT' } }))).flat();
  rows.push(...Array.from({ length: 100 }, () => wire('sender-agent', selected, { agentName: 'Known incoming sender', label: 'Selected target label' })));
  if (mode === 'widget-and-unrelated') {
    rows.push(...Array.from({ length: 100 }, () => wire('PRIVATE_WIDGET_OWNER', selected, { targetKind: 'browser', label: 'PRIVATE_WIDGET_LABEL' })));
    rows.push(...Array.from({ length: 100 }, () => wire('PRIVATE_OTHER_OWNER', 'PRIVATE_OTHER_TARGET', { targetName: 'PRIVATE_OTHER_LABEL' })));
  }
  const collect = vi.fn(async () => rows); registerPersistedBindingSource({ id: 'orchestrator-connections', collect }); await rebuildPersistedBindings(); collect.mockClear();
  if (mode === 'unbound-incoming') bindingManager.unbind('sender-agent', selected);
  const outgoing = bindingManager.readBindingsForDisplay(selected, { direction: 'outgoing' }), incoming = bindingManager.readBindingsForDisplay(selected, { direction: 'incoming' });
  expect(outgoing).toMatchObject({ state: 'ok', value: { total: 5 } }); expect(incoming).toMatchObject({ state: 'ok', value: { total: mode === 'unbound-incoming' ? 0 : 1 } });
  const cached = readCachedConnectionSourcesForDisplay(selected); expect(cached.state).toBe('ok');
  if (cached.state !== 'ok') throw new Error('Fixture did not establish source evidence');
  expect(cached.value.pairs).toHaveLength(6); expect(cached.value.pairs.find((p) => p.agentId === 'sender-agent')?.sources[0].binding).toMatchObject({ state: 'unavailable', reason: 'limit' });
  expect(cached.value.pairs.filter((p) => p.agentId === selected).every((p) => p.sources[0].binding.state === 'ok')).toBe(true);
  const { c, receipts } = await read();
  expect.soft(c.state).toBe('ok');
  for (let i = 0; i < 5; i++) expect.soft(c.rows.some((row) => row.label === `Known target ${i}`)).toBe(true);
  if (mode !== 'unbound-incoming') expect.soft(c.rows.some((row) => row.label === 'Known incoming sender')).toBe(true);
  expect.soft(c.notes.join(' ')).toContain('Details unavailable for 1 retained source record');
  if (mode === 'unbound-incoming') { expect.soft(c.notes.join(' ')).toContain('an independently admitted target kind'); expect.soft(c.rows.some((row) => row.label === 'Known incoming sender')).toBe(false); }
  else expect.soft(c.rows.find((row) => row.label === 'Known incoming sender sources')?.value).toContain('details unavailable');
  expect.soft(JSON.stringify(c)).not.toMatch(/PRIVATE_|Selected target label/); expect.soft(collect).not.toHaveBeenCalled(); expect.soft(receipts.every((receipt) => receipt.current())).toBe(true);
});

it.each([true, false])('does not guess incoming widget identity from an untyped source field result with known rows=%s', async (hasKnown) => {
  if (hasKnown) bindingManager.bind(selected, { targetId: 'known', targetKind: 'agent', label: 'Known connection' });
  // A defensive internal-contract negative, separate from the actual-API
  // budget controls above: unknown source fields must not become an agent.
  const module = await import('./persisted-bindings');
  vi.spyOn(module, 'readCachedConnectionSourcesForDisplay').mockReturnValue({ state: 'ok', inputs: [], value: { scope: 'registered-cache-only', complete: true, sourceStates: [{ sourceId: 'canvas-wires', state: 'known' }], pairs: [{ agentId: 'PRIVATE_WIDGET_OWNER', targetId: selected, sources: [{ sourceId: 'canvas-wires', provenance: 'last-reconciled', verified: false, removedByUser: false, copies: 1, binding: { state: 'unavailable', inputs: [], reason: 'limit' } }] }], total: 1, offset: 0, omitted: 0, nextOffset: null } });
  const { c } = await read(); expect.soft(c.state).toBe(hasKnown ? 'ok' : 'error'); expect.soft(c.rows.some((row) => row.label === 'Known connection')).toBe(hasKnown); expect.soft(c.notes.join(' ')).toContain('an independently admitted target kind'); expect.soft(JSON.stringify(c)).not.toContain('PRIVATE_WIDGET_OWNER');
});
