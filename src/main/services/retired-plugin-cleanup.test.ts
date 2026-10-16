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

  it('removes retired feature dirs (Assistant workspace, Agent Queue state)', async () => {
    const assistantDir = path.join(root, 'home', '.clubhouse', 'assistant');
    const queuesDir = path.join(root, 'home', '.clubhouse', 'agent-queues');
    const keepDir = path.join(root, 'home', '.clubhouse', 'blueprints');
    touch(path.join(assistantDir, 'chat-history.json'));
    touch(path.join(queuesDir, 'registry.json'));
    touch(path.join(keepDir, 'bp.json'));

    const removed = await cleanupRetiredPluginData({
      globalPluginDataDir: globalDir,
      communityPluginsDir: communityDir,
      projects: [],
      retiredFeatureDirs: [assistantDir, queuesDir],
    });

    expect(removed).toEqual([assistantDir, queuesDir]);
    expect(fs.existsSync(keepDir)).toBe(true);
  });
});
