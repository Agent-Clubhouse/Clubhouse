import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { cleanupRetiredPluginData, gitTrackedState, RETIRED_WORKSHOP_PLUGIN_IDS } from './retired-plugin-cleanup';

function touch(file: string, content = '{}'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('cleanupRetiredPluginData', () => {
  let root: string;
  let globalDir: string;
  let communityDir: string;
  let projectPath: string;
  let kvDir: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'retired-plugin-cleanup-'));
    globalDir = path.join(root, 'plugin-data');
    communityDir = path.join(root, 'plugins');
    projectPath = path.join(root, 'project');
    kvDir = path.join(globalDir, '_system', 'kv');
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const run = async () => (await cleanupRetiredPluginData({
    globalPluginDataDir: globalDir,
    communityPluginsDir: communityDir,
    projects: [{ id: 'proj_1', path: projectPath }],
  })).removed;

  it('removes Hub storage and settings, leaving everything else', async () => {
    touch(path.join(globalDir, 'hub', 'kv', 'hub-instances.json'));
    touch(path.join(kvDir, 'settings-app-hub.json'));
    touch(path.join(kvDir, 'settings-app-hub.json.bak'));
    touch(path.join(kvDir, 'settings-proj_1-hub.json'));
    touch(path.join(projectPath, '.clubhouse', 'plugin-data-local', 'hub', 'kv', 'hub-instances.json'));
    // Unrelated data that must survive
    touch(path.join(kvDir, 'settings-app-my-hub.json'));
    touch(path.join(kvDir, 'app-enabled.json'));
    touch(path.join(globalDir, 'canvas', 'kv', 'canvas-instances.json'));
    touch(path.join(projectPath, '.clubhouse', 'plugin-data-local', 'canvas', 'kv', 'canvas-instances.json'));

    const removed = await run();

    expect(removed).toHaveLength(5);
    expect(fs.existsSync(path.join(globalDir, 'hub'))).toBe(false);
    expect(fs.existsSync(path.join(kvDir, 'settings-app-hub.json'))).toBe(false);
    expect(fs.existsSync(path.join(kvDir, 'settings-app-hub.json.bak'))).toBe(false);
    expect(fs.existsSync(path.join(kvDir, 'settings-proj_1-hub.json'))).toBe(false);
    expect(fs.existsSync(path.join(projectPath, '.clubhouse', 'plugin-data-local', 'hub'))).toBe(false);
    expect(fs.existsSync(path.join(kvDir, 'settings-app-my-hub.json'))).toBe(true);
    expect(fs.existsSync(path.join(kvDir, 'app-enabled.json'))).toBe(true);
    expect(fs.existsSync(path.join(globalDir, 'canvas'))).toBe(true);
    expect(fs.existsSync(path.join(projectPath, '.clubhouse', 'plugin-data-local', 'canvas'))).toBe(true);
  });

  it('is a no-op on a fresh install', async () => {
    expect(await run()).toEqual([]);
  });

  it('leaves data alone when a community plugin named hub is installed', async () => {
    fs.mkdirSync(path.join(communityDir, 'hub'), { recursive: true });
    touch(path.join(globalDir, 'hub', 'kv', 'state.json'));
    touch(path.join(kvDir, 'settings-app-hub.json'));

    expect(await run()).toEqual([]);
    expect(fs.existsSync(path.join(globalDir, 'hub'))).toBe(true);
    expect(fs.existsSync(path.join(kvDir, 'settings-app-hub.json'))).toBe(true);
  });

  it('removes Sessions and Agent Queue plugin storage', async () => {
    touch(path.join(globalDir, 'agent-queue', 'kv', 'x.json'));
    touch(path.join(kvDir, 'settings-proj_1-sessions.json'));
    touch(path.join(projectPath, '.clubhouse', 'plugin-data-local', 'sessions', 'kv', 'x.json'));

    await run();

    expect(fs.existsSync(path.join(globalDir, 'agent-queue'))).toBe(false);
    expect(fs.existsSync(path.join(kvDir, 'settings-proj_1-sessions.json'))).toBe(false);
    expect(fs.existsSync(path.join(projectPath, '.clubhouse', 'plugin-data-local', 'sessions'))).toBe(false);
  });

  describe('in a Clubhouse home with Assistant and Agent Queue records', () => {
    const RECORDS: Record<string, string> = {
      'assistant/chat-history.json': JSON.stringify([{ type: 'message', message: { id: 'm1', role: 'user', content: 'hello', timestamp: 1 } }]),
      'assistant/CLAUDE.md': '# Assistant\n',
      'assistant/.clubhouse/settings.json': '{}',
      'assistant/a-file-an-agent-wrote.txt': 'kept\n',
      'agent-queues/registry.json': JSON.stringify([{ id: 'aq_1', name: 'queue', concurrency: 1, createdAt: '2026-01-01', metadata: {} }]),
      'agent-queues/aq_1/tasks/aqt_1/state.json': JSON.stringify({ id: 'aqt_1', queueId: 'aq_1', mission: 'look', status: 'completed', createdAt: '2026-01-01', summary: 'found', detail: 'details', filesModified: ['a.ts'] }),
    };

    let clubhouseDir: string;
    const records = () => Object.fromEntries(
      Object.keys(RECORDS).map((relative) => [relative, fs.readFileSync(path.join(clubhouseDir, relative), 'utf-8')]),
    );
    const cleanupHome = async () => (await cleanupRetiredPluginData({
      globalPluginDataDir: path.join(clubhouseDir, 'plugin-data'),
      communityPluginsDir: path.join(clubhouseDir, 'plugins'),
      projects: [{ id: 'proj_1', path: projectPath }],
    })).removed;

    beforeEach(() => {
      clubhouseDir = path.join(root, 'home', '.clubhouse');
      for (const [relative, content] of Object.entries(RECORDS)) touch(path.join(clubhouseDir, relative), content);
    });

    it('leaves both folders byte-identical and writes nothing into a home with nothing to clean', async () => {
      expect(await cleanupHome()).toEqual([]);
      expect(records()).toEqual(RECORDS);
    });

    it('still deletes a stale Hub beside them', async () => {
      const staleHub = path.join(clubhouseDir, 'plugin-data', 'hub');
      const staleSettings = path.join(clubhouseDir, 'plugin-data', '_system', 'kv', 'settings-app-hub.json');
      const staleLocalHub = path.join(projectPath, '.clubhouse', 'plugin-data-local', 'hub');
      touch(path.join(staleHub, 'kv', 'hub-instances.json'));
      touch(staleSettings);
      touch(path.join(staleLocalHub, 'kv', 'hub-instances.json'));

      const removed = await cleanupHome();

      expect(removed).toEqual(expect.arrayContaining([staleHub, staleSettings, staleLocalHub]));
      expect(removed).toHaveLength(3);
      for (const stale of [staleHub, staleSettings, staleLocalHub]) expect(fs.existsSync(stale)).toBe(false);
      expect(records()).toEqual(RECORDS);
    });

    it('changes nothing on a re-run', async () => {
      touch(path.join(clubhouseDir, 'plugin-data', 'hub', 'kv', 'hub-instances.json'));
      await cleanupHome();

      expect(await cleanupHome()).toEqual([]);
      expect(records()).toEqual(RECORDS);
    });

    it('keeps them when the agent-queue plugin data is deleted', async () => {
      const queuePluginData = path.join(clubhouseDir, 'plugin-data', 'agent-queue');
      touch(path.join(queuePluginData, 'kv', 'x.json'));

      expect(await cleanupHome()).toEqual([queuePluginData]);
      expect(records()).toEqual(RECORDS);
    });
  });
});

