import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { cleanupRetiredPluginData } from './retired-plugin-cleanup';

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

  const run = () => cleanupRetiredPluginData({
    globalPluginDataDir: globalDir,
    communityPluginsDir: communityDir,
    projects: [{ id: 'proj_1', path: projectPath }],
  });

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
    const cleanupHome = () => cleanupRetiredPluginData({
      globalPluginDataDir: path.join(clubhouseDir, 'plugin-data'),
      communityPluginsDir: path.join(clubhouseDir, 'plugins'),
      projects: [{ id: 'proj_1', path: projectPath }],
    });

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
