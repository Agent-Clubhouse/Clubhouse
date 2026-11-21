import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { captureRemoteSessionHistoryBinding } from './remote-session-history-binding';
const m = vi.hoisted(() => ({ base: '', project: '', runtime: undefined as unknown, registration: undefined as { runtime: string; projectPath: string; orchestrator: string; nonce: string } | undefined, role: false }));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => m.base }));
vi.mock('./agent-runtime', () => ({ getAgentRuntime: () => m.runtime }));
vi.mock('./agent-registry', () => ({ agentRegistry: { get: () => m.registration } }));
vi.mock('./dispatcher/dispatcher-service', () => ({ isDispatcherIdentityAgentId: () => m.role }));
let root: string, allowed: boolean, generation: string, native: string, startSeq: number, evidenceAvailable: boolean;
const config = { id: 'a1', name: 'Selected', color: 'blue', createdAt: '2026-01-01' } as const;
const evidence = () => ({ version: 1, agentId: 'a1', sessionId: 's1', nativeSessionId: native, providerId: 'claude-code', driver: 'claude_agent_sdk',
  runId: generation, startSeq, startedAt: 1000, readAt: 2000, lastSeq: 3000, completeFromStart: true,
  values: { capabilities: { subagents: 'full', usage: 'tokens', limits: false } }, observedAt: { capabilities: 1000 }, omitted: {} });
const target = () => ({ agent: config, project: { id: 'p1', name: 'Project', path: m.project } });
const capture = () => captureRemoteSessionHistoryBinding(target(), m.runtime as never, () => allowed);
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-history-binding-'));
  m.base = path.join(root, 'profile'); m.project = path.join(root, 'project'); m.role = false;
  await fs.mkdir(m.base); await fs.mkdir(path.join(m.project, '.clubhouse'), { recursive: true });
  await fs.writeFile(path.join(m.base, 'projects.json'), JSON.stringify({ version: 1, projects: [target().project] }));
  await fs.writeFile(path.join(m.project, '.clubhouse', 'agents.json'), JSON.stringify([config]));
  allowed = true; generation = 'run-a'; native = 'native-a'; startSeq = 1; evidenceAvailable = true;
  m.registration = { runtime: 'chat', projectPath: m.project, orchestrator: 'claude-code', nonce: 'private-launch-nonce' };
  m.runtime = { kind: 'chat', isRunning: () => true, getState: () => 'idle', getSessionId: () => 's1', getNativeSessionId: () => native,
    getDisplayRunId: () => generation, getCapabilities: () => ({ subagents: 'full' }), getDetailsEvidence: () => evidenceAvailable ? evidence() : undefined };
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
it('emits only positive public identity fields with a real primary target witness and no writes', async () => {
  const files = [path.join(m.base, 'projects.json'), path.join(m.project, '.clubhouse', 'agents.json')];
  const before = await Promise.all(files.map((file) => fs.readFile(file)));
  const receipt = capture()!;
  expect(receipt.value).toEqual({ version: 1, projectId: 'p1', agentId: 'a1', sessionId: 's1', providerId: 'claude-code', driver: 'claude_agent_sdk', nativeSessionId: 'native-a', displayRunId: 'run-a', startSeq: 1, subagents: 'full' });
  expect(receipt.current()).toBe(true);
  expect(JSON.stringify(receipt.value)).not.toContain('private-launch-nonce');
  expect(JSON.stringify(receipt.value)).not.toContain(root);
  expect(await Promise.all(files.map((file) => fs.readFile(file)))).toEqual(before);
});
it.each(['project removed', 'agent disposed', 'agent replaced', 'provider', 'nonce', 'same-native reopen', 'native', 'revoked'] as const)('refuses an admitted receipt after %s', async (change) => {
  const receipt = capture()!;
  if (change === 'project removed') await fs.writeFile(path.join(m.base, 'projects.json'), JSON.stringify({ version: 1, projects: [] }));
  if (change === 'agent disposed') await fs.writeFile(path.join(m.project, '.clubhouse', 'agents.json'), JSON.stringify([{ ...config, disposedAt: '2026-11-20' }]));
  if (change === 'agent replaced') await fs.writeFile(path.join(m.project, '.clubhouse', 'agents.json'), JSON.stringify([{ ...config, id: 'replacement', name: 'a1' }]));
  if (change === 'provider') m.registration.orchestrator = 'copilot';
  if (change === 'nonce') m.registration.nonce = 'replacement';
  if (change === 'same-native reopen') { generation = 'run-b'; startSeq = 2000; }
  if (change === 'native') native = 'native-b';
  if (change === 'revoked') allowed = false;
  expect(receipt.current()).toBe(false);
});
it.each(['role', 'unreported', 'no native', 'unregistered', 'wrong project', 'backup only'] as const)('withholds optional receipt for %s without inventing empty history', async (mode) => {
  if (mode === 'role') m.role = true;
  if (mode === 'unreported') evidenceAvailable = false;
  if (mode === 'no native') native = '';
  if (mode === 'unregistered') m.registration = undefined;
  if (mode === 'wrong project') m.registration.projectPath = '/other';
  if (mode === 'backup only') await fs.rename(path.join(m.project, '.clubhouse', 'agents.json'), path.join(m.project, '.clubhouse', 'agents.json.bak'));
  expect(capture()).toBeUndefined();
});
