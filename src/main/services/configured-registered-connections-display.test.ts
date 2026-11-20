import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
const m = vi.hoisted(() => ({ home: '', allowed: true }));
vi.mock('electron', () => ({ app: { getPath: () => m.home } }));
vi.mock('./agent-config', () => { throw new Error('Ordinary agent owner must not be loaded'); });
vi.mock('./project-store', () => { throw new Error('Ordinary project owner must not be loaded'); });
import { DISPATCHER_PROJECT_ID } from '../../shared/dispatcher-types';
import { AUTOMATIC_CONNECTION_SWITCHES } from '../../shared/connection-grants';
import { getBaseDirPath } from './base-dir';
import { projectConnectionEndpointFieldsForDisplay } from './connection-endpoint-fields-display';
import { readConfiguredRegisteredConnectionsForDisplay as readPage } from './configured-registered-connections-display';
import type { DisplayReceipt } from './display-settings';
let root: string, a: string, b: string;
const agent = (id: string, extra = {}) => ({ id, name: 'Name ' + id, color: 'blue', createdAt: '2026-11-20', ...extra });
const put = (folder: string, rows: unknown[]) => fs.writeFile(path.join(folder, '.clubhouse', 'agents.json'), JSON.stringify(rows));
const selected = (dispatcher = false) => {
  const fields = projectConnectionEndpointFieldsForDisplay('parent', agent('parent'));
  if (fields.state !== 'ok') throw new Error('fixture');
  return { agentId: 'parent', projectId: dispatcher ? DISPATCHER_PROJECT_ID : 'a', projectPath: a, receipt: { current: () => m.allowed }, fields: fields.value };
};
const read = (options = {}) => readPage(selected(), 'helper-children', { authorized: () => m.allowed, receipts: [], ...options });
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-configured-display-'))); m.home = root; m.allowed = true; a = path.join(root, 'a'); b = path.join(root, 'b');
  for (const p of [a, b]) await fs.mkdir(path.join(p, '.clubhouse'), { recursive: true });
  await fs.mkdir(getBaseDirPath(), { recursive: true });
  await fs.writeFile(path.join(getBaseDirPath(), 'projects.json'), JSON.stringify({ version: 1, projects: [{ id: 'a', name: 'First custom project', path: a }, { id: 'b', name: 'Second custom project', path: b }] }));
  await put(a, [agent('parent')]); await put(b, []);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
