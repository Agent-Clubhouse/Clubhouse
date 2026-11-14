import * as path from 'path';
import * as os from 'os';
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ live: undefined as { projectPath: string; cwd?: string } | undefined, configs: [] as Array<{ id: string; worktreePath?: string }>, check: vi.fn(), policy: vi.fn() }));
const projectPath = path.join(os.tmpdir(), 'handoff-source-project');
const worktree = path.join(projectPath, 'agents', 'caller');
vi.mock('./agent-registry', () => ({ agentRegistry: { get: () => state.live } }));
vi.mock('./agent-config', () => ({ peekDurableConfigs: async () => state.configs }));
vi.mock('./project-store', () => ({ peekProjects: async () => [{ id: 'registered', path: projectPath }] }));
vi.mock('./handoff-snapshot', () => ({ checkHandoffSnapshot: (...args: unknown[]) => state.check(...args) }));
vi.mock('./handoff-secret-settings', () => ({ HandoffSecretPolicy: { forProject: (...args: unknown[]) => state.policy(...args) } }));
vi.mock('./handoff-transfer-settings', () => ({ getHandoffTransferBounds: async () => ({ totalBytes: 1024, perFileBytes: 512, maxFiles: 100 }) }));
import { checkCallerHandoff } from './handoff-preflight-host';
beforeEach(() => { state.live = undefined; state.configs = []; vi.clearAllMocks(); state.check.mockResolvedValue({ ready: true }); state.policy.mockResolvedValue({ mainOwned: true }); });
it('selects the registered durable caller source and project policy itself', async () => {
  state.configs = [{ id: 'caller', worktreePath: worktree }];
  const include = { ignored: ['fixtures/example.txt'] };
  await checkCallerHandoff('caller', include, ['build/**']);
  expect(state.policy).toHaveBeenCalledWith('registered');
  expect(state.check).toHaveBeenCalledWith({ worktreeRoot: worktree, include, exclude: ['build/**'], bounds: { totalBytes: 1024, perFileBytes: 512, maxFiles: 100 }, secretPolicy: { mainOwned: true } });
});
it('uses a running quick caller folder but refuses an unregistered project or another agent', async () => {
  state.live = { projectPath, cwd: worktree }; await checkCallerHandoff('quick');
  expect(state.check).toHaveBeenLastCalledWith(expect.objectContaining({ worktreeRoot: worktree }));
  state.live = { projectPath: path.join(os.tmpdir(), 'unregistered') };
  await expect(checkCallerHandoff('quick')).rejects.toThrow('registered project');
  state.live = undefined; state.configs = [{ id: 'other', worktreePath: worktree }];
  await expect(checkCallerHandoff('caller')).rejects.toThrow('registered project');
});
