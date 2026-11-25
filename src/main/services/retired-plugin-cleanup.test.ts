import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const logs = vi.hoisted(() => [] as Array<{ level: string; msg: string; meta?: Record<string, unknown> }>);
vi.mock('./log-service', () => ({
  appLog: (_ns: string, level: string, msg: string, opts?: { meta?: Record<string, unknown> }) => { logs.push({ level, msg, meta: opts?.meta }); },
}));
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

  it('leaves data alone when a community plugin in another folder declares the id hub', async () => {
    touch(path.join(communityDir, 'hub-fork', 'manifest.json'), JSON.stringify({ id: 'hub' }));
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
    logs.length = 0;
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('cleans up exactly Lounge, KanBoss and Bug Report', () => {
    expect([...RETIRED_WORKSHOP_PLUGIN_IDS].sort()).toEqual(['bug-report', 'kanboss', 'lounge']);
  });

  const manifest = (id: string) => JSON.stringify({ id, name: id, version: '1.0.0' });
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  const keptLogs = () => logs.filter((l) => l.msg.startsWith('Kept '));

  it('removes installed copies, their storage, settings and per-project local data, keeping other plugins', async () => {
    touch(path.join(communityDir, 'lounge', 'manifest.json'), manifest('lounge'));
    touch(path.join(globalDir, 'lounge', 'kv', 'lounge-state.json'), JSON.stringify({ customCircles: [{ id: 'c1' }] }));
    touch(path.join(kvDir, 'settings-app-lounge.json'));
    touch(path.join(communityDir, 'bug-report', 'manifest.json'), manifest('bug-report'));
    touch(path.join(kvDir, 'settings-proj_1-bug-report.json.bak'));
    // Found by its manifest id, whatever the folder is called.
    touch(path.join(communityDir, 'kanboss-2.1.0', 'manifest.json'), manifest('kanboss'));
    touch(path.join(projectPath, '.clubhouse', 'plugin-data-local', 'kanboss', 'kv', 'boards.json'));
    touch(path.join(globalDir, '_system', 'retired-plugins-noted.json'), '["lounge"]');
    // Must survive
    touch(path.join(communityDir, 'pomodoro', 'manifest.json'), manifest('pomodoro'));
    touch(path.join(communityDir, 'my-lounge', 'manifest.json'), manifest('my-lounge'));
    touch(path.join(kvDir, 'settings-app-my-lounge.json'));
    touch(path.join(globalDir, 'pomodoro', 'kv', 'x.json'));
    touch(path.join(projectPath, '.clubhouse', 'plugin-data-local', 'github-issues', 'kv', 'x.json'));

    const { removed, kept } = await run();

    const gone = [
      path.join(communityDir, 'lounge'),
      path.join(globalDir, 'lounge'),
      path.join(kvDir, 'settings-app-lounge.json'),
      path.join(communityDir, 'bug-report'),
      path.join(kvDir, 'settings-proj_1-bug-report.json.bak'),
      path.join(communityDir, 'kanboss-2.1.0'),
      path.join(projectPath, '.clubhouse', 'plugin-data-local', 'kanboss'),
      path.join(globalDir, '_system', 'retired-plugins-noted.json'),
    ];
    expect([...removed].sort()).toEqual([...gone].sort());
    expect(kept).toEqual([]);
    for (const p of gone) expect(fs.existsSync(p)).toBe(false);
    for (const p of [
      path.join(communityDir, 'pomodoro'),
      path.join(communityDir, 'my-lounge'),
      path.join(kvDir, 'settings-app-my-lounge.json'),
      path.join(globalDir, 'pomodoro'),
      path.join(projectPath, '.clubhouse', 'plugin-data-local', 'github-issues'),
    ]) expect(fs.existsSync(p)).toBe(true);
  });

  it('changes nothing on a re-run', async () => {
    touch(path.join(communityDir, 'lounge', 'manifest.json'), manifest('lounge'));
    touch(path.join(globalDir, 'lounge', 'kv', 'x.json'));
    touch(path.join(boardDir(), 'kv', 'board.json'));
    expect((await run()).removed).toHaveLength(3);

    logs.length = 0;
    expect(await run()).toEqual({ removed: [], kept: [] });
    expect(logs).toEqual([]);
  });

  it('keeps a folder named for a retired plugin whose manifest declares another plugin, with its git checkout', async () => {
    const fork = path.join(communityDir, 'kanboss');
    touch(path.join(fork, 'manifest.json'), manifest('kanboss-next'));
    touch(path.join(fork, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    touch(path.join(fork, 'src', 'uncommitted.ts'), 'work');

    const { removed, kept } = await run();

    expect(removed).toEqual([]);
    expect(kept).toEqual([{ path: fork, reason: 'not-retired-plugin' }]);
    expect(fs.existsSync(path.join(fork, 'src', 'uncommitted.ts'))).toBe(true);
    expect(fs.existsSync(path.join(fork, '.git', 'HEAD'))).toBe(true);
  });

  it('keeps an install of a retired plugin that holds a git checkout', async () => {
    const clone = path.join(communityDir, 'kanboss');
    touch(path.join(clone, 'manifest.json'), manifest('kanboss'));
    touch(path.join(clone, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    expect(await run()).toEqual({ removed: [], kept: [{ path: clone, reason: 'git-checkout' }] });
    expect(fs.existsSync(path.join(clone, 'manifest.json'))).toBe(true);
  });

  it('without a readable manifest, removes a marketplace install named for a retired plugin and keeps any other folder', async () => {
    touch(path.join(communityDir, 'lounge', '.marketplace'), '');
    touch(path.join(communityDir, 'lounge', 'dist', 'main.js'), '');
    touch(path.join(communityDir, 'bug-report', 'notes.txt'), 'mine');

    const { removed, kept } = await run();

    expect(removed).toEqual([path.join(communityDir, 'lounge')]);
    expect(kept).toEqual([{ path: path.join(communityDir, 'bug-report'), reason: 'not-retired-plugin' }]);
    expect(fs.existsSync(path.join(communityDir, 'bug-report', 'notes.txt'))).toBe(true);
  });

  it('removes a symlinked install named for a retired plugin with the marketplace marker, as a link only', async () => {
    const source = path.join(root, 'dev', 'kanboss');
    touch(path.join(source, 'manifest.json'), manifest('kanboss'));
    touch(path.join(source, '.marketplace'), '');
    touch(path.join(source, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.mkdirSync(communityDir, { recursive: true });
    fs.symlinkSync(source, path.join(communityDir, 'kanboss'), linkType);

    expect((await run()).removed).toEqual([path.join(communityDir, 'kanboss')]);
    expect(fs.existsSync(path.join(communityDir, 'kanboss'))).toBe(false);
    expect(fs.existsSync(path.join(source, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(source, '.git', 'HEAD'))).toBe(true);
  });

  it('keeps any other symlinked install, without reading its manifest through the link', async () => {
    const source = path.join(root, 'dev', 'lounge');
    touch(path.join(source, 'manifest.json'), manifest('lounge'));
    const elsewhere = path.join(root, 'dev', 'other');
    touch(path.join(elsewhere, 'manifest.json'), manifest('kanboss'));
    fs.mkdirSync(communityDir, { recursive: true });
    fs.symlinkSync(source, path.join(communityDir, 'lounge'), linkType);
    fs.symlinkSync(elsewhere, path.join(communityDir, 'my-link'), linkType);

    const { removed, kept } = await run();

    expect(removed).toEqual([]);
    expect(kept).toEqual([{ path: path.join(communityDir, 'lounge'), reason: 'linked' }]);
    expect(fs.lstatSync(path.join(communityDir, 'lounge')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(communityDir, 'my-link')).isSymbolicLink()).toBe(true);
  });

  it('keeps project storage reached through a symlinked .clubhouse, leaving the link target untouched', async () => {
    const outside = path.join(root, 'shared-clubhouse');
    touch(path.join(outside, 'plugin-data', 'kanboss', 'board.json'));
    touch(path.join(outside, 'plugin-data-local', 'lounge', 'state.json'));
    fs.symlinkSync(outside, path.join(projectPath, '.clubhouse'), linkType);

    const { removed, kept } = await run();

    expect(removed).toEqual([]);
    expect(kept).toEqual(expect.arrayContaining([
      { path: boardDir(), reason: 'linked' },
      { path: path.join(projectPath, '.clubhouse', 'plugin-data-local', 'lounge'), reason: 'linked' },
    ]));
    expect(kept).toHaveLength(2);
    expect(fs.existsSync(path.join(outside, 'plugin-data', 'kanboss', 'board.json'))).toBe(true);
    expect(fs.existsSync(path.join(outside, 'plugin-data-local', 'lounge', 'state.json'))).toBe(true);
  });

  it('keeps project storage under a symlinked plugin-data folder', async () => {
    const outside = path.join(root, 'shared-plugin-data');
    touch(path.join(outside, 'kanboss', 'board.json'));
    fs.mkdirSync(path.join(projectPath, '.clubhouse'), { recursive: true });
    fs.symlinkSync(outside, path.join(projectPath, '.clubhouse', 'plugin-data'), linkType);

    expect(await run()).toEqual({ removed: [], kept: [{ path: boardDir(), reason: 'linked' }] });
    expect(fs.existsSync(path.join(outside, 'kanboss', 'board.json'))).toBe(true);
  });

  it('removes symlinked data folders as links, leaving their targets', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    touch(path.join(elsewhere, 'global', 'keep.json'));
    touch(path.join(elsewhere, 'boards', 'keep.json'));
    fs.mkdirSync(globalDir, { recursive: true });
    fs.symlinkSync(path.join(elsewhere, 'global'), path.join(globalDir, 'lounge'), linkType);
    fs.mkdirSync(path.dirname(boardDir()), { recursive: true });
    fs.symlinkSync(path.join(elsewhere, 'boards'), boardDir(), linkType);

    const { removed } = await run();

    expect([...removed].sort()).toEqual([path.join(globalDir, 'lounge'), boardDir()].sort());
    expect(fs.existsSync(path.join(elsewhere, 'global', 'keep.json'))).toBe(true);
    expect(fs.existsSync(path.join(elsewhere, 'boards', 'keep.json'))).toBe(true);
  });

  it('deletes KanBoss project storage in a folder that is not a git repository', async () => {
    touch(path.join(boardDir(), 'kv', 'board.json'));

    expect(await run()).toEqual({ removed: [boardDir()], kept: [] });
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

  it('keeps project folders the repository tracks, project and local storage alike, and logs each once', async () => {
    git(projectPath, 'init', '-q');
    const localDir = path.join(projectPath, '.clubhouse', 'plugin-data-local', 'kanboss');
    touch(path.join(boardDir(), 'boards', 'b1.json'));
    touch(path.join(localDir, 'kv', 'state.json'));
    git(projectPath, 'add', '-f', '.');
    git(projectPath, 'commit', '-q', '-m', 'boards');
    touch(path.join(boardDir(), 'kv', 'untracked.json'));

    const first = await run();

    expect(first.removed).toEqual([]);
    expect(first.kept).toEqual(expect.arrayContaining([{ path: boardDir(), reason: 'tracked' }, { path: localDir, reason: 'tracked' }]));
    expect(first.kept).toHaveLength(2);
    expect(fs.existsSync(path.join(boardDir(), 'boards', 'b1.json'))).toBe(true);
    expect(fs.existsSync(path.join(boardDir(), 'kv', 'untracked.json'))).toBe(true);
    expect(git(projectPath, 'status', '--porcelain', '--untracked-files=no').toString()).toBe('');
    expect(keptLogs()).toHaveLength(2);

    // A second launch keeps them again, quietly.
    logs.length = 0;
    expect((await run()).kept).toHaveLength(2);
    expect(keptLogs()).toEqual([]);
  });

  it('keeps project storage when git can\'t say whether it is tracked', async () => {
    // A worktree pointer to a repository that is gone: git fails, but not with "outside every repository".
    touch(path.join(projectPath, '.git'), `gitdir: ${path.join(root, 'gone-repo')}\n`);
    touch(path.join(boardDir(), 'kv', 'board.json'));

    expect(await gitTrackedState(projectPath, '.clubhouse/plugin-data/kanboss')).toBe('unknown');
    expect(await run()).toEqual({ removed: [], kept: [{ path: boardDir(), reason: 'unknown' }] });
    expect(fs.existsSync(path.join(boardDir(), 'kv', 'board.json'))).toBe(true);
  });

  it('skips a project whose folder is gone', async () => {
    touch(path.join(globalDir, 'kanboss', 'kv', 'x.json'));
    const result = await cleanupRetiredPluginData({
      globalPluginDataDir: globalDir,
      communityPluginsDir: communityDir,
      projects: [{ id: 'gone', path: path.join(root, 'no-such-project') }],
    });
    expect(result).toEqual({ removed: [path.join(globalDir, 'kanboss')], kept: [] });
    expect(logs.filter((l) => l.level === 'warn')).toEqual([]);
  });

  it('reports a project folder outside a repository as untracked, and a tracked path as tracked', async () => {
    expect(await gitTrackedState(projectPath, '.clubhouse/plugin-data/kanboss')).toBe('untracked');
    git(projectPath, 'init', '-q');
    touch(path.join(boardDir(), 'a.json'));
    git(projectPath, 'add', '.');
    expect(await gitTrackedState(projectPath, '.clubhouse/plugin-data/kanboss')).toBe('tracked');
  });
});