it('retains project-qualified reused IDs, safe fields and source-specific defaults without a live binding claim', async () => {
  await put(a, [agent('parent'), agent('same', { parentAgentId: 'parent' })]);
  await put(b, [agent('same', { name: 'Other project helper', parentAgentId: 'parent', parentProjectPath: a, env: { password: 'PRIVATE_CREDENTIAL' } }), agent('unrelated', { parentAgentId: 'other', name: 'PRIVATE_UNRELATED' })]);
  const result = read(); expect(result).toMatchObject({ state: 'ok', value: { complete: true, knownMatches: 2, entries: [
    { endpoint: { agentId: 'same', projectId: 'a', projectName: { value: 'First custom project' } }, source: 'helper', applicability: 'configured' },
    { endpoint: { agentId: 'same', projectId: 'b', projectName: { value: 'Second custom project' } }, source: 'helper', applicability: 'configured' },
  ] } });
  if (result.state !== 'ok') throw new Error('fixture'); expect(result.value.entries[0].directions).toEqual([
    { from: 'selected', disabledTools: [...AUTOMATIC_CONNECTION_SWITCHES.parentToHelper.disabledTools], enabledTools: [...AUTOMATIC_CONNECTION_SWITCHES.parentToHelper.enabledTools] },
    { from: 'endpoint', disabledTools: [...AUTOMATIC_CONNECTION_SWITCHES.helperToParent.disabledTools], enabledTools: [...AUTOMATIC_CONNECTION_SWITCHES.helperToParent.enabledTools] },
  ]);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|namespace|projectPath|"env"/); expect(JSON.stringify(result)).not.toContain(root);
});
it('reaches the ninth configured relationship through bounded continuation', async () => {
  await put(b, Array.from({ length: 9 }, (_, i) => agent('child-' + i, { parentAgentId: 'parent', parentProjectPath: a })));
  const first = read(); expect(first).toMatchObject({ state: 'ok', value: { knownMatches: 9, next: { projectOffset: 0, matchOffset: 8 } } });
  if (first.state !== 'ok') throw new Error('fixture'); expect(first.value.entries).toHaveLength(8);
  expect(read(first.value.next!)).toMatchObject({ state: 'ok', value: { next: null, entries: [{ endpoint: { agentId: 'child-8' } }] } });
});
it('keeps disposed history and unknown applicability separate from configured directions', async () => {
  await put(b, [agent('gone', { parentAgentId: 'parent', parentProjectPath: a, disposedAt: '2026-11-20' }), agent('bad', { parentAgentId: 'parent', parentProjectPath: a, disposedAt: 99 })]);
  const result = read(); expect(result).toMatchObject({ state: 'ok', value: { entries: [{ applicability: 'disposed', directions: [] }, { applicability: 'unknown', directions: [] }] } });
});
it('reads Dispatcher-wide automatic policy only, including configured directions while runtime evidence is absent', async () => {
  await put(b, [agent('on', { orchestration: { connectToDispatcher: true } }), agent('off', { orchestration: { connectToDispatcher: false } }), agent('helper', { parentAgentId: 'parent', orchestration: { connectToDispatcher: true } })]);
  expect(readPage(selected(true), 'dispatcher-auto', { authorized: () => true, receipts: [] })).toMatchObject({ state: 'ok', value: { entries: [{ endpoint: { agentId: 'on' }, source: 'dispatcher-auto', applicability: 'configured', directions: [{ from: 'selected' }, { from: 'endpoint' }] }] } });
});
it.each(['same-root', 'later-root', 'registry', 'revoke'] as const)('refuses the next cache callback after a %s mutation, with final output withheld', async (mutation) => {
  await put(a, [agent('parent'), agent('one', { parentAgentId: 'parent' }), ...(mutation === 'same-root' ? [agent('two', { parentAgentId: 'parent' })] : [])]);
  await put(b, [agent('three', { parentAgentId: 'parent', parentProjectPath: a })]);
  const native = await import('fs'); const calls: string[] = [], receipts: DisplayReceipt[] = [];
  const result = read({ receipts, readLoadedCache: (folder: string, id: string, options: { expectedProjectNamespace?: string }) => {
    expect(options.expectedProjectNamespace).toMatch(/^ino:/); calls.push(folder + ':' + id);
    if (calls.length === 1) {
      if (mutation === 'same-root') native.writeFileSync(path.join(a, '.clubhouse', 'agents.json'), '[]');
      if (mutation === 'later-root') native.writeFileSync(path.join(b, '.clubhouse', 'agents.json'), '[]');
      if (mutation === 'registry') native.writeFileSync(path.join(getBaseDirPath(), 'projects.json'), JSON.stringify({ version: 1, projects: [{ id: 'a', name: 'First custom project', path: a }] }));
      if (mutation === 'revoke') m.allowed = false;
    }
    return { scope: 'host-session-cache', availability: 'not-loaded', observedAt: Date.now() };
  } });
  expect.soft(result).toMatchObject({ state: 'unavailable', reason: 'changed' }); expect.soft(JSON.stringify(result)).not.toContain('Name ');
  expect.soft(calls).toEqual([a + ':one']);
});
it('admits a legitimate second root with fresh namespace evidence and keeps cache provenance independent', async () => {
  await put(a, [agent('parent'), agent('one', { parentAgentId: 'parent' })]); await put(b, [agent('two', { parentAgentId: 'parent', parentProjectPath: a })]);
  const calls: string[] = [], receipts: DisplayReceipt[] = []; let cacheCurrent = true;
  const result = read({ receipts, readLoadedCache: (folder: string, id: string, options: { receipts: DisplayReceipt[]; expectedProjectNamespace?: string }) => {
    expect(options.expectedProjectNamespace).toMatch(/^ino:/); calls.push(folder + ':' + id); options.receipts.push({ current: () => cacheCurrent });
    return { scope: 'host-session-cache', availability: 'not-loaded', observedAt: Date.now() };
  } });
  expect(result).toMatchObject({ state: 'ok', value: { entries: [{ hostCache: { value: { availability: 'not-loaded' } } }, { hostCache: { value: { availability: 'not-loaded' } } }] } });
  expect(calls).toEqual([a + ':one', b + ':two']); expect(receipts.every((r) => r.current())).toBe(true);
  cacheCurrent = false; expect(receipts.some((r) => !r.current())).toBe(true);
});
it('validates page size before any callback and preserves partial primary fields independently of cache errors', async () => {
  const cache = vi.fn(() => { throw new Error('unavailable'); }); expect(read({ limit: 9, readLoadedCache: cache }).state).toBe('unavailable'); expect(cache).not.toHaveBeenCalled();
  await put(b, [agent('one', { parentAgentId: 'parent', parentProjectPath: a })]);
  expect(read({ limit: 1, readLoadedCache: cache })).toMatchObject({ state: 'ok', value: { entries: [{ endpoint: { agentId: 'one' }, hostCache: { state: 'unavailable' } }] } }); expect(cache).toHaveBeenCalledTimes(1);
});

