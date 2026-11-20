import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as sync from 'fs';
import * as os from 'os';
import * as path from 'path';
const m = vi.hoisted(() => ({ home: '', allowed: true }));
vi.mock('electron', () => ({ app: { getPath: () => m.home, isPackaged: false } }));
vi.mock('fs', async (original) => { const actual = await original<typeof import('fs')>(); return { ...actual, readFileSync: vi.fn(actual.readFileSync), writeFileSync: vi.fn(actual.writeFileSync), copyFileSync: vi.fn(actual.copyFileSync) }; });
vi.mock('./project-store', () => { throw new Error('Ordinary project owner must not load'); });
vi.mock('./agent-config', () => { throw new Error('Ordinary agent owner must not load'); });
vi.mock('./group-project-host', () => { throw new Error('Operational group host must not load'); });
vi.mock('./group-project-membership', () => { throw new Error('Operational membership resolution must not load'); });
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('../telemetry/annex-telemetry', () => ({ recordIdentityRegenerated: vi.fn() }));
import { getBaseDirPath } from './base-dir';
import { readSavedGroupConnectionsForDisplay as read } from './saved-group-connections-display';
import { projectConnectionEndpointFieldsForDisplay } from './connection-endpoint-fields-display';
import { captureReadOnlyAgentTargetWitness } from './read-only-agent-target-witness';
import { getIdentity, resetForTests } from './annex-identity';
let root: string, a: string, groupDir: string;
const fp = 'aa:'.repeat(15) + 'aa', other = 'bb:'.repeat(15) + 'bb';
const group = (id = 'group', extra = {}) => ({ id, name: 'Selected group ' + id, createdAt: '2026-11-20', scope: { level: 'project', projectId: 'a', reach: 'local' }, metadata: {}, ...extra });
const member = (extra = {}) => ({ address: 'selected', kind: 'durable', projectId: 'a', addedAt: '2026-11-20', ...extra });
const membership = (extra = {}) => ({ version: 1, autoJoin: false, explicit: [member()], excluded: [], ...extra });
const putRegistry = (rows: unknown[]) => fs.writeFile(path.join(groupDir, 'registry.json'), JSON.stringify(rows));
const put = async (id: string, data: unknown) => { const folder = path.join(groupDir, id); await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, 'membership.json'), JSON.stringify(data)); };
async function selected(extra = {}) {
  const raw = { id: 'selected', name: 'Selected', ...extra }; await fs.writeFile(path.join(a, '.clubhouse', 'agents.json'), JSON.stringify([raw])); const fields = projectConnectionEndpointFieldsForDisplay(raw.id, raw); if (fields.state !== 'ok') throw new Error('fixture');
  const target = { agent: raw, project: { id: 'a', name: 'Selected project', path: a } } as unknown as import('./agent-config-reader').AgentConfigTarget, receipt = captureReadOnlyAgentTargetWitness(target); expect(receipt.current()).toBe(true);
  return { agentId: raw.id, projectId: 'a', projectPath: a, receipt, fields: fields.value };
}
const warm = async (fingerprint = fp) => { await fs.writeFile(path.join(root, 'annex-identity.json'), JSON.stringify({ publicKey: 'PRIVATE_PUBLIC_FIXTURE', privateKey: 'PRIVATE_KEY_FIXTURE', fingerprint, createdAt: '2026-11-20' })); expect(getIdentity()?.fingerprint).toBe(fingerprint); vi.mocked(sync.readFileSync).mockClear(); vi.mocked(sync.writeFileSync).mockClear(); vi.mocked(sync.copyFileSync).mockClear(); };
const disk = async (folder = root): Promise<unknown> => Object.fromEntries(await Promise.all((await fs.readdir(folder)).sort().map(async (name) => { const p = path.join(folder, name), s = await fs.lstat(p); return [name, s.isDirectory() ? { ino: s.ino, contents: await disk(p) } : { ino: s.ino, mtimeMs: s.mtimeMs, bytes: (await fs.readFile(p)).toString('base64') }]; })));
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-saved-group-'))); m.home = root; m.allowed = true; resetForTests(); a = path.join(root, 'a'); await fs.mkdir(path.join(a, '.clubhouse'), { recursive: true }); await fs.mkdir(getBaseDirPath(), { recursive: true });
  await fs.writeFile(path.join(getBaseDirPath(), 'projects.json'), JSON.stringify({ version: 1, projects: [{ id: 'a', name: 'Selected project', path: a }] })); groupDir = path.join(root, '.clubhouse-dev', 'group-projects'); await fs.mkdir(groupDir, { recursive: true });
  vi.mocked(sync.readFileSync).mockClear(); vi.mocked(sync.writeFileSync).mockClear(); vi.mocked(sync.copyFileSync).mockClear();
});
afterEach(async () => { resetForTests(); await fs.rm(root, { recursive: true, force: true }); });
it('projects only selected explicit local-contract membership and safe switch fields without collection or disk effects', async () => {
  const s = await selected(); await putRegistry([group(), group('unrelated', { name: 'PRIVATE_UNRELATED_GROUP' })]); await put('group', membership({ explicit: [member({ name: 'PRIVATE_RAW_MEMBER', instructions: 'PRIVATE_RAW_PROMPT' }), member({ address: 'unrelated', name: 'PRIVATE_UNRELATED_MEMBER' })], instructions: { selected: { '*': 'PRIVATE_INSTRUCTIONS' } }, disabledTools: { selected: ['post_bulletin', 'PRIVATE_UNKNOWN_TOOL'] } })); await put('unrelated', membership({ explicit: [member({ address: 'other' })] }));
  const before = await disk(), receipts: Array<{ current(): boolean }> = [], result = read(s, { authorized: () => true, receipts });
  expect(result).toMatchObject({ state: 'ok', value: { complete: true, knownMatches: 1, next: null, rows: [{ groupId: 'group', membership: 'explicit', applicability: 'configured', host: 'local-contract', disabledTools: ['post_bulletin'], unrecognizedTools: 1, switchSource: 'member' }] } }); expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|instructions|address|fingerprint|projectPath|"metadata"/); expect(receipts.every((r) => r.current())).toBe(true); expect(await disk()).toEqual(before); expect(sync.readFileSync).not.toHaveBeenCalled(); expect(sync.writeFileSync).not.toHaveBeenCalled(); expect(sync.copyFileSync).not.toHaveBeenCalled();
});
it('keeps automatic policy, scope and explicit exclusions independent from effective membership', async () => {
  const s = await selected(); await putRegistry([group('auto'), group('excluded'), group('outside', { scope: { level: 'project', projectId: 'other-project', reach: 'local' } }), group('unknown', { scope: undefined })]);
  await put('auto', membership({ autoJoin: true, explicit: [] })); await put('excluded', membership({ excluded: [{ address: 'selected', excludedAt: '2026-11-20' }] })); await put('outside', membership()); await put('unknown', membership());
  const result = read(s, { authorized: () => true, receipts: [] }); expect(result).toMatchObject({ state: 'ok', value: { knownMatches: 4, rows: [{ membership: 'auto', applicability: 'configured' }, { membership: 'excluded', applicability: 'excluded' }, { applicability: 'out-of-scope' }, { applicability: 'unknown' }] } });
});
it('never auto-joins a helper but keeps its explicitly project-qualified saved entry', async () => {
  const s = await selected({ parentAgentId: 'parent' }); await putRegistry([group('auto'), group('explicit')]); await put('auto', membership({ autoJoin: true, explicit: [] })); await put('explicit', membership({ explicit: [member({ kind: 'helper' })] }));
  expect(read(s, { authorized: () => true, receipts: [] })).toMatchObject({ state: 'ok', value: { knownMatches: 1, rows: [{ groupId: 'explicit', membership: 'explicit' }] } });
});
it('requires loaded host-relative machine evidence and exact selected project association for modern records', async () => {
  const s = await selected(); await putRegistry([group('own', { host: { machine: fp } }), group('replica', { host: { machine: other } }), group('wrong', { host: { machine: other }, name: 'PRIVATE_OTHER_HOST_NATIVE_COLLISION' })]); await put('own', membership()); await put('replica', membership({ explicit: [member({ address: 'selected@' + fp })] })); await put('wrong', membership());
  const cold = read(s, { authorized: () => true, receipts: [] }); expect(cold).toMatchObject({ state: 'ok', value: { complete: false, knownMatches: 0, rows: [] } }); expect(sync.readFileSync).not.toHaveBeenCalled(); await warm();
  const result = read(s, { authorized: () => true, receipts: [] }); expect(result).toMatchObject({ state: 'ok', value: { complete: true, knownMatches: 2, rows: [{ groupId: 'own', host: 'loaded-local' }, { groupId: 'replica', host: 'loaded-other' }] } }); expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|aa:|bb:|fingerprint|privateKey|publicKey/); expect(sync.readFileSync).not.toHaveBeenCalled();
});
it('keeps unqualified same-ID app-scope entries unknown and withholds the unrelated group name', async () => {
  const s = await selected(); await putRegistry([group('ambiguous', { name: 'PRIVATE_AMBIGUOUS_GROUP', scope: { level: 'app', reach: 'local' } })]); await put('ambiguous', membership({ explicit: [member({ projectId: undefined })] }));
  const result = read(s, { authorized: () => true, receipts: [] }); expect(result).toMatchObject({ state: 'ok', value: { complete: false, knownMatches: 0, unknownRows: 1, rows: [] } }); expect(JSON.stringify(result)).not.toContain('PRIVATE_');
});
it('continues group registry pages and supported member-budget-deferred groups rather than clipping later selected rows', async () => {
  const s = await selected(); const groups = Array.from({ length: 9 }, (_, i) => group('g' + i)); await putRegistry(groups); for (const g of groups) await put(g.id, membership({ explicit: g.id === 'g8' ? [member()] : [] }));
  expect(read(s, { authorized: () => true, receipts: [] })).toMatchObject({ state: 'ok', value: { knownMatches: 0, next: { offset: 8, projectOffset: 0 } } }); expect(read(s, { authorized: () => true, receipts: [], offset: 8 })).toMatchObject({ state: 'ok', value: { knownMatches: 1, rows: [{ groupId: 'g8' }], next: null } });
  await putRegistry(groups.slice(0, 2)); await put('g0', membership({ explicit: Array.from({ length: 4096 }, (_, i) => member({ address: 'unrelated-' + i })) })); await put('g1', membership());
  expect(read(s, { authorized: () => true, receipts: [] })).toMatchObject({ state: 'ok', value: { complete: true, knownMatches: 0, next: { offset: 1, projectOffset: 0 } } }); expect(read(s, { authorized: () => true, receipts: [], offset: 1 })).toMatchObject({ state: 'ok', value: { knownMatches: 1, rows: [{ groupId: 'g1' }], next: null } });
});
it('honors tombstones, verified missing versus corrupt/backup-only inventories, and preserves all source disk bytes and temps', async () => {
  const s = await selected(); expect(read(s, { authorized: () => true, receipts: [] })).toMatchObject({ state: 'ok', value: { complete: true, knownMatches: 0 } }); await putRegistry([group()]); await put('group', membership()); await fs.writeFile(path.join(groupDir, 'tombstones.json'), JSON.stringify([{ groupProjectId: 'group' }])); expect(read(s, { authorized: () => true, receipts: [] })).toMatchObject({ state: 'ok', value: { knownMatches: 0, rows: [] } });
  await fs.rename(path.join(groupDir, 'registry.json'), path.join(groupDir, 'registry.json.bak')); await fs.writeFile(path.join(groupDir, 'keep.tmp'), 'keep'); const before = await disk(); expect(read(s, { authorized: () => true, receipts: [] }).state).toBe('unavailable'); expect(await disk()).toEqual(before);
});
it('retains selected source/tombstone/identity receipts after return and refuses revoked or mismatched selected projects', async () => {
  const s = await selected(); await warm(); await putRegistry([group('own', { host: { machine: fp } })]); await put('own', membership()); const receipts: Array<{ current(): boolean }> = []; expect(read(s, { authorized: () => true, receipts }).state).toBe('ok'); expect(receipts.every((r) => r.current())).toBe(true); resetForTests(); expect(receipts.some((r) => !r.current())).toBe(true);
  await warm(); const source: Array<{ current(): boolean }> = []; expect(read(s, { authorized: () => true, receipts: source }).state).toBe('ok'); await put('own', membership({ explicit: [] })); expect(source.some((r) => !r.current())).toBe(true);
  const hidden: Array<{ current(): boolean }> = []; expect(read(s, { authorized: () => true, receipts: hidden }).state).toBe('ok'); await fs.writeFile(path.join(groupDir, 'tombstones.json'), JSON.stringify([{ groupProjectId: 'own' }])); expect(hidden.some((r) => !r.current())).toBe(true);
  expect(read(s, { authorized: () => false, receipts: [] })).toMatchObject({ state: 'unavailable', reason: 'changed' }); expect(read({ ...s, projectPath: root }, { authorized: () => true, receipts: [] })).toMatchObject({ state: 'unavailable', reason: 'changed' });
});
it.each(['cold-host', 'warm-local', 'warm-other', 'unknown-helper', 'unknown-disposed', 'known-helper', 'out-of-scope', 'auto-off'] as const)('distinguishes unknown automatic group applicability from known empty: %s', async (mode) => {
  const raw = mode === 'unknown-helper' || mode === 'out-of-scope' || mode === 'auto-off' ? { parentAgentId: {} } : mode === 'unknown-disposed' ? { disposedAt: null } : mode === 'known-helper' ? { parentAgentId: 'parent' } : {};
  const s = await selected(raw), modern = ['cold-host', 'warm-local', 'warm-other'].includes(mode);
  const g = group('automatic', { ...(modern && { host: { machine: fp } }), ...(mode === 'out-of-scope' && { scope: { level: 'project', projectId: 'other-project', reach: 'local' } }) });
  await putRegistry([g]); await put('automatic', membership({ autoJoin: mode !== 'auto-off', explicit: [], excluded: [] }));
  if (mode === 'warm-local') await warm(); if (mode === 'warm-other') await warm(other);
  const identity = await import('./annex-identity');
  if (mode === 'cold-host') { expect(identity.matchLoadedIdentityForDisplay(fp, { receipts: [] }).state).toBe('unavailable'); expect(s.fields.helper).toMatchObject({ state: 'ok', value: false }); expect(s.fields.disposed).toMatchObject({ state: 'ok', value: false }); }
  if (mode === 'unknown-helper' || mode === 'out-of-scope' || mode === 'auto-off') expect(s.fields.helper.state).toBe('unavailable'); if (mode === 'unknown-disposed') expect(s.fields.disposed.state).toBe('unavailable');
  const receipts: Array<{ current(): boolean }> = [], before = await disk(), result = read(s, { authorized: () => true, receipts }); expect(result.state).toBe('ok'); expect(receipts.every((r) => r.current())).toBe(true);
  const unknown = ['cold-host', 'unknown-helper', 'unknown-disposed'].includes(mode);
  expect.soft(result).toMatchObject({ state: 'ok', value: { complete: !unknown, unknownRows: unknown ? 1 : 0, knownMatches: mode === 'warm-local' ? 1 : 0 } });
  if (result.state === 'ok') expect.soft(result.value.rows).toHaveLength(mode === 'warm-local' ? 1 : 0);
  expect(await disk()).toEqual(before); expect(sync.readFileSync).not.toHaveBeenCalled(); expect(sync.writeFileSync).not.toHaveBeenCalled(); expect(sync.copyFileSync).not.toHaveBeenCalled();
  if (mode === 'cold-host') { await warm(); expect(receipts.some((r) => !r.current())).toBe(true); }
});
it.each(['other-host-local', 'other-host-network', 'same-host-local'] as const)('keeps host-relative reach separate from saved explicit group membership: %s', async (mode) => {
  const s = await selected(); await warm(); const host = mode === 'same-host-local' ? fp : other, scope = { level: 'project' as const, projectId: 'a', reach: mode === 'other-host-network' ? 'network' as const : 'local' as const };
  const g = group('reach', { host: { machine: host }, scope }); await putRegistry([g]); await put('reach', membership({ explicit: [member({ address: 'selected@' + fp })] }));
  const identity = await import('./annex-identity'); expect(identity.matchLoadedIdentityForDisplay(fp, { receipts: [] })).toMatchObject({ state: 'ok', value: true }); expect(identity.matchLoadedIdentityForDisplay(other, { receipts: [] })).toMatchObject({ state: 'ok', value: false });
  const { canonicalMemberAddress } = await import('../../shared/group-project-members'), { memberInScope } = await import('../../shared/group-project-scope');
  const canonical = canonicalMemberAddress('selected@' + fp, host); expect(memberInScope(scope, { address: canonical, projectId: 'a' })).toBe(mode !== 'other-host-local');
  const before = await disk(), receipts: Array<{ current(): boolean }> = [], result = read(s, { authorized: () => true, receipts }); expect(result.state).toBe('ok'); if (result.state !== 'ok') throw new Error('fixture'); expect(result.value.rows).toHaveLength(1); expect(result.value.knownMatches).toBe(1); expect(receipts.every((r) => r.current())).toBe(true);
  expect.soft(result.value.rows[0]).toMatchObject({ groupId: 'reach', membership: 'explicit', applicability: mode === 'other-host-local' ? 'out-of-scope' : 'configured' });
  expect(await disk()).toEqual(before); expect(sync.readFileSync).not.toHaveBeenCalled(); expect(sync.writeFileSync).not.toHaveBeenCalled();
});
