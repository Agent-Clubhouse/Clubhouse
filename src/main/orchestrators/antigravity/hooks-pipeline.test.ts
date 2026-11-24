/**
 * Config-pipeline restore of Antigravity's `.agents/hooks.json` (#3795):
 * Clubhouse's `clubhouse-status` comes out by receipt; everything else stays,
 * byte for byte. Files live under a temp folder; the real home is untouched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/clubhouse-test' } }));
vi.mock('../../services/log-service', () => ({ appLog: vi.fn() }));

import { antigravityHooksPath, buildAntigravityStatusHook, isAntigravityHooksPath, writeAntigravityHooks } from './hooks';
import { memoryReceiptStore, setAntigravityReceiptStore, type ReceiptStore } from './workspace-json';
import * as configPipeline from '../../services/config-pipeline';

const HOOK_URL = 'http://127.0.0.1:4567/hook';
const USER_FILE = '{\n  // my hooks\n  "my-linter-hook": { "PostToolUse": [{ "matcher": "run_command", "hooks": [{ "command": "./lint.sh" }] }] },\n}\n';

describe('config-pipeline restore of .agents/hooks.json', () => {
  let tmp: string;
  let worktree: string;
  let file: string;
  let previousStore: ReceiptStore;
  const read = () => fsp.readFile(file, 'utf-8');
  const writeUserFile = async (text = USER_FILE) => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, text);
  };

  beforeEach(async () => {
    tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'agy-hooks-pipe-')));
    worktree = path.join(tmp, 'wt');
    await fsp.mkdir(worktree);
    file = antigravityHooksPath(worktree);
    previousStore = setAntigravityReceiptStore(memoryReceiptStore());
    configPipeline._resetForTesting();
  });

  afterEach(async () => {
    setAntigravityReceiptStore(previousStore);
    configPipeline._resetForTesting();
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('recognizes only a worktree\'s .agents/hooks.json', () => {
    expect(isAntigravityHooksPath(file)).toBe(true);
    expect(isAntigravityHooksPath(path.join(worktree, '.codex', 'hooks.json'))).toBe(false);
    expect(isAntigravityHooksPath(path.join(worktree, '.github', 'hooks', 'hooks.json'))).toBe(false);
  });

  it('restores the person\'s file byte for byte, comments and trailing comma included', async () => {
    await writeUserFile();
    await configPipeline.snapshotFile('agent-1', file);
    await writeAntigravityHooks(worktree, HOOK_URL);
    expect(await read()).toContain('clubhouse-status');
    await configPipeline.restoreForAgent('agent-1');
    expect(await read()).toBe(USER_FILE);
  });

  it('deletes a file Clubhouse created that nobody touched', async () => {
    await configPipeline.snapshotFile('agent-1', file);
    await writeAntigravityHooks(worktree, HOOK_URL);
    await configPipeline.restoreForAgent('agent-1');
    await expect(fsp.access(file)).rejects.toThrow();
  });

  it('leaves a clubhouse-status it has no receipt for, and reports it for repair', async () => {
    const theirs = `${JSON.stringify({ 'clubhouse-status': buildAntigravityStatusHook(HOOK_URL) }, null, 2)}\n`;
    await writeUserFile(theirs);
    await configPipeline.snapshotFile('agent-1', file);
    const onRepairRequired = vi.fn();
    await configPipeline.restoreForAgent('agent-1', { onRepairRequired });
    expect(onRepairRequired).toHaveBeenCalledTimes(1);
    expect(await read()).toBe(theirs);
  });

  it('the stopped-agent strip goes through the receipt too', async () => {
    await writeUserFile();
    await writeAntigravityHooks(worktree, HOOK_URL);
    expect(await configPipeline.stripClubhouseHooksFromFile(file)).toBe(true);
    expect(await read()).toBe(USER_FILE);
    expect(await configPipeline.stripClubhouseHooksFromFile(file)).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('two agents through a symlink alias share one refcount', async () => {
    await writeUserFile();
    const alias = path.join(tmp, 'wt-alias');
    await fsp.symlink(worktree, alias);
    await configPipeline.snapshotFile('agent-a', antigravityHooksPath(alias));
    await writeAntigravityHooks(alias, HOOK_URL);
    await configPipeline.snapshotFile('agent-b', file);
    await writeAntigravityHooks(worktree, HOOK_URL);
    await configPipeline.restoreForAgent('agent-a');
    expect(await read()).toContain('clubhouse-status');
    await configPipeline.restoreForAgent('agent-b');
    expect(await read()).toBe(USER_FILE);
  });
});