it('retains qualified same-ID Dispatcher primary fields as ambiguous policy with no configured directions and reaches later records', async () => {
  const { captureReadOnlyRoleTargetWitness } = await import('./read-only-agent-target-witness');
  const controller = agent('controller'), ordinary = agent('controller', { name: 'Ordinary same-ID agent', orchestration: { connectToDispatcher: true } });
  await put(a, [controller]); await put(b, [ordinary, ...Array.from({ length: 8 }, (_, i) => agent('normal-' + i, { orchestration: { connectToDispatcher: true } }))]);
  const fields = projectConnectionEndpointFieldsForDisplay(controller.id, controller); if (fields.state !== 'ok') throw new Error('fixture');
  const target = { agent: controller, project: { id: DISPATCHER_PROJECT_ID, name: 'Host Dispatcher', path: a } } as unknown as import('./agent-config-reader').AgentConfigTarget;
  const role = captureReadOnlyRoleTargetWitness(target, () => true), receipts: DisplayReceipt[] = []; expect(role.current()).toBe(true); expect(JSON.parse(await fs.readFile(path.join(b, '.clubhouse', 'agents.json'), 'utf8'))).toHaveLength(9);
  const chosen = { agentId: controller.id, projectId: DISPATCHER_PROJECT_ID, projectPath: a, receipt: role, fields: fields.value };
  const first = readPage(chosen, 'dispatcher-auto', { authorized: () => true, receipts });
  expect.soft(first).toMatchObject({ state: 'ok', value: { complete: false, knownMatches: 9, unknownRows: 1, next: { projectOffset: 0, matchOffset: 8 }, entries: [{ endpoint: { projectId: 'b', agentId: controller.id, identityAmbiguous: true, fields: { name: { value: 'Ordinary same-ID agent' } } }, applicability: 'unknown', directions: [] }] } });
  const last = readPage(chosen, 'dispatcher-auto', { authorized: () => true, receipts, matchOffset: 8 });
  expect.soft(last).toMatchObject({ state: 'ok', value: { entries: [{ endpoint: { agentId: 'normal-7' }, applicability: 'configured', directions: [{ from: 'selected' }, { from: 'endpoint' }] }], next: null } });
  expect.soft(receipts.every((r) => r.current())).toBe(true);
  await put(b, []); expect(role.current()).toBe(true); expect.soft(receipts.some((r) => !r.current())).toBe(true);
});
