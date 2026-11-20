import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
const m = vi.hoisted(() => ({ base: '', failPendingSave: false, names: new Map<string, string>(), satellites: new Map<string, Record<string, unknown>>(), side: vi.fn(), legacy: vi.fn(() => { throw new Error('legacy side-effectful reader'); }), ownOn: false }));
// Real temporary files, with an explicit modeled rename refusal only while
// deliberately creating the owner's unsaved pending state during setup.
vi.mock('fs/promises', async (original) => { const actual = await original<typeof import('fs/promises')>(); return { ...actual, rename: vi.fn((...args: Parameters<typeof actual.rename>) => m.failPendingSave && String(args[1]).endsWith('dispatcher-connections.pending-removals.json') ? Promise.reject(new Error('fixture rejects pending save')) : actual.rename(...args)) }; });
vi.mock('./base-dir', () => ({ getBaseDirPath: () => m.base }));
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
import { recordUserRemoval, _resetDispatcherConnectionsForTesting } from './dispatcher-connections';
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
const disk = async (folder = root): Promise<unknown> => Object.fromEntries(await Promise.all((await fs.promises.readdir(folder)).sort().map(async (name) => { const f = path.join(folder, name), stat = await fs.promises.stat(f); return [name, stat.isDirectory() ? { ino: stat.ino, children: await disk(f) } : { bytes: (await fs.promises.readFile(f)).toString('base64'), ino: stat.ino, mtimeMs: stat.mtimeMs }]; })));
const direction = (target = 'target-agent', foreign = false, extra: Record<string, unknown> = {}) => ({ from: { agentId: selected }, to: { agentId: target, ...(foreign && { machineId: machine }) }, disabledTools: [], link: { createdAt: at }, updatedAt: at, ...extra });
const read = async (dispatcher = false, extra: Partial<Parameters<typeof readPassiveConnectionCard>[2]> = {}) => { const c = card('connections', 'Connections'), receipts: Array<{ current(): boolean }> = []; await section(c, () => readPassiveConnectionCard(c, selected, { receipts, authorized: () => true, dispatcher, name: 'Selected', ...extra })); return { c, receipts }; };
beforeEach(async () => { root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clubhouse-connection-card-'))); vi.spyOn(app, 'getPath').mockReturnValue(root); m.base = root; m.failPendingSave = false; _resetDispatcherConnectionsForTesting(); resetAllSettingsStoresForTests(); peers.resetForTests(); bindingManager._resetForTesting(); bindingManager.setConnectionToolsSource(null, null); bindingManager.setConnectionInstructionsSource(null); _resetPersistedBindingSourcesForTesting(); m.names.clear(); m.satellites.clear(); m.side.mockClear(); m.legacy.mockClear(); m.ownOn = false; });
afterEach(async () => { _resetDispatcherConnectionsForTesting(); for (const stop of stops.splice(0)) stop(); stores.clear(); resetAllSettingsStoresForTests(); peers.resetForTests(); _resetPersistedBindingSourcesForTesting(); bindingManager._resetForTesting(); vi.restoreAllMocks(); await fs.promises.rm(root, { recursive: true, force: true }); });
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

it.each(['saved', 'unqualified-cached-name', 'pending-not-saved', 'owner-saved-copy-missing', 'override-present', 'override-unavailable', 'primary-unavailable', 'owner-unavailable', 'primary-late', 'owner-late'] as const)('composes cold saved Dispatcher records and independent owner evidence: %s', async (mode) => {
  const projectPath = path.join(root, 'selected-project'), file = 'dispatcher-connections.json', pending = 'dispatcher-connections.pending-removals.json';
  const link = { agentId: selected, targetId: 'manual-target', agentProjectPath: projectPath, targetProjectPath: '/other-project', createdAt: at, createdBy: 'controller', PRIVATE_ARGS: 'PRIVATE_CONFIG' };
  const putLinks = (version = 1, targetId = 'manual-target') => put(file, { version, connections: [{ ...link, targetId }], removedByUser: [] });
  if (mode === 'pending-not-saved') {
    await putLinks(2); m.failPendingSave = true;
    expect(await recordUserRemoval({ agentId: selected, targetId: 'manual-target' })).toBe(true); m.failPendingSave = false; await putLinks();
  } else if (mode === 'owner-saved-copy-missing') {
    await putLinks(2); expect(await recordUserRemoval({ agentId: selected, targetId: 'manual-target' })).toBe(true); await putLinks(); await fs.promises.unlink(path.join(root, pending));
  } else if (mode === 'primary-unavailable') {
    bindingManager.bind(selected, wire()); await fs.promises.writeFile(path.join(root, file), '{broken');
  } else await putLinks();
  if (mode === 'override-present') await put('connection-grants.json', { version: 1, directions: [{ from: { agentId: selected }, to: { agentId: 'manual-target' }, disabledTools: ['read_output'], enabledTools: ['wake_agent'] }] });
  if (mode === 'override-unavailable') await fs.promises.writeFile(path.join(root, 'connection-grants.json'), '{broken');
  if (mode === 'owner-unavailable') { const owner = await import('./dispatcher-connections'); vi.spyOn(owner, 'readDispatcherLinkMemoryForDisplay').mockImplementation(() => { throw new Error('PRIVATE_OWNER_ERROR'); }); }
  if (mode === 'unqualified-cached-name') m.names.set('manual-target', 'PRIVATE_REUSED_ID_NAME');
  const nameRead = mode === 'unqualified-cached-name' ? vi.spyOn(m.names, 'get') : undefined;
  m.side.mockClear(); m.legacy.mockClear(); const before = await disk(), { c, receipts } = await read(false, { projectPath, connectToDispatcher: { state: 'ok', value: false, inputs: [] } });
  expect.soft(c.state).toBe('ok'); expect.soft(JSON.stringify(c)).not.toMatch(/PRIVATE_|agentProjectPath|targetProjectPath|createdBy|"current"\s*:|receipts/);
  if (mode === 'primary-unavailable') {
    expect.soft(c.rows.some((row) => row.label === 'Target name')).toBe(true); expect.soft(c.notes.join(' ')).toContain('Saved manual Dispatcher link metadata is unavailable');
  } else {
    expect.soft(c.rows.some((row) => row.label === 'manual-target')).toBe(true);
    expect.soft(c.rows.find((row) => row.label === 'manual-target sources')?.value).toContain('Made by the Dispatcher (saved record');
    const removal = c.rows.find((row) => row.label === 'manual-target saved Dispatcher link')?.value;
    expect.soft(removal).toBe('No removal record in saved settings');
    const availability = c.rows.find((row) => row.label === 'manual-target Dispatcher availability')?.value;
    if (mode === 'pending-not-saved') expect.soft(availability).toContain('Removal queued; last save failed');
    if (mode === 'owner-saved-copy-missing') expect.soft(availability).toContain('Removal queued; save was reported successful');
    if (mode === 'owner-unavailable') expect.soft(availability).toContain('File-save status unavailable');
    if (mode === 'owner-unavailable') expect.soft(availability).toContain('Queued removal status unavailable');
    expect.soft(c.rows.find((row) => row.label === 'manual-target Dispatcher availability')?.value).toContain('This agent’s Connect to Dispatcher is off');
    if (mode === 'saved') expect.soft(c.rows.find((row) => row.label === 'manual-target outgoing switches')?.value).toContain('Configured manual link defaults');
    const switches = c.rows.find((row) => row.label === 'manual-target outgoing switches')?.value;
    if (mode === 'override-present') { expect.soft(switches?.split('; Off:')[0]).toContain('Wake it'); expect.soft(switches?.split('; Off:')[1]).toContain('Read output'); }
    if (mode === 'override-unavailable') { expect.soft(switches).toContain('Saved override unavailable'); expect.soft(switches).not.toContain('Configured manual link defaults'); }

  }
  if (mode === 'unqualified-cached-name') { expect.soft(nameRead).not.toHaveBeenCalled(); expect.soft(c.notes.join(' ')).toContain('current project identity is not confirmed'); }
  expect.soft(receipts.every((receipt) => receipt.current())).toBe(true); expect.soft(m.legacy).not.toHaveBeenCalled(); expect.soft(m.side).not.toHaveBeenCalled(); expect.soft(await disk()).toEqual(before);
  if (mode === 'primary-late') { await putLinks(1, 'changed-target'); expect(receipts.some((receipt) => !receipt.current())).toBe(true); }
  if (mode === 'owner-late') { await putLinks(2); expect(await recordUserRemoval({ agentId: selected, targetId: 'manual-target' })).toBe(true); await putLinks(); expect(receipts.some((receipt) => !receipt.current())).toBe(true); }
});

it.each(['dispatcher', 'helper'] as const)('does not adopt manual Dispatcher-link records for the locally inapplicable %s role', async (role) => {
  const projectPath = path.join(root, 'selected-project'); await put('dispatcher-connections.json', { version: 1, connections: [{ agentId: selected, targetId: 'PRIVATE_INAPPLICABLE_TARGET', agentProjectPath: projectPath, targetProjectPath: '/other-project', createdAt: at, createdBy: 'controller' }], removedByUser: [] });
  const saved = await import('./dispatcher-saved-links-display'), owner = await import('./dispatcher-connections');
  const savedRead = vi.spyOn(saved, 'readSavedDispatcherLinksForDisplay'), memoryRead = vi.spyOn(owner, 'readDispatcherLinkMemoryForDisplay');
  const { c } = await read(role === 'dispatcher', { projectPath, ...(role === 'helper' ? { family: { parentId: 'parent-agent', helperIds: new Set<string>() } } : {}) });
  expect.soft(savedRead).not.toHaveBeenCalled(); expect.soft(memoryRead).not.toHaveBeenCalled(); expect.soft(JSON.stringify(c)).not.toContain('PRIVATE_INAPPLICABLE_TARGET');
});

it('keeps an unavailable cold manual source distinct from a complete retained empty cache', async () => {
  const collect = vi.fn(async () => []); registerPersistedBindingSource({ id: 'established-source', collect }); await rebuildPersistedBindings(); collect.mockClear();
  await fs.promises.writeFile(path.join(root, 'dispatcher-connections.json'), '{broken'); const { c } = await read(false, { projectPath: path.join(root, 'selected-project') });
  expect.soft(c.state).toBe('error'); expect.soft(c.summary).toBe('Connection information incomplete'); expect.soft(c.notes.join(' ')).not.toContain('No binding or active saved direction was reported'); expect.soft(collect).not.toHaveBeenCalled();
});
it('keeps cold manual source page and row omissions visible', async () => {
  const projectPath = path.join(root, 'selected-project'); await put('dispatcher-connections.json', { version: 1, connections: Array.from({ length: 51 }, (_, i) => ({ agentId: selected, targetId: `manual-${i}`, agentProjectPath: projectPath, targetProjectPath: '/other-project', createdAt: at, createdBy: 'controller' })), removedByUser: [] });
  const { c, receipts } = await read(false, { projectPath }); expect.soft(c.rows).toHaveLength(100); expect.soft(c.omitted).toBeGreaterThan(0); expect.soft(c.notes.join(' ')).toContain('1 additional saved Dispatcher link is outside this bounded page'); expect.soft(receipts.every((receipt) => receipt.current())).toBe(true);
});

it.each(['on', 'off', 'unknown-controller', 'unknown-name', 'saved-override', 'unreadable-override', 'mixed-source'] as const)('shows selected configured automatic Dispatcher directions without collecting sources: %s', async (mode) => {
  const { configuredDispatcherDirections } = await import('./configured-dispatcher-directions'); m.ownOn = mode !== 'off';
  let armed = false; const collect = vi.fn(async () => { if (armed) fs.writeFileSync(path.join(root, 'unexpected-marker'), 'called'); return []; }); stops.push(registerPersistedBindingSource({ id: 'dispatcher-wires', collect, inspect: collect }));
  if (mode === 'unknown-controller') { await rebuildPersistedBindings(); expect(collect).toHaveBeenCalledTimes(1); collect.mockClear(); expect(readCachedConnectionSourcesForDisplay(selected)).toMatchObject({ state: 'ok', value: { complete: true, total: 0 } }); }
  armed = true;
  if (mode === 'saved-override') await put('connection-grants.json', { version: 1, directions: [direction('controller', false, { disabledTools: ['read_output'] })] });
  if (mode === 'unreadable-override') await fs.promises.writeFile(path.join(root, 'connection-grants.json'), '{broken');
  if (mode === 'mixed-source') bindingManager.bind(selected, { targetId: 'controller', targetKind: 'agent', label: 'Bound controller name' });
  if (mode === 'unknown-name') m.names.set('controller', 'PRIVATE_UNQUALIFIED_NAME');
  const automatic = configuredDispatcherDirections({ id: selected, name: 'Selected custom name' }, { state: 'ok', value: true, inputs: [] }, mode === 'unknown-controller' ? undefined : { id: 'controller', name: mode === 'unknown-name' ? undefined : 'Admitted controller' });
  const before = await disk(), { c, receipts } = await read(false, { automatic });
  if (mode === 'unknown-controller') { expect.soft(c.rows).toHaveLength(0); expect.soft(c.state).toBe('error'); expect.soft(c.notes.join(' ')).toContain('Automatic Dispatcher source details are unavailable'); expect.soft(c.notes.join(' ')).not.toContain('No binding or active saved direction'); }
  else {
    const separateNative = mode === 'mixed-source' || mode === 'saved-override';
    const name = mode === 'unknown-name' ? 'controller' : separateNative ? 'Admitted controller (automatic Dispatcher)' : 'Admitted controller';
    expect(c.rows.some((r) => r.label === name && r.value.includes('two-way records'))).toBe(true);
    const switches = c.rows.find((r) => r.label === name + ' outgoing switches')?.value;
    expect.soft(switches).toContain(separateNative ? 'switch association is unconfirmed' : mode === 'unreadable-override' ? 'Saved override unavailable' : 'Configured automatic link defaults');
    if (separateNative) {
      const native = mode === 'mixed-source' ? 'Bound controller name (native-ID records)' : 'controller (native-ID records)';
      expect.soft(c.rows.some((r) => r.label === native && r.value.includes('outgoing') && !r.value.includes('two-way records'))).toBe(true);
      const nativeSwitches = c.rows.find((r) => r.label === native + ' outgoing switches')?.value;
      expect.soft(nativeSwitches).toContain(mode === 'mixed-source' ? 'Binding record' : 'Saved · Allowed:');
      if (mode === 'saved-override') expect.soft(nativeSwitches?.split('; Off:')[1]).toContain('Read output');
    }
    expect.soft(c.rows.filter((r) => r.label.endsWith('automatic starting switches'))).toHaveLength(2); expect.soft(c.rows.find((r) => r.label === 'Host Dispatcher')?.value).toBe(mode === 'off' ? 'Off' : 'On'); expect.soft(c.notes.join(' ')).toContain('do not establish current bindings');
  }
  expect.soft(JSON.stringify(c)).not.toContain('PRIVATE_'); expect.soft(collect).not.toHaveBeenCalled(); expect.soft(m.legacy).not.toHaveBeenCalled(); expect.soft(await disk()).toEqual(before); expect.soft(receipts.every((r) => r.current())).toBe(true);
});

it('charges automatic source fields even when known binding rows fill the displayed page', async () => {
  const { configuredDispatcherDirections } = await import('./configured-dispatcher-directions');
  for (let i = 0; i < 34; i++) bindingManager.bind(selected, { targetId: 'terminal-' + i, targetKind: 'terminal', label: 'Bound terminal ' + i });
  const automatic = configuredDispatcherDirections({ id: selected, name: 'Selected' }, { state: 'ok', value: true, inputs: [] }, { id: 'controller', name: 'Admitted controller' });
  const before = await disk(), { c } = await read(false, { automatic });
  expect.soft(c.rows).toHaveLength(100); expect.soft(c.omitted).toBe(12); // 2 host + 34×3 binding + 2×4 automatic fields.
  expect.soft(c.rows.some((r) => r.label.endsWith('automatic starting switches'))).toBe(false); expect.soft(m.legacy).not.toHaveBeenCalled(); expect.soft(await disk()).toEqual(before);
});

it('continues actual outgoing binding records without dropping late fields behind the Details row cap', async () => {
  for (let i = 0; i < 41; i++) bindingManager.bind(selected, { targetId: 'terminal-' + i, targetKind: 'terminal', label: 'Bound terminal ' + i });
  const first = await read(false, { page: { card: 'connections', source: 'outgoing', offset: 0 } });
  expect(first.c.connectionPage).toMatchObject({ source: 'outgoing', offset: 0, known: 41, next: { offset: 8, projectOffset: 0 } });
  expect(first.c.rows).toHaveLength(24); expect(first.c.omitted).toBe(0);
  const last = await read(false, { page: { card: 'connections', source: 'outgoing', offset: 40 } });
  expect(last.c.connectionPage).toMatchObject({ known: 41, next: null }); expect(last.c.rows[0].label).toBe('Bound terminal 40'); expect(last.c.omitted).toBe(0);
  expect([...first.receipts, ...last.receipts].every((r) => r.current())).toBe(true);
});
it('renders project-qualified configured helpers independently of colliding native binding names and private paths', async () => {
  const { readConfiguredRegisteredConnectionsForDisplay } = await import('./configured-registered-connections-display');
  const { projectConnectionEndpointFieldsForDisplay } = await import('./connection-endpoint-fields-display');
  const p = path.join(root, 'project'); await fs.promises.mkdir(path.join(p, '.clubhouse'), { recursive: true });
  await put('projects.json', { version: 1, projects: [{ id: 'p', name: 'Custom project', path: p }] });
  const config = { id: selected, name: 'Selected' }, child = { id: 'reused', name: 'Saved helper name', parentAgentId: selected };
  await fs.promises.writeFile(path.join(p, '.clubhouse', 'agents.json'), JSON.stringify([config, child]));
  const fields = projectConnectionEndpointFieldsForDisplay(selected, config); if (fields.state !== 'ok') throw new Error('fixture');
  const receipts: Array<{ current(): boolean }> = [], registered = readConfiguredRegisteredConnectionsForDisplay({ agentId: selected, projectId: 'p', projectPath: p, fields: fields.value, receipt: { current: () => true } }, 'helper-children', { authorized: () => true, receipts });
  expect(registered.state).toBe('ok'); bindingManager.bind(selected, { targetId: 'reused', targetKind: 'agent', label: 'PRIVATE_NATIVE_COLLISION' });
  const before = await disk(), result = await read(false, { page: { card: 'connections', source: 'helpers' }, registered });
  expect(result.c.connectionPage).toMatchObject({ source: 'helpers', known: 1, complete: true, next: null });
  expect(result.c.rows[0]).toMatchObject({ label: 'Saved helper name · Custom project', value: expect.stringContaining('project p') });
  expect(result.c.rows.filter((r) => r.label.endsWith('starting switches'))).toHaveLength(2); expect(JSON.stringify(result.c)).not.toMatch(/PRIVATE_|namespace|projectPath/); expect(JSON.stringify(result.c)).not.toContain(root); expect(await disk()).toEqual(before);
});

it.each(['canvas', 'zone'] as const)('renders independently qualified saved %s records without effective switches or raw definitions', async (source) => {
  const { readSavedCanvasConnectionsForDisplay } = await import('./saved-canvas-connections-display'), folder = path.join(root, 'selected'), other = path.join(root, 'other');
  for (const f of [folder, other]) await fs.promises.mkdir(path.join(f, '.clubhouse'), { recursive: true }); await put('projects.json', { version: 1, projects: [{ id: 'a', name: 'Source project', path: folder }, { id: 'b', name: 'Target project', path: other }] });
  await fs.promises.writeFile(path.join(folder, '.clubhouse', 'agents.json'), JSON.stringify([{ id: selected, name: 'Selected' }])); await fs.promises.writeFile(path.join(other, '.clubhouse', 'agents.json'), JSON.stringify([{ id: 'other', name: 'Qualified other' }]));
  const dir = path.join(folder, '.clubhouse', 'plugin-data-local', 'canvas', 'kv'); await fs.promises.mkdir(dir, { recursive: true }); await fs.promises.writeFile(path.join(dir, 'canvas-instances.json'), JSON.stringify([{ id: 'canvas', views: [{ id: 's', type: 'agent', agentId: selected, projectId: 'a' }, { id: 'o', type: 'agent', agentId: 'other', projectId: 'b' }, { id: 'z', type: 'zone', containedViewIds: ['s'] }] }]));
  await fs.promises.writeFile(path.join(dir, source === 'canvas' ? 'canvas-wires.json' : 'canvas-zone-wires.json'), JSON.stringify(source === 'canvas' ? [{ agentId: selected, targetId: 'other', targetKind: 'agent', label: 'Saved label', instructions: { '*': 'PRIVATE_INSTRUCTIONS' } }] : [{ id: 'zw', sourceZoneId: 'z', targetId: 'other', targetType: 'agent' }]));
  const receipts: Array<{ current(): boolean }> = [], canvas = readSavedCanvasConnectionsForDisplay({ agentId: selected, projectId: 'a', projectPath: folder, receipt: { current: () => true } }, source, { authorized: () => true, receipts }); const before = await disk();
  const result = await read(false, { canvas, page: { card: 'connections', source: source === 'canvas' ? 'canvas-records' : 'zone-records' }, receipts });
  expect(result.c.state).toBe('ok'); expect(result.c.rows.some((r) => r.label === 'Qualified other · Source project')).toBe(true); expect(result.c.rows.some((r) => r.value.includes('current eligibility unconfirmed'))).toBe(true); expect(result.c.rows.some((r) => r.value.includes('No starting switch list saved'))).toBe(true); expect(result.c.rows.some((r) => r.value.includes('On:'))).toBe(false); expect(JSON.stringify(result.c)).not.toMatch(/PRIVATE_|instructions|projectPath/); expect(await disk()).toEqual(before); expect(receipts.every((r) => r.current())).toBe(true);
});