describe('retired Workshop plugins (Lounge, KanBoss, Bug Report)', () => {
  let root: string;
  let globalDir: string;
  let communityDir: string;
  let projectPath: string;
  let kvDir: string;

  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: 'pipe' });
  const boardDir = () => path.join(projectPath, '.clubhouse', 'plugin-data', 'kanboss');
  const run = () => cleanupRetiredPluginData({
    globalPluginDataDir: globalDir,
    communityPluginsDir: communityDir,
    projects: [{ id: 'proj_1', path: projectPath }],
  });

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'retired-workshop-cleanup-'));
    globalDir = path.join(root, 'plugin-data');
    communityDir = path.join(root, 'plugins');
    projectPath = path.join(root, 'project');
    kvDir = path.join(globalDir, '_system', 'kv');
    fs.mkdirSync(projectPath, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('cleans up exactly Lounge, KanBoss and Bug Report', () => {
    expect([...RETIRED_WORKSHOP_PLUGIN_IDS].sort()).toEqual(['bug-report', 'kanboss', 'lounge']);
  });

  it('removes the installed plugin, its storage, its settings and per-project local data, keeping other plugins', async () => {
    touch(path.join(communityDir, 'lounge', 'manifest.json'));
    touch(path.join(globalDir, 'lounge', 'kv', 'lounge-state.json'), JSON.stringify({ customCircles: [{ id: 'c1' }] }));
    touch(path.join(kvDir, 'settings-app-lounge.json'));
    touch(path.join(communityDir, 'bug-report', 'manifest.json'));
    touch(path.join(kvDir, 'settings-proj_1-bug-report.json.bak'));
    touch(path.join(communityDir, 'kanboss', 'manifest.json'));
    touch(path.join(projectPath, '.clubhouse', 'plugin-data-local', 'kanboss', 'kv', 'boards.json'));
    touch(path.join(globalDir, '_system', 'retired-plugins-noted.json'), '["lounge"]');
    // Must survive
    touch(path.join(communityDir, 'pomodoro', 'manifest.json'));
    touch(path.join(communityDir, 'my-lounge', 'manifest.json'));
    touch(path.join(kvDir, 'settings-app-my-lounge.json'));
    touch(path.join(globalDir, 'pomodoro', 'kv', 'x.json'));
    touch(path.join(projectPath, '.clubhouse', 'plugin-data-local', 'github-issues', 'kv', 'x.json'));

    const { removed, keptTracked } = await run();

    const gone = [
      path.join(communityDir, 'lounge'),
      path.join(globalDir, 'lounge'),
      path.join(kvDir, 'settings-app-lounge.json'),
      path.join(communityDir, 'bug-report'),
      path.join(kvDir, 'settings-proj_1-bug-report.json.bak'),
      path.join(communityDir, 'kanboss'),
      path.join(projectPath, '.clubhouse', 'plugin-data-local', 'kanboss'),
      path.join(globalDir, '_system', 'retired-plugins-noted.json'),
    ];
    expect([...removed].sort()).toEqual([...gone].sort());
    expect(keptTracked).toEqual([]);
    for (const p of gone) expect(fs.existsSync(p)).toBe(false);
    for (const p of [
      path.join(communityDir, 'pomodoro'),
      path.join(communityDir, 'my-lounge'),
      path.join(kvDir, 'settings-app-my-lounge.json'),
      path.join(globalDir, 'pomodoro'),
      path.join(projectPath, '.clubhouse', 'plugin-data-local', 'github-issues'),
    ]) expect(fs.existsSync(p)).toBe(true);
    expect((await run()).removed).toEqual([]);
  });

  it('removes a symlinked install without touching what it points at', async () => {
    const source = path.join(root, 'dev', 'kanboss');
    touch(path.join(source, 'manifest.json'));
    fs.mkdirSync(communityDir, { recursive: true });
    fs.symlinkSync(source, path.join(communityDir, 'kanboss'), process.platform === 'win32' ? 'junction' : 'dir');

    expect((await run()).removed).toEqual([path.join(communityDir, 'kanboss')]);
    expect(fs.existsSync(path.join(communityDir, 'kanboss'))).toBe(false);
    expect(fs.existsSync(path.join(source, 'manifest.json'))).toBe(true);
  });

  it('deletes KanBoss project storage in a folder that is not a git repository', async () => {
    touch(path.join(boardDir(), 'kv', 'board.json'));

    const { removed, keptTracked } = await run();

    expect(removed).toEqual([boardDir()]);
    expect(keptTracked).toEqual([]);
    expect(fs.existsSync(boardDir())).toBe(false);
  });

  it('deletes KanBoss project storage that the repository ignores', async () => {
    git(projectPath, 'init', '-q');
    touch(path.join(projectPath, '.gitignore'), '.clubhouse/\n');
    touch(path.join(projectPath, 'README.md'), 'x');
    git(projectPath, 'add', '.');
    git(projectPath, 'commit', '-q', '-m', 'init');
    touch(path.join(boardDir(), 'kv', 'board.json'));

    expect((await run()).removed).toEqual([boardDir()]);
    expect(fs.existsSync(boardDir())).toBe(false);
    expect(fs.existsSync(path.join(projectPath, 'README.md'))).toBe(true);
  });

  it('deletes untracked KanBoss project storage in a repository', async () => {
    git(projectPath, 'init', '-q');
    touch(path.join(boardDir(), 'kv', 'board.json'));

    expect((await run()).removed).toEqual([boardDir()]);
    expect(fs.existsSync(boardDir())).toBe(false);
  });

  it('leaves the whole KanBoss folder in place when the repository tracks any file in it', async () => {
    git(projectPath, 'init', '-q');
    touch(path.join(boardDir(), 'boards', 'b1.json'));
    git(projectPath, 'add', '.');
    git(projectPath, 'commit', '-q', '-m', 'boards');
    touch(path.join(boardDir(), 'kv', 'untracked.json'));

    const { removed, keptTracked } = await run();

    expect(removed).toEqual([]);
    expect(keptTracked).toEqual([boardDir()]);
    expect(fs.existsSync(path.join(boardDir(), 'boards', 'b1.json'))).toBe(true);
    expect(fs.existsSync(path.join(boardDir(), 'kv', 'untracked.json'))).toBe(true);
    expect(git(projectPath, 'status', '--porcelain', '--untracked-files=no').toString()).toBe('');
  });

  it('reports a project folder outside a repository as untracked, and a tracked path as tracked', async () => {
    expect(await gitTrackedState(projectPath, '.clubhouse/plugin-data/kanboss')).toBe('untracked');
    git(projectPath, 'init', '-q');
    touch(path.join(boardDir(), 'a.json'));
    git(projectPath, 'add', '.');
    expect(await gitTrackedState(projectPath, '.clubhouse/plugin-data/kanboss')).toBe('tracked');
  });
});
