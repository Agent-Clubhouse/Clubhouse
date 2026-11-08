import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

vi.mock('./log-service', () => ({ appLog: vi.fn() }));

import { appLog } from './log-service';
import { buildRetiredPluginExport, findRetiredPluginData, noteRetiredPlugins } from './retired-plugin-data';

function touch(file: string, content = '{}'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Every file under `dir`, so a test can prove nothing was deleted. */
function snapshot(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[]).map((p) => p.toString()).sort();
}

describe('retired plugin data (#2756)', () => {
  let root: string;
  let globalDir: string;
  let communityDir: string;
  let projectPath: string;
  let opts: { globalPluginDataDir: string; communityPluginsDir: string; projects: { id: string; path: string }[] };

  beforeEach(async () => {
    vi.mocked(appLog).mockClear();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'retired-plugin-data-'));
    globalDir = path.join(root, 'plugin-data');
    communityDir = path.join(root, 'plugins');
    projectPath = path.join(root, 'project');
    opts = { globalPluginDataDir: globalDir, communityPluginsDir: communityDir, projects: [{ id: 'proj_1', path: projectPath }] };
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const loungeState = { customCircles: [{ id: 'c1', name: 'Frontend', agentIds: ['a1'] }], categoryOrder: ['c1'], agentOrder: { c1: ['a1'] } };

  it('finds global and per-project data, and whether the plugin is installed', async () => {
    touch(path.join(communityDir, 'kanboss', 'manifest.json'));
    touch(path.join(projectPath, '.clubhouse', 'plugin-data-local', 'kanboss', 'kv', 'boards.json'), '[]');
    touch(path.join(projectPath, '.clubhouse', 'plugin-data', 'kanboss', 'kv', 'cards:b1.json'), '[]');

    const found = await findRetiredPluginData('kanboss', opts);
    expect(found.installed).toBe(true);
    expect(found.locations.map((l) => l.scope)).toEqual(['project-local', 'project']);
    expect(found.locations[0].dir).toBe(path.join(projectPath, '.clubhouse', 'plugin-data-local', 'kanboss'));
  });

  it('refuses a plugin that is not retired', async () => {
    await expect(findRetiredPluginData('pomodoro', opts)).rejects.toThrow('not a retired plugin');
  });

  it('exports Lounge\'s circles, grouping and order as readable JSON, and deletes nothing', async () => {
    touch(path.join(globalDir, 'lounge', 'kv', 'lounge-state.json'), JSON.stringify(loungeState));
    touch(path.join(globalDir, 'lounge', 'notes.txt'), 'not json');
    const before = snapshot(root);

    const exported = await buildRetiredPluginExport('lounge', opts, new Date('2026-11-07T00:00:00Z'));

    expect(exported).toMatchObject({ plugin: 'lounge', name: 'Lounge', exportedAt: '2026-11-07T00:00:00.000Z' });
    expect(exported.locations).toHaveLength(1);
    expect(exported.locations[0].files['kv/lounge-state.json']).toEqual(loungeState);
    expect(exported.locations[0].files['notes.txt']).toBe('not json');
    expect(snapshot(root)).toEqual(before);
  });

  it('logs once per installed or data-holding retired plugin, then never again', async () => {
    const markerFile = path.join(globalDir, '_system', 'retired-plugins-noted.json');
    touch(path.join(globalDir, 'lounge', 'kv', 'lounge-state.json'), JSON.stringify(loungeState));
    touch(path.join(communityDir, 'bug-report', 'manifest.json'));
    const before = snapshot(root);

    expect((await noteRetiredPlugins({ ...opts, markerFile })).sort()).toEqual(['bug-report', 'lounge']);
    expect(vi.mocked(appLog)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(appLog)).toHaveBeenCalledWith('core:plugins', 'info', 'Lounge was retired and no longer loads. Its data was kept.', expect.objectContaining({
      meta: expect.objectContaining({ pluginId: 'lounge', dataDirs: [path.join(globalDir, 'lounge')] }),
    }));

    vi.mocked(appLog).mockClear();
    expect(await noteRetiredPlugins({ ...opts, markerFile })).toEqual([]);
    expect(vi.mocked(appLog)).not.toHaveBeenCalled();

    // Only the marker was added.
    expect(snapshot(root)).toEqual([...before, path.join('plugin-data', '_system'), path.join('plugin-data', '_system', 'retired-plugins-noted.json')].sort());
  });

  it('logs nothing when no retired plugin was ever installed', async () => {
    const markerFile = path.join(globalDir, '_system', 'retired-plugins-noted.json');
    expect(await noteRetiredPlugins({ ...opts, markerFile })).toEqual([]);
    expect(vi.mocked(appLog)).not.toHaveBeenCalled();
    expect(fs.existsSync(markerFile)).toBe(false);
  });
});
