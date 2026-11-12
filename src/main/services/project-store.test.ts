import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(() => Promise.resolve([])),
  unlink: vi.fn(),
  copyFile: vi.fn(),
  rename: vi.fn(),
  realpath: vi.fn((p: string) => Promise.resolve(p)),
  stat: vi.fn(() => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))),
}));

vi.mock('./finished-quick-agents-store', () => ({
  moveFinishedQuickAgents: vi.fn(),
}));

vi.mock('./fs-utils', () => ({
  pathExists: vi.fn(),
}));

const mockBadgeSettings = { enabled: true, pluginBadges: true, projectRailBadges: true };
const mockSoundSettings = { activePack: null, eventSettings: {} };

vi.mock('./badge-settings', () => ({
  getSettings: vi.fn(() => ({ ...mockBadgeSettings })),
  saveSettings: vi.fn(),
}));

vi.mock('./sound-service', () => ({
  getSettings: vi.fn(() => ({ ...mockSoundSettings })),
  saveSettings: vi.fn(),
}));

// electron is aliased to our mock by vitest.config.ts
vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

import * as fsp from 'fs/promises';
import { appLog } from './log-service';
import { pathExists } from './fs-utils';
import { list, add, peekProjectsChecked, remove, update, reorder, readIconData, setIcon, saveCroppedIcon, removeIconFile, writeIconFile, onProjectsChanged, projectRegistryMutationState } from './project-store';
import { getSettings as getBadgeSettings, saveSettings as saveBadgeSettings } from './badge-settings';
import { getSettings as getSoundSettings, saveSettings as saveSoundSettings } from './sound-service';
import { moveFinishedQuickAgents } from './finished-quick-agents-store';

// The module uses app.getPath('home') which returns path.join(os.tmpdir(), 'clubhouse-test-home')
// and app.isPackaged = false → dirName = '.clubhouse-dev'
const BASE_DIR = path.join(os.tmpdir(), 'clubhouse-test-home', '.clubhouse-dev');
const STORE_PATH = path.join(BASE_DIR, 'projects.json');

function mockStoreFile(content: any) {
  vi.mocked(pathExists).mockImplementation(async (p: any) => {
    const s = String(p);
    if (s === STORE_PATH) return true;
    if (s === BASE_DIR) return true;
    if (s.includes('project-icons')) return true;
    return false;
  });
  vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
    if (String(p) === STORE_PATH) return JSON.stringify(content);
    return '';
  });
}

function mockNoStoreFile() {
  vi.mocked(pathExists).mockImplementation(async (p: any) => {
    const s = String(p);
    if (s === STORE_PATH) return false;
    if (s.includes('project-icons')) return true;
    return true; // base dir exists
  });
}

describe('registry mutation evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.readdir).mockResolvedValue([]);
    vi.mocked(fsp.rename).mockResolvedValue(undefined);
  });
  it.each(['update', 'migration', 'restore', 'quarantine'] as const)('marks real %s I/O pending before rename and clears it after failure', async (operation) => {
    const project = { id: 'proj_pending', name: 'Pending', path: '/pending' };
    mockStoreFile(operation === 'migration' ? [project] : { version: 1, projects: [project] });
    if (operation === 'restore') {
      vi.mocked(pathExists).mockImplementation(async (file) => String(file) !== STORE_PATH);
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({ version: 1, projects: [project] }));
    }
    if (operation === 'quarantine') vi.mocked(fsp.readFile).mockResolvedValue('broken');
    let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const before = projectRegistryMutationState();
    vi.mocked(fsp.rename).mockImplementationOnce(async () => { entered(); await hold; throw new Error('injected registry rename failure'); });
    const result = operation === 'update' ? update(project.id, { displayName: 'Changed' }) : list();
    // Attach rejection handling before releasing the injected failure.
    const settled = result.then(() => 'resolved', () => 'rejected');
    await waiting;
    expect(projectRegistryMutationState()).toMatchObject({ pending: true });
    expect(projectRegistryMutationState().generation).toBeGreaterThan(before.generation);
    release(); await settled;
    expect(projectRegistryMutationState().pending).toBe(false);
    expect(projectRegistryMutationState().generation).toBeGreaterThan(before.generation);
  });
});

describe('read logging (#2662)', () => {
  const lines = () => vi.mocked(appLog).mock.calls.filter(([ns]) => ns === 'core:project-store');
  const store = (name: string) => ({ version: 1, projects: [{ id: 'proj_log', name, path: path.join(os.tmpdir(), 'log-project') }] });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.readdir).mockResolvedValue([]);
  });

  it('logs nothing for repeat reads, and logs again when the list changes', async () => {
    mockStoreFile(store('first'));
    for (let i = 0; i < 50; i++) await list();
    expect(lines().map(([, , msg]) => msg)).toEqual(['Loaded 1 project(s) from disk']);
    mockStoreFile(store('renamed'));
    await list();
    await list();
    expect(lines()).toHaveLength(2);
    expect(lines()[1][3]?.meta?.projects).toEqual([{ id: 'proj_log', name: 'renamed' }]);
  });
});

describe('migrate (tested via list)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.readdir).mockResolvedValue([]);
  });

  it('null (no file) returns empty v1', async () => {
    mockNoStoreFile();
    expect(await list()).toEqual([]);
  });

  it('bare array (v0) migrates to v1', async () => {
    const projects = [{ id: 'proj_1', name: 'Test', path: '/test' }];
    mockStoreFile(projects);
    const result = await list();
    expect(result).toEqual(projects);
    // Should have written a migrated file
    expect(vi.mocked(fsp.writeFile)).toHaveBeenCalled();
  });

  it('v1 object returned as-is', async () => {
    const store = { version: 1, projects: [{ id: 'proj_1', name: 'Test', path: '/test' }] };
    mockStoreFile(store);
    const result = await list();
    expect(result).toEqual(store.projects);
  });

  it('future version with projects preserves data', async () => {
    const store = { version: 99, projects: [{ id: 'proj_1', name: 'Future', path: '/future' }] };
    mockStoreFile(store);
    const result = await list();
    expect(result).toEqual(store.projects);
  });

  it('future version without projects returns empty', async () => {
    const store = { version: 99, data: 'unknown' };
    mockStoreFile(store);
    const result = await list();
    expect(result).toEqual([]);
  });
});

describe('list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.readdir).mockResolvedValue([]);
  });

  it('returns [] when no file', async () => {
    mockNoStoreFile();
    expect(await list()).toEqual([]);
  });

  it('returns [] on corrupt JSON', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(fsp.readFile).mockResolvedValue('{{invalid');
    expect(await list()).toEqual([]);
  });
});

describe('add', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.readdir).mockResolvedValue([]);
    mockNoStoreFile();
  });

  it('generates proj_ prefixed ID and uses basename as name', async () => {
    let _writtenData = '';
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { _writtenData = String(data); });
    const project = await add('/Users/me/my-project');
    expect(project.id).toMatch(/^proj_/);
    expect(project.name).toBe('my-project');
    expect(project.path).toBe('/Users/me/my-project');
  });

  /** projects.json in memory: writes land on rename, as the store writes them. */
  function memoryStore(initial?: unknown) {
    let content: string | null = initial === undefined ? null : JSON.stringify(initial);
    const pending = new Map<string, string>();
    vi.mocked(pathExists).mockImplementation(async (p: any) => (String(p) === STORE_PATH ? content !== null : !String(p).endsWith('.json')));
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p) === STORE_PATH && content !== null) return content;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { pending.set(String(p), String(data)); });
    vi.mocked(fsp.rename).mockImplementation(async (from: any, to: any) => {
      if (String(to) === STORE_PATH && pending.has(String(from))) content = pending.get(String(from))!;
    });
    return { projects: () => (content ? JSON.parse(content).projects : []) };
  }

  it('returns the existing project for a folder already registered, and writes nothing (#3236)', async () => {
    const store = memoryStore();
    const dir = path.join(os.tmpdir(), 'dupe-check', 'shop');
    const first = await add(dir);
    vi.mocked(fsp.rename).mockClear();

    const again = await add(dir + path.sep);
    const dotted = await add(path.join(dir, '..', 'shop'));

    expect(again).toEqual(first);
    expect(dotted).toEqual(first);
    expect(store.projects()).toHaveLength(1);
    expect(fsp.rename).not.toHaveBeenCalled();
  });

  it('matches a folder by its real path, through a link', async () => {
    const store = memoryStore();
    const real = path.join(os.tmpdir(), 'dupe-check', 'real');
    const link = path.join(os.tmpdir(), 'dupe-check', 'link');
    vi.mocked(fsp.realpath).mockImplementation(async (p: any) => (String(p) === link ? real : String(p)));
    const first = await add(real);
    expect(await add(link)).toEqual(first);
    expect(store.projects()).toHaveLength(1);
  });

  /** Folders on disk by inode: the same number is the same folder, whatever the spelling. */
  function inodes(map: Record<string, number>) {
    vi.mocked(fsp.stat).mockImplementation((async (p: any) => {
      const ino = map[path.resolve(String(p))];
      if (ino === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { dev: 1n, ino: BigInt(ino) };
    }) as any);
  }

  it('matches another case of a folder when the disk says it is the same folder', async () => {
    const store = memoryStore();
    const dir = path.join(os.tmpdir(), 'dupe-check', 'Shop');
    inodes({ [dir]: 7, [dir.toUpperCase()]: 7 });
    const first = await add(dir);
    expect(await add(dir.toUpperCase())).toEqual(first);
    expect(store.projects()).toHaveLength(1);
  });

  it('keeps two folders whose names differ only in case, on a volume that tells them apart (#3236)', async () => {
    const lower = path.join(os.tmpdir(), 'dupe-check', 'shop');
    const upper = path.join(os.tmpdir(), 'dupe-check', 'Shop');
    inodes({ [lower]: 7, [upper]: 8 });
    const store = memoryStore();
    const a = await add(lower);
    const b = await add(upper);
    expect(a.id).not.toBe(b.id);
    expect(store.projects().map((p: { path: string }) => p.path)).toEqual([lower, upper]);

    // And loading them again merges nothing: case never folds without the disk.
    vi.mocked(appLog).mockClear();
    expect((await list()).map((p) => p.id)).toEqual([a.id, b.id]);
    expect(appLog).not.toHaveBeenCalledWith('core:project-store', 'warn', expect.stringContaining('Merged'), expect.anything());
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')('falls back to ignoring case only when a folder can\'t be read', async () => {
    const store = memoryStore();
    const dir = path.join(os.tmpdir(), 'dupe-check', 'Gone');
    const first = await add(dir);
    expect(await add(dir.toUpperCase())).toEqual(first);
    expect(store.projects()).toHaveLength(1);
  });

  it('keeps a readable folder apart from a stale record that differs only in case', async () => {
    const store = memoryStore();
    const gone = path.join(os.tmpdir(), 'dupe-check', 'Old');
    const first = await add(gone);
    // Only the new spelling is on disk: on a volume that ignored case, the old one would be readable too.
    inodes({ [gone.toUpperCase()]: 9 });
    const second = await add(gone.toUpperCase());
    expect(second.id).not.toBe(first.id);
    expect(store.projects()).toHaveLength(2);
  });

  it('makes one project when the same folder is added twice at once', async () => {
    const store = memoryStore();
    const dir = path.join(os.tmpdir(), 'dupe-check', 'race');
    const [a, b] = await Promise.all([add(dir), add(dir)]);
    expect(a.id).toBe(b.id);
    expect(store.projects()).toHaveLength(1);
  });

  it('merges legacy duplicates on load into the first record, moving overrides, and logs it (#3236)', async () => {
    const dir = path.join(os.tmpdir(), 'dupe-check', 'legacy');
    const store = memoryStore({
      version: 1,
      projects: [
        { id: 'proj_a', name: 'legacy', path: dir, color: 'indigo' },
        { id: 'proj_b', name: 'legacy', path: dir, color: 'rose', displayName: 'Legacy', emoji: '🛒', orchestrator: 'codex-cli' },
      ],
    });
    vi.mocked(getBadgeSettings).mockReturnValueOnce({ ...mockBadgeSettings, projectOverrides: { proj_b: { enabled: false } } } as any);

    const projects = await list();

    expect(projects).toEqual([{ id: 'proj_a', name: 'legacy', path: dir, color: 'indigo', displayName: 'Legacy', emoji: '🛒', orchestrator: 'codex-cli' }]);
    expect(store.projects().map((p: { id: string }) => p.id)).toEqual(['proj_a']);
    expect(saveBadgeSettings).toHaveBeenCalledWith(expect.objectContaining({ projectOverrides: { proj_a: { enabled: false } } }));
    expect(moveFinishedQuickAgents).toHaveBeenCalledWith('proj_b', 'proj_a');
    expect(appLog).toHaveBeenCalledWith('core:project-store', 'warn', expect.stringContaining('Merged 1 duplicate'), expect.anything());
  });

  it('merges duplicates recovered from the backup the same way', async () => {
    const dir = path.join(os.tmpdir(), 'dupe-check', 'from-backup');
    const backup = path.join(BASE_DIR, 'projects.json.bak');
    const content = JSON.stringify({ version: 1, projects: [{ id: 'proj_a', name: 'b', path: dir }, { id: 'proj_b', name: 'b', path: dir, color: 'rose' }] });
    vi.mocked(pathExists).mockImplementation(async (p: any) => String(p) === backup || !String(p).endsWith('.json') && !String(p).endsWith('.bak'));
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p) === backup) return content;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    expect(await list()).toEqual([{ id: 'proj_a', name: 'b', path: dir, color: 'rose' }]);
    expect(moveFinishedQuickAgents).toHaveBeenCalledWith('proj_b', 'proj_a');
    expect(appLog).toHaveBeenCalledWith('core:project-store', 'warn', expect.stringContaining('Merged 1 duplicate'), expect.objectContaining({ meta: expect.objectContaining({ file: backup }) }));
  });

  it('keeps case-variant records apart on load', async () => {
    const lower = path.join(os.tmpdir(), 'dupe-check', 'repo');
    const upper = path.join(os.tmpdir(), 'dupe-check', 'Repo');
    memoryStore({ version: 1, projects: [{ id: 'proj_a', name: 'repo', path: lower }, { id: 'proj_b', name: 'Repo', path: upper }] });
    expect((await list()).map((p) => p.id)).toEqual(['proj_a', 'proj_b']);
    expect(moveFinishedQuickAgents).not.toHaveBeenCalled();
  });
});

describe('onProjectsChanged', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.rename).mockResolvedValue(undefined);
    vi.mocked(fsp.copyFile).mockResolvedValue(undefined);
    vi.mocked(fsp.readdir).mockResolvedValue([]);
  });

  it('fires after a project is removed or renamed, and stops once unsubscribed', async () => {
    mockStoreFile({ version: 1, projects: [{ id: 'proj_a', name: 'A', path: path.join(os.tmpdir(), 'a') }] });
    const listener = vi.fn();
    const unsubscribe = onProjectsChanged(listener);

    await update('proj_a', { displayName: 'Renamed' });
    expect(listener).toHaveBeenCalledTimes(1);
    await remove('proj_a');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    await remove('proj_a');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('remove', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
  });

  it('filters by id and cleans up icon when project has no icon', async () => {
    const store = {
      version: 1,
      projects: [
        { id: 'proj_keep', name: 'Keep', path: '/keep' },
        { id: 'proj_del', name: 'Del', path: '/del' },
      ],
    };
    mockStoreFile(store);
    vi.mocked(fsp.readdir).mockResolvedValue(['proj_del.png'] as any);

    let writtenData = '';
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      // Capture JSON string writes (projects.json writes)
      if (typeof data === 'string' && data.includes('version')) writtenData = String(data);
    });
    vi.mocked(fsp.rename).mockResolvedValue(undefined);
    vi.mocked(fsp.copyFile).mockResolvedValue(undefined);

    await remove('proj_del');
    const result = JSON.parse(writtenData);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].id).toBe('proj_keep');
    expect(vi.mocked(fsp.unlink)).toHaveBeenCalled();
  });

  it('serializes concurrent removals to avoid resurrecting a project', async () => {
    const initial = {
      version: 1,
      projects: [
        { id: 'proj_a', name: 'A', path: '/a' },
        { id: 'proj_b', name: 'B', path: '/b' },
      ],
    };

    let current = structuredClone(initial);
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s === STORE_PATH || s === BASE_DIR) return true;
      if (s.includes('project-icons')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockImplementation(async () => JSON.stringify(current));
    vi.mocked(fsp.writeFile).mockImplementation(async (_p: any, data: any) => {
      if (typeof data === 'string' && data.includes('"version"')) {
        current = JSON.parse(data);
      }
    });
    vi.mocked(fsp.readdir).mockResolvedValue([]);
    vi.mocked(fsp.rename).mockResolvedValue(undefined);
    vi.mocked(fsp.copyFile).mockResolvedValue(undefined);

    await Promise.all([remove('proj_a'), remove('proj_b')]);

    expect(current.projects).toEqual([]);
  });

  it('preserves icon file when project has an icon', async () => {
    const store = {
      version: 1,
      projects: [
        { id: 'proj_del', name: 'Del', path: '/del', icon: 'proj_del.png' },
      ],
    };
    mockStoreFile(store);
    vi.mocked(fsp.readdir).mockResolvedValue(['proj_del.png'] as any);

    let writtenData = '';
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      // Capture JSON string writes (projects.json writes)
      if (typeof data === 'string' && data.includes('version')) writtenData = String(data);
    });
    vi.mocked(fsp.rename).mockResolvedValue(undefined);
    vi.mocked(fsp.copyFile).mockResolvedValue(undefined);

    await remove('proj_del');
    const result = JSON.parse(writtenData);
    expect(result.projects).toHaveLength(0);
    // Icon file should be renamed (preserved), not deleted
    // Note: with atomic writes, rename is called twice - once for icon preservation, once for writeStore
    expect(vi.mocked(fsp.rename)).toHaveBeenCalled();
    expect(vi.mocked(fsp.unlink)).not.toHaveBeenCalled();
    // Preserved filename should use _preserved_ prefix with path hash (first rename call)
    const renameCall = vi.mocked(fsp.rename).mock.calls[0];
    expect(String(renameCall[0])).toContain('proj_del.png');
    expect(String(renameCall[1])).toMatch(/_preserved_[0-9a-f]+\.png/);
  });
});

describe('icon preservation across close/reopen (#209)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
  });

  it('re-adding same path restores the preserved icon', async () => {
    // First, the preserved icon file exists from a previous remove
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update('/my-project').digest('hex').slice(0, 16);
    const preservedFile = `_preserved_${hash}.png`;

    mockNoStoreFile();
    vi.mocked(fsp.readdir).mockResolvedValue([preservedFile] as any);
    vi.mocked(fsp.rename).mockResolvedValue(undefined);
    vi.mocked(fsp.copyFile).mockResolvedValue(undefined);

    const project = await add('/my-project');

    // The project should have its icon restored
    expect(project.icon).toBeDefined();
    expect(project.icon).toContain(project.id);
    expect(project.icon).toMatch(/\.png$/);

    // The preserved file should be renamed to the new project ID (first rename call)
    expect(vi.mocked(fsp.rename)).toHaveBeenCalled();
    // Find the rename call that restores the icon (not the atomic write rename)
    const iconRenameCall = vi.mocked(fsp.rename).mock.calls.find((call) =>
      String(call[0]).includes(preservedFile),
    );
    expect(iconRenameCall).toBeDefined();
    expect(String(iconRenameCall![1])).toContain(project.id);
  });

  it('add without preserved icon returns no icon', async () => {
    mockNoStoreFile();
    vi.mocked(fsp.readdir).mockResolvedValue([]);
    vi.mocked(fsp.rename).mockResolvedValue(undefined);
    vi.mocked(fsp.copyFile).mockResolvedValue(undefined);

    const project = await add('/brand-new-project');
    expect(project.icon).toBeUndefined();
    // With atomic writes, rename is called for writeStore, not for icon restoration
    // The key point is that there's no icon to restore, not that rename wasn't called
  });

  it('different paths get different preserved keys', async () => {
    const crypto = require('crypto');
    const hash1 = crypto.createHash('sha256').update('/project-a').digest('hex').slice(0, 16);
    const hash2 = crypto.createHash('sha256').update('/project-b').digest('hex').slice(0, 16);

    // Only project-a has a preserved icon
    const preservedFile = `_preserved_${hash1}.png`;
    mockNoStoreFile();
    vi.mocked(fsp.readdir).mockResolvedValue([preservedFile] as any);

    // Adding project-b should not pick up project-a's icon
    const projectB = await add('/project-b');
    expect(projectB.icon).toBeUndefined();

    // Sanity check: hashes differ
    expect(hash1).not.toBe(hash2);
  });
});

describe('settings preservation across close/reopen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
  });

  it('remove preserves displayName, color, orchestrator, and previous ID to sidecar', async () => {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update('/my-project').digest('hex').slice(0, 16);

    const store = {
      version: 1,
      projects: [
        { id: 'proj_del', name: 'MyProj', path: '/my-project', displayName: 'Workshop', color: 'emerald', orchestrator: 'claude' },
      ],
    };
    mockStoreFile(store);
    vi.mocked(fsp.readdir).mockResolvedValue([]);

    const writtenFiles: Record<string, string> = {};
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { writtenFiles[String(p)] = String(data); });

    await remove('proj_del');

    const sidecarPath = path.join(BASE_DIR, `_preserved_${hash}.json`);
    expect(writtenFiles[sidecarPath]).toBeDefined();
    const saved = JSON.parse(writtenFiles[sidecarPath]);
    expect(saved._previousId).toBe('proj_del');
    expect(saved.displayName).toBe('Workshop');
    expect(saved.color).toBe('emerald');
    expect(saved.orchestrator).toBe('claude');
  });

  it('remove with no custom settings still writes sidecar with previous ID', async () => {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update('/plain').digest('hex').slice(0, 16);

    const store = {
      version: 1,
      projects: [
        { id: 'proj_plain', name: 'Plain', path: '/plain' },
      ],
    };
    mockStoreFile(store);
    vi.mocked(fsp.readdir).mockResolvedValue(['proj_plain.png'] as any);

    const writtenFiles: Record<string, string> = {};
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { writtenFiles[String(p)] = String(data); });

    await remove('proj_plain');

    // Sidecar should still be written with _previousId for override migration
    const sidecarPath = path.join(BASE_DIR, `_preserved_${hash}.json`);
    expect(writtenFiles[sidecarPath]).toBeDefined();
    const saved = JSON.parse(writtenFiles[sidecarPath]);
    expect(saved._previousId).toBe('proj_plain');
  });

  it('re-adding same path restores preserved settings', async () => {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update('/my-project').digest('hex').slice(0, 16);
    const sidecarPath = path.join(BASE_DIR, `_preserved_${hash}.json`);

    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s === sidecarPath) return true;
      if (s.includes('project-icons')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p) === sidecarPath) return JSON.stringify({ _previousId: 'proj_old', displayName: 'Workshop', color: 'emerald' });
      return '';
    });
    vi.mocked(fsp.readdir).mockResolvedValue([]);
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

    const project = await add('/my-project');

    expect(project.displayName).toBe('Workshop');
    expect(project.color).toBe('emerald');
    expect(vi.mocked(fsp.unlink)).toHaveBeenCalledWith(sidecarPath);
  });

  it('re-adding different path does not pick up another path settings', async () => {
    const crypto = require('crypto');
    const hashA = crypto.createHash('sha256').update('/project-a').digest('hex').slice(0, 16);
    const hashB = crypto.createHash('sha256').update('/project-b').digest('hex').slice(0, 16);
    const sidecarA = path.join(BASE_DIR, `_preserved_${hashA}.json`);

    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s === sidecarA) return true;
      if (s.includes('project-icons')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p) === sidecarA) return JSON.stringify({ _previousId: 'proj_a_old', displayName: 'A Name' });
      return '';
    });
    vi.mocked(fsp.readdir).mockResolvedValue([]);
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

    const projectB = await add('/project-b');

    expect(projectB.displayName).toBeUndefined();
    expect(hashA).not.toBe(hashB);
  });

  it('migrates badge overrides from old project ID to new ID on re-add', async () => {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update('/my-project').digest('hex').slice(0, 16);
    const sidecarPath = path.join(BASE_DIR, `_preserved_${hash}.json`);

    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s === sidecarPath) return true;
      if (s.includes('project-icons')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p) === sidecarPath) return JSON.stringify({ _previousId: 'proj_old_123' });
      return '';
    });
    vi.mocked(fsp.readdir).mockResolvedValue([]);
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

    // Badge settings have an override for the old project ID
    const badgeOverrides = { enabled: false, pluginBadges: false };
    vi.mocked(getBadgeSettings).mockReturnValue({
      enabled: true, pluginBadges: true, projectRailBadges: true,
      projectOverrides: { proj_old_123: badgeOverrides },
    });
    vi.mocked(getSoundSettings).mockReturnValue({ activePack: null, eventSettings: {} as any });

    const project = await add('/my-project');

    // Badge settings should be saved with the override migrated to the new ID
    expect(saveBadgeSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        projectOverrides: expect.objectContaining({
          [project.id]: badgeOverrides,
        }),
      }),
    );
    // Old key should be removed
    const savedBadge = vi.mocked(saveBadgeSettings).mock.calls[0][0];
    expect(savedBadge.projectOverrides).not.toHaveProperty('proj_old_123');
  });

  it('migrates sound overrides from old project ID to new ID on re-add', async () => {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update('/my-project').digest('hex').slice(0, 16);
    const sidecarPath = path.join(BASE_DIR, `_preserved_${hash}.json`);

    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s === sidecarPath) return true;
      if (s.includes('project-icons')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p) === sidecarPath) return JSON.stringify({ _previousId: 'proj_old_456' });
      return '';
    });
    vi.mocked(fsp.readdir).mockResolvedValue([]);
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

    vi.mocked(getBadgeSettings).mockReturnValue({ enabled: true, pluginBadges: true, projectRailBadges: true });
    const soundOverride = { activePack: 'retro-sounds' };
    vi.mocked(getSoundSettings).mockReturnValue({
      activePack: null, eventSettings: {} as any,
      projectOverrides: { proj_old_456: soundOverride },
    });

    const project = await add('/my-project');

    expect(saveSoundSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        projectOverrides: expect.objectContaining({
          [project.id]: soundOverride,
        }),
      }),
    );
    const savedSound = vi.mocked(saveSoundSettings).mock.calls[0][0];
    expect(savedSound.projectOverrides).not.toHaveProperty('proj_old_456');
  });

  it('skips migration when no previous ID in sidecar', async () => {
    mockNoStoreFile();
    vi.mocked(fsp.readdir).mockResolvedValue([]);

    await add('/brand-new-project');

    expect(saveBadgeSettings).not.toHaveBeenCalled();
    expect(saveSoundSettings).not.toHaveBeenCalled();
  });
});

describe('update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.readdir).mockResolvedValue([]);
  });

  it('sets/clears color, icon, name correctly', async () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_up', name: 'Old', path: '/test', color: 'indigo' }],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { writtenData = String(data); });

    // Update name and color
    await update('proj_up', { name: 'New', color: 'amber' });
    let result = JSON.parse(writtenData);
    expect(result.projects[0].name).toBe('New');
    expect(result.projects[0].color).toBe('amber');

    // Clear color
    mockStoreFile(result);
    await update('proj_up', { color: '' });
    result = JSON.parse(writtenData);
    expect(result.projects[0].color).toBeUndefined();
  });

  it('empty string name is ignored', async () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_name', name: 'Original', path: '/test' }],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { writtenData = String(data); });

    await update('proj_name', { name: '' });
    const result = JSON.parse(writtenData);
    expect(result.projects[0].name).toBe('Original');
  });

  it('non-existent id is a no-op', async () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_exist', name: 'Exist', path: '/test' }],
    };
    mockStoreFile(store);

    const result = await update('nonexistent', { name: 'New' });
    expect(result).toEqual(store.projects);
  });
});

describe('reorder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.readdir).mockResolvedValue([]);
  });

  it('reorders by orderedIds and appends missing', async () => {
    const store = {
      version: 1,
      projects: [
        { id: 'proj_a', name: 'A', path: '/a' },
        { id: 'proj_b', name: 'B', path: '/b' },
        { id: 'proj_c', name: 'C', path: '/c' },
      ],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { writtenData = String(data); });

    // Reorder to C, A — B should be appended
    await reorder(['proj_c', 'proj_a']);
    const result = JSON.parse(writtenData);
    expect(result.projects.map((p: any) => p.id)).toEqual(['proj_c', 'proj_a', 'proj_b']);
  });
});

describe('sequential update correctness (no lost updates)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.readdir).mockResolvedValue([]);
  });

  it('sequential add() calls do not lose projects', async () => {
    // Simulate file I/O: writeFile updates what readFile returns
    let fileContent = JSON.stringify({ version: 1, projects: [] });
    let lastWrittenData = '';
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s === STORE_PATH) return true;
      if (s.includes('project-icons')) return true;
      if (s.includes('.bak')) return false; // backup doesn't exist yet
      return true;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p) === STORE_PATH) return fileContent;
      return '';
    });
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      // Capture temp file writes
      if (typeof data === 'string' && data.includes('version')) {
        lastWrittenData = String(data);
      }
    });
    vi.mocked(fsp.rename).mockImplementation(async (src: any, dst: any) => {
      // Atomic write: temp -> STORE_PATH
      if (String(dst) === STORE_PATH && lastWrittenData) {
        fileContent = lastWrittenData;
      }
    });
    vi.mocked(fsp.copyFile).mockResolvedValue(undefined);

    await add('/project-a');
    await add('/project-b');
    await add('/project-c');

    const result = JSON.parse(fileContent);
    expect(result.projects).toHaveLength(3);
  });

  it('sequential update() calls each see the result of the previous update', async () => {
    const initial = {
      version: 1,
      projects: [
        { id: 'proj_1', name: 'One', path: '/one' },
        { id: 'proj_2', name: 'Two', path: '/two' },
      ],
    };
    let fileContent = JSON.stringify(initial);
    let lastWrittenData = '';
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s === STORE_PATH) return true;
      if (s.includes('project-icons')) return true;
      if (s.includes('.bak')) return false; // backup doesn't exist yet
      return true;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p) === STORE_PATH) return fileContent;
      return '';
    });
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      // Capture temp file writes
      if (typeof data === 'string' && data.includes('version')) {
        lastWrittenData = String(data);
      }
    });
    vi.mocked(fsp.rename).mockImplementation(async (src: any, dst: any) => {
      // Atomic write: temp -> STORE_PATH
      if (String(dst) === STORE_PATH && lastWrittenData) {
        fileContent = lastWrittenData;
      }
    });
    vi.mocked(fsp.copyFile).mockResolvedValue(undefined);

    await update('proj_1', { displayName: 'First' });
    await update('proj_2', { displayName: 'Second' });

    const result = JSON.parse(fileContent);
    // Both updates should be present — neither should be lost
    expect(result.projects[0].displayName).toBe('First');
    expect(result.projects[1].displayName).toBe('Second');
  });

  it('sequential remove() calls do not lose removals', async () => {
    const initial = {
      version: 1,
      projects: [
        { id: 'proj_a', name: 'A', path: '/a' },
        { id: 'proj_b', name: 'B', path: '/b' },
        { id: 'proj_c', name: 'C', path: '/c' },
      ],
    };
    let fileContent = JSON.stringify(initial);
    let lastWrittenData = '';
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s === STORE_PATH) return true;
      if (s.includes('project-icons')) return true;
      if (s.includes('.bak')) return false; // backup doesn't exist yet
      return true;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p) === STORE_PATH) return fileContent;
      return '';
    });
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      // Capture temp file writes
      if (typeof data === 'string' && data.includes('version')) {
        lastWrittenData = String(data);
      }
    });
    vi.mocked(fsp.rename).mockImplementation(async (src: any, dst: any) => {
      // Atomic write: temp -> STORE_PATH
      if (String(dst) === STORE_PATH && lastWrittenData) {
        fileContent = lastWrittenData;
      }
    });
    vi.mocked(fsp.copyFile).mockResolvedValue(undefined);

    await remove('proj_a');
    await remove('proj_c');

    const result = JSON.parse(fileContent);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].id).toBe('proj_b');
  });

  it('update() does not mutate the projects array read from disk', async () => {
    const initial = {
      version: 1,
      projects: [
        { id: 'proj_1', name: 'Original', path: '/test', color: 'blue' },
      ],
    };
    mockStoreFile(initial);

    let capturedProjects: any[] | undefined;
    const originalReadFile = vi.mocked(fsp.readFile).getMockImplementation();
    vi.mocked(fsp.readFile).mockImplementation(async (p: any, ...args: any[]) => {
      const data = await originalReadFile?.(p, ...args);
      if (String(p) === STORE_PATH) {
        const parsed = JSON.parse(String(data));
        capturedProjects = parsed.projects;
      }
      return data;
    });

    let writtenData = '';
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { writtenData = String(data); });

    await update('proj_1', { color: 'red' });

    // The written data should have the updated color
    const result = JSON.parse(writtenData);
    expect(result.projects[0].color).toBe('red');

    // The original projects array should not have been mutated
    expect(capturedProjects?.[0].color).toBe('blue');
  });
});

describe('readIconData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
  });

  it('correct MIME types', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(fsp.readFile).mockResolvedValue(Buffer.from('fake-image'));

    const png = await readIconData('proj.png');
    expect(png).toContain('data:image/png;base64,');

    const jpg = await readIconData('proj.jpg');
    expect(jpg).toContain('data:image/jpeg;base64,');

    const svg = await readIconData('proj.svg');
    expect(svg).toContain('data:image/svg+xml;base64,');
  });

  it('null when file missing', async () => {
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      // Icons dir creation check — return true for dir, false for file
      if (String(p).includes('project-icons') && !String(p).includes('.')) return true;
      return false;
    });
    const result = await readIconData('missing.png');
    expect(result).toBeNull();
  });

  it('base64 encoding', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    const testData = Buffer.from('test-data');
    vi.mocked(fsp.readFile).mockResolvedValue(testData);

    const result = await readIconData('test.png');
    expect(result).toBe(`data:image/png;base64,${testData.toString('base64')}`);
  });
});

// ── Filesystem Error Handling ──────────────────────────────────────────

describe('filesystem error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.readdir).mockResolvedValue([]);
  });

  it('writeFile failure during add does not corrupt state', async () => {
    mockNoStoreFile();
    vi.mocked(fsp.writeFile).mockRejectedValue(new Error('ENOSPC: no space left on device'));

    await expect(add('/test-project')).rejects.toThrow('ENOSPC');
  });

  it('writeFile failure during update propagates error', async () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_1', name: 'Test', path: '/test' }],
    };
    mockStoreFile(store);
    vi.mocked(fsp.writeFile).mockRejectedValue(new Error('EACCES: permission denied'));

    await expect(update('proj_1', { name: 'New' })).rejects.toThrow('EACCES');
  });

  it('readFile throwing non-JSON error returns empty list', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(fsp.readFile).mockRejectedValue(new Error('EACCES: permission denied'));
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

    expect(await list()).toEqual([]);
  });

  it('readdir failure in removeIconFile is silently caught', async () => {
    vi.mocked(fsp.readdir).mockRejectedValue(new Error('ENOENT: no such file or directory'));
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

    // Should not throw
    await expect(removeIconFile('proj_1')).resolves.not.toThrow();
  });

  it('unlink failure in removeIconFile is silently caught', async () => {
    vi.mocked(fsp.readdir).mockResolvedValue(['proj_1.png'] as any);
    vi.mocked(fsp.unlink).mockRejectedValue(new Error('EPERM: operation not permitted'));
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(pathExists).mockResolvedValue(true);

    // The function catches errors from the icons dir operations
    await expect(removeIconFile('proj_1')).resolves.not.toThrow();
  });

  it('copyFile failure in setIcon propagates error', async () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_icon', name: 'Test', path: '/test' }],
    };
    mockStoreFile(store);
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.copyFile).mockRejectedValue(new Error('ENOENT: source file not found'));

    await expect(setIcon('proj_icon', '/missing/image.png')).rejects.toThrow('ENOENT');
  });

  it('rename failure during icon preservation is silently caught', async () => {
    const store = {
      version: 1,
      projects: [
        { id: 'proj_rename', name: 'Test', path: '/test', icon: 'proj_rename.png' },
      ],
    };
    mockStoreFile(store);
    vi.mocked(fsp.readdir).mockResolvedValue(['proj_rename.png'] as any);
    
    // Mock rename to fail for icon preservation but succeed for atomic write
    vi.mocked(fsp.rename).mockImplementation(async (src: any, dst: any) => {
      // Atomic write rename (temp -> projects.json) should succeed
      if (String(dst) === STORE_PATH) {
        return Promise.resolve(undefined);
      }
      // Icon preservation rename should fail
      throw new Error('EXDEV: cross-device link not permitted');
    });

    let writtenData = '';
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      // Capture JSON string writes (projects.json writes)
      if (typeof data === 'string' && data.includes('version')) writtenData = String(data);
    });
    vi.mocked(fsp.copyFile).mockResolvedValue(undefined);

    // remove() preserves icon via rename — failure is caught
    await expect(remove('proj_rename')).resolves.not.toThrow();
    const result = JSON.parse(writtenData);
    expect(result.projects).toHaveLength(0);
  });

  it('corrupt preserved settings sidecar returns empty object gracefully', async () => {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update('/corrupt-project').digest('hex').slice(0, 16);
    const sidecarPath = path.join(BASE_DIR, `_preserved_${hash}.json`);

    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s === sidecarPath) return true;
      if (s.includes('project-icons')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p) === sidecarPath) return '{{invalid json';
      return '';
    });
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

    // Should not throw and should not apply any restored settings
    const project = await add('/corrupt-project');
    expect(project.displayName).toBeUndefined();
    expect(project.color).toBeUndefined();
  });
});

// ── setIcon edge cases ─────────────────────────────────────────────────

describe('setIcon', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.readdir).mockResolvedValue([]);
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.copyFile).mockResolvedValue(undefined);
  });

  it('copies file and updates project icon field', async () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_si', name: 'Test', path: '/test' }],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      // Capture JSON string writes (projects.json writes)
      if (typeof data === 'string' && data.includes('version')) writtenData = String(data);
    });
    vi.mocked(fsp.rename).mockResolvedValue(undefined);
    vi.mocked(fsp.copyFile).mockResolvedValue(undefined);

    const filename = await setIcon('proj_si', '/tmp/icon.png');
    expect(filename).toBe('proj_si.png');
    expect(vi.mocked(fsp.copyFile)).toHaveBeenCalled();

    const result = JSON.parse(writtenData);
    expect(result.projects[0].icon).toBe('proj_si.png');
  });

  it('removes old icon file before setting new one', async () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_replace', name: 'Test', path: '/test', icon: 'proj_replace.jpg' }],
    };
    mockStoreFile(store);
    vi.mocked(fsp.readdir).mockResolvedValue(['proj_replace.jpg'] as any);

    await setIcon('proj_replace', '/tmp/new-icon.png');
    expect(vi.mocked(fsp.unlink)).toHaveBeenCalled();
    expect(vi.mocked(fsp.copyFile)).toHaveBeenCalled();
  });

  it('uses source file extension', async () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_ext', name: 'Test', path: '/test' }],
    };
    mockStoreFile(store);

    const filename = await setIcon('proj_ext', '/tmp/icon.webp');
    expect(filename).toBe('proj_ext.webp');
  });

  it('defaults to .png when source has no extension', async () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_noext', name: 'Test', path: '/test' }],
    };
    mockStoreFile(store);

    const filename = await setIcon('proj_noext', '/tmp/icon');
    expect(filename).toBe('proj_noext.png');
  });
});

// ── saveCroppedIcon edge cases ─────────────────────────────────────────

describe('saveCroppedIcon', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.readdir).mockResolvedValue([]);
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
  });

  it('strips data URL prefix and writes PNG buffer', async () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_crop', name: 'Test', path: '/test' }],
    };
    mockStoreFile(store);

    const writtenBuffers: Record<string, Buffer> = {};
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      if (Buffer.isBuffer(data)) writtenBuffers[String(p)] = data;
    });

    const base64Data = Buffer.from('fake-png-data').toString('base64');
    const filename = await saveCroppedIcon('proj_crop', `data:image/png;base64,${base64Data}`);

    expect(filename).toBe('proj_crop.png');
    // Find the icon file write (not the JSON store write)
    const iconPath = Object.keys(writtenBuffers).find(k => k.endsWith('.png'));
    expect(iconPath).toBeDefined();
    expect(writtenBuffers[iconPath!].toString()).toBe('fake-png-data');
  });

  it('handles webp data URL prefix', async () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_webp', name: 'Test', path: '/test' }],
    };
    mockStoreFile(store);

    const base64Data = Buffer.from('fake-webp-data').toString('base64');
    const filename = await saveCroppedIcon('proj_webp', `data:image/webp;base64,${base64Data}`);

    // Always saves as .png regardless of source format
    expect(filename).toBe('proj_webp.png');
  });

  it('updates project icon field in store', async () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_cropup', name: 'Test', path: '/test' }],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      // Capture JSON string writes (projects.json writes)
      if (typeof data === 'string' && data.includes('version')) writtenData = String(data);
    });
    vi.mocked(fsp.rename).mockResolvedValue(undefined);
    vi.mocked(fsp.copyFile).mockResolvedValue(undefined);

    const base64Data = Buffer.from('data').toString('base64');
    await saveCroppedIcon('proj_cropup', `data:image/png;base64,${base64Data}`);

    const result = JSON.parse(writtenData);
    expect(result.projects[0].icon).toBe('proj_cropup.png');
  });
});

// ── update edge cases ──────────────────────────────────────────────────

describe('update — additional edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.readdir).mockResolvedValue([]);
    // Set up default mocks for atomic write pattern
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.rename).mockResolvedValue(undefined);
    vi.mocked(fsp.copyFile).mockResolvedValue(undefined);
  });

  it('sets displayName', async () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_dn', name: 'Test', path: '/test' }],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { writtenData = String(data); });

    await update('proj_dn', { displayName: 'My Custom Name' });
    const result = JSON.parse(writtenData);
    expect(result.projects[0].displayName).toBe('My Custom Name');
  });

  it('clears displayName with empty string', async () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_dn_clear', name: 'Test', path: '/test', displayName: 'Old Name' }],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { writtenData = String(data); });

    await update('proj_dn_clear', { displayName: '' });
    const result = JSON.parse(writtenData);
    expect(result.projects[0].displayName).toBeUndefined();
  });

  it('sets orchestrator', async () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_orch', name: 'Test', path: '/test' }],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { writtenData = String(data); });

    await update('proj_orch', { orchestrator: 'claude-code' as any });
    const result = JSON.parse(writtenData);
    expect(result.projects[0].orchestrator).toBe('claude-code');
  });

  it('setting icon to empty string removes it and triggers file cleanup', async () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_icon_rm', name: 'Test', path: '/test', icon: 'proj_icon_rm.png' }],
    };
    mockStoreFile(store);
    vi.mocked(fsp.readdir).mockResolvedValue(['proj_icon_rm.png'] as any);

    let writtenData = '';
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      // Capture JSON string writes (projects.json writes)
      if (typeof data === 'string' && data.includes('version')) writtenData = String(data);
    });
    vi.mocked(fsp.rename).mockResolvedValue(undefined);
    vi.mocked(fsp.copyFile).mockResolvedValue(undefined);

    await update('proj_icon_rm', { icon: '' });
    const result = JSON.parse(writtenData);
    expect(result.projects[0].icon).toBeUndefined();
    expect(vi.mocked(fsp.unlink)).toHaveBeenCalled();
  });

  it('setting icon to a value updates it without file cleanup', async () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_icon_set', name: 'Test', path: '/test' }],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { writtenData = String(data); });

    await update('proj_icon_set', { icon: 'proj_icon_set.png' });
    const result = JSON.parse(writtenData);
    expect(result.projects[0].icon).toBe('proj_icon_set.png');
    expect(vi.mocked(fsp.unlink)).not.toHaveBeenCalled();
  });

  it('multiple fields can be updated simultaneously', async () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_multi', name: 'Old', path: '/test' }],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { writtenData = String(data); });

    await update('proj_multi', { name: 'New', color: 'violet', displayName: 'Display' });
    const result = JSON.parse(writtenData);
    expect(result.projects[0].name).toBe('New');
    expect(result.projects[0].color).toBe('violet');
    expect(result.projects[0].displayName).toBe('Display');
  });
});

// ── remove edge cases ──────────────────────────────────────────────────

describe('remove — additional edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.readdir).mockResolvedValue([]);
    // Set up default mocks for atomic write pattern
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.rename).mockResolvedValue(undefined);
    vi.mocked(fsp.copyFile).mockResolvedValue(undefined);
  });

  it('removing nonexistent id is a no-op', async () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_keep', name: 'Keep', path: '/keep' }],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      // Capture JSON string writes (projects.json writes)
      if (typeof data === 'string' && data.includes('version')) writtenData = String(data);
    });

    await remove('nonexistent');
    const result = JSON.parse(writtenData);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].id).toBe('proj_keep');
    // With atomic writes, rename is called regardless, so we just verify the project list is correct
  });

  it('removing from empty list is a no-op', async () => {
    mockStoreFile({ version: 1, projects: [] });

    let writtenData = '';
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      // Capture JSON string writes (projects.json writes)
      if (typeof data === 'string' && data.includes('version')) writtenData = String(data);
    });

    await remove('proj_1');
    const result = JSON.parse(writtenData);
    expect(result.projects).toHaveLength(0);
  });
});

// ── reorder edge cases ─────────────────────────────────────────────────

describe('reorder — additional edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.readdir).mockResolvedValue([]);
  });

  it('empty orderedIds appends all projects', async () => {
    const store = {
      version: 1,
      projects: [
        { id: 'proj_a', name: 'A', path: '/a' },
        { id: 'proj_b', name: 'B', path: '/b' },
      ],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { writtenData = String(data); });

    await reorder([]);
    const result = JSON.parse(writtenData);
    // All projects appended (order preserved from map iteration)
    expect(result.projects).toHaveLength(2);
  });

  it('duplicate IDs in orderedIds does not duplicate projects', async () => {
    const store = {
      version: 1,
      projects: [
        { id: 'proj_a', name: 'A', path: '/a' },
        { id: 'proj_b', name: 'B', path: '/b' },
      ],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { writtenData = String(data); });

    await reorder(['proj_a', 'proj_a', 'proj_b']);
    const result = JSON.parse(writtenData);
    // First occurrence picks up proj_a, second is no-op (deleted from map)
    expect(result.projects).toHaveLength(2);
    expect(result.projects[0].id).toBe('proj_a');
    expect(result.projects[1].id).toBe('proj_b');
  });

  it('unknown IDs in orderedIds are ignored', async () => {
    const store = {
      version: 1,
      projects: [
        { id: 'proj_a', name: 'A', path: '/a' },
      ],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { writtenData = String(data); });

    await reorder(['proj_unknown', 'proj_a']);
    const result = JSON.parse(writtenData);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].id).toBe('proj_a');
  });
});

// ── readIconData edge cases ────────────────────────────────────────────

describe('readIconData — additional edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
  });

  it('unknown extension defaults to image/png', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(fsp.readFile).mockResolvedValue(Buffer.from('data'));

    const result = await readIconData('proj.bmp');
    expect(result).toContain('data:image/png;base64,');
  });

  it('ico extension uses image/x-icon', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(fsp.readFile).mockResolvedValue(Buffer.from('data'));

    const result = await readIconData('proj.ico');
    expect(result).toContain('data:image/x-icon;base64,');
  });

  it('gif extension uses image/gif', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(fsp.readFile).mockResolvedValue(Buffer.from('data'));

    const result = await readIconData('proj.gif');
    expect(result).toContain('data:image/gif;base64,');
  });

  it('webp extension uses image/webp', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(fsp.readFile).mockResolvedValue(Buffer.from('data'));

    const result = await readIconData('proj.webp');
    expect(result).toContain('data:image/webp;base64,');
  });
});

// ── readIconData path traversal protection ─────────────────────────────

describe('readIconData — path traversal protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(fsp.readFile).mockResolvedValue(Buffer.from('secret'));
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
  });

  it('rejects ../ traversal', async () => {
    const result = await readIconData('../../../../etc/passwd');
    expect(result).toBeNull();
    expect(fsp.readFile).not.toHaveBeenCalled();
  });

  it('rejects absolute path', async () => {
    const result = await readIconData('/etc/passwd');
    expect(result).toBeNull();
    expect(fsp.readFile).not.toHaveBeenCalled();
  });

  it('rejects path with embedded traversal', async () => {
    const result = await readIconData('subdir/../../../etc/shadow');
    expect(result).toBeNull();
    expect(fsp.readFile).not.toHaveBeenCalled();
  });

  it('allows simple filename', async () => {
    const result = await readIconData('proj.png');
    expect(result).toContain('data:image/png;base64,');
  });
});

// ── LB-SP-005: migrateProjectOverrides is awaited before add() returns ────

describe('LB-SP-005: add() awaits badge/sound saves before returning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
  });

  it('add() resolves only after saveBadgeSettings completes', async () => {
    // Verify ordering: add() must not resolve before saveBadgeSettings finishes.
    // We use setImmediate (macrotask boundary) inside the mock so that any code NOT
    // awaiting the save promise would resolve add() before 'save-completed' is recorded.
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update('/lb-sp-005').digest('hex').slice(0, 16);
    const sidecarPath = path.join(BASE_DIR, `_preserved_${hash}.json`);

    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s === sidecarPath) return true;
      if (s.includes('project-icons')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p) === sidecarPath) return JSON.stringify({ _previousId: 'proj_old_sp005' });
      return '';
    });
    vi.mocked(fsp.readdir).mockResolvedValue([]);

    vi.mocked(getBadgeSettings).mockReturnValue({
      enabled: true, pluginBadges: true, projectRailBadges: true,
      projectOverrides: { proj_old_sp005: { enabled: false, pluginBadges: false } },
    });

    const events: string[] = [];
    vi.mocked(saveBadgeSettings).mockImplementation(async () => {
      events.push('save-started');
      await new Promise<void>((resolve) => setImmediate(resolve));
      events.push('save-completed');
    });

    await add('/lb-sp-005');

    expect(events).toEqual(['save-started', 'save-completed']);
  });

  it('add() resolves only after saveSoundSettings completes', async () => {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update('/lb-sp-005-sound').digest('hex').slice(0, 16);
    const sidecarPath = path.join(BASE_DIR, `_preserved_${hash}.json`);

    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s === sidecarPath) return true;
      if (s.includes('project-icons')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p) === sidecarPath) return JSON.stringify({ _previousId: 'proj_old_sp005s' });
      return '';
    });
    vi.mocked(fsp.readdir).mockResolvedValue([]);

    vi.mocked(getBadgeSettings).mockReturnValue({ enabled: true, pluginBadges: true, projectRailBadges: true });
    vi.mocked(getSoundSettings).mockReturnValue({
      activePack: null, eventSettings: {} as any,
      projectOverrides: { proj_old_sp005s: { activePack: 'retro' } },
    });

    const events: string[] = [];
    vi.mocked(saveSoundSettings).mockImplementation(async () => {
      events.push('save-started');
      await new Promise<void>((resolve) => setImmediate(resolve));
      events.push('save-completed');
    });

    await add('/lb-sp-005-sound');

    expect(events).toEqual(['save-started', 'save-completed']);
  });
});

// ── LB-SP-007: icon operations happen before projects.json write ───────────

describe('LB-SP-007: icon-before-JSON atomicity in remove()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
  });

  it('unlinks icon file before writing projects.json (no icon field)', async () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_del', name: 'Del', path: '/del' }],
    };
    mockStoreFile(store);
    vi.mocked(fsp.readdir).mockResolvedValue(['proj_del.png'] as any);

    const callOrder: string[] = [];
    vi.mocked(fsp.unlink).mockImplementation(async (p: any) => {
      callOrder.push(`unlink:${path.basename(String(p))}`);
    });
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any) => {
      const basename = path.basename(String(p));
      // For atomic writes, temp files have names like "projects.json.tmp.xyz"
      if (basename.startsWith('projects.json')) {
        callOrder.push(`writeFile:projects.json`);
      } else {
        callOrder.push(`writeFile:${basename}`);
      }
    });

    await remove('proj_del');

    const unlinkIdx = callOrder.findIndex((s) => s.startsWith('unlink:'));
    const writeIdx = callOrder.findIndex((s) => s === 'writeFile:projects.json');
    expect(unlinkIdx).toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(unlinkIdx).toBeLessThan(writeIdx);
  });

  it('renames (preserves) icon before writing projects.json (project has icon field)', async () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_del', name: 'Del', path: '/del', icon: 'proj_del.png' }],
    };
    mockStoreFile(store);
    vi.mocked(fsp.readdir).mockResolvedValue(['proj_del.png'] as any);

    const callOrder: string[] = [];
    vi.mocked(fsp.rename).mockImplementation(async (_src: any, _dst: any) => {
      callOrder.push('rename');
    });
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any) => {
      const basename = path.basename(String(p));
      // For atomic writes, temp files have names like "projects.json.tmp.xyz"
      if (basename.startsWith('projects.json')) {
        callOrder.push(`writeFile:projects.json`);
      } else {
        callOrder.push(`writeFile:${basename}`);
      }
    });

    await remove('proj_del');

    const renameIdx = callOrder.findIndex((s) => s === 'rename');
    const writeIdx = callOrder.findIndex((s) => s === 'writeFile:projects.json');
    expect(renameIdx).toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(renameIdx).toBeLessThan(writeIdx);
  });
});

describe('LB-SP-007: icon-before-JSON atomicity in update()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
  });

  it('unlinks icon before writing projects.json when icon is cleared', async () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_up', name: 'Up', path: '/up', icon: 'proj_up.png' }],
    };
    mockStoreFile(store);
    vi.mocked(fsp.readdir).mockResolvedValue(['proj_up.png'] as any);

    const callOrder: string[] = [];
    vi.mocked(fsp.unlink).mockImplementation(async (p: any) => {
      callOrder.push(`unlink:${path.basename(String(p))}`);
    });
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any) => {
      const basename = path.basename(String(p));
      // For atomic writes, temp files have names like "projects.json.tmp.xyz"
      if (basename.startsWith('projects.json')) {
        callOrder.push(`writeFile:projects.json`);
      } else {
        callOrder.push(`writeFile:${basename}`);
      }
    });
    vi.mocked(fsp.rename).mockResolvedValue(undefined);
    vi.mocked(fsp.copyFile).mockResolvedValue(undefined);

    await update('proj_up', { icon: '' });

    const unlinkIdx = callOrder.findIndex((s) => s.startsWith('unlink:'));
    const writeIdx = callOrder.findIndex((s) => s === 'writeFile:projects.json');
    expect(unlinkIdx).toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(unlinkIdx).toBeLessThan(writeIdx);
  });

  it('unlinks icon before writing projects.json when emoji is set', async () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_emoji', name: 'Emoji', path: '/emoji', icon: 'proj_emoji.png' }],
    };
    mockStoreFile(store);
    vi.mocked(fsp.readdir).mockResolvedValue(['proj_emoji.png'] as any);

    const callOrder: string[] = [];
    vi.mocked(fsp.unlink).mockImplementation(async (p: any) => {
      callOrder.push(`unlink:${path.basename(String(p))}`);
    });
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any) => {
      const basename = path.basename(String(p));
      // For atomic writes, temp files have names like "projects.json.tmp.xyz"
      if (basename.startsWith('projects.json')) {
        callOrder.push(`writeFile:projects.json`);
      } else {
        callOrder.push(`writeFile:${basename}`);
      }
    });
    vi.mocked(fsp.rename).mockResolvedValue(undefined);
    vi.mocked(fsp.copyFile).mockResolvedValue(undefined);

    await update('proj_emoji', { emoji: '🏠' });

    const unlinkIdx = callOrder.findIndex((s) => s.startsWith('unlink:'));
    const writeIdx = callOrder.findIndex((s) => s === 'writeFile:projects.json');
    expect(unlinkIdx).toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(unlinkIdx).toBeLessThan(writeIdx);
  });

  it('does not unlink icon when icon is not being cleared', async () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_noop', name: 'Noop', path: '/noop', icon: 'proj_noop.png' }],
    };
    mockStoreFile(store);
    vi.mocked(fsp.readdir).mockResolvedValue([]);
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

    await update('proj_noop', { color: 'amber' });

    expect(vi.mocked(fsp.unlink)).not.toHaveBeenCalled();
  });
});

// ── Atomic write and backup recovery (regression tests for #1629) ──────────

describe('Atomic write and backup recovery', () => {
  const BACKUP_PATH = path.join(BASE_DIR, 'projects.json.bak');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.readdir).mockResolvedValue([]);
  });

  it('creates .bak backup before writing new data', async () => {
    const goodStore = {
      version: 1,
      projects: [{ id: 'proj_a', name: 'A', path: '/a' }],
    };
    mockStoreFile(goodStore);

    const filesWritten: Record<string, string> = {};
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      filesWritten[String(p)] = String(data);
    });
    vi.mocked(fsp.copyFile).mockResolvedValue(undefined);

    // Mutate the store (which triggers a write)
    await add('/Users/me/new-project');

    // Verify that copyFile was called to create backup before the write
    expect(vi.mocked(fsp.copyFile)).toHaveBeenCalledWith(STORE_PATH, BACKUP_PATH);
    // Verify that writeFile was called with a temp file
    const writes = vi.mocked(fsp.writeFile).mock.calls;
    const hasTempWrite = writes.some((call) => String(call[0]).includes('.tmp.'));
    expect(hasTempWrite).toBe(true);
  });

  it('uses temp file + atomic rename for atomic write', async () => {
    mockNoStoreFile();

    let tempFilePath = '';
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      void data;
      tempFilePath = String(p);
    });
    vi.mocked(fsp.rename).mockResolvedValue(undefined);

    const project = await add('/Users/me/new-project');

    // Verify that rename was called (atomic move)
    expect(vi.mocked(fsp.rename)).toHaveBeenCalledWith(tempFilePath, STORE_PATH);
    expect(tempFilePath).toMatch(/\.tmp\./);
    expect(project.name).toBe('new-project');
    expect(project.path).toBe('/Users/me/new-project');
  });

  it('recovers from corrupt projects.json by falling back to backup', async () => {
    const goodStore = {
      version: 1,
      projects: [{ id: 'proj_backup', name: 'From Backup', path: '/backup' }],
    };

    // Mock: main file corrupt, backup is good
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s === STORE_PATH) return true; // corrupt file exists
      if (s === BACKUP_PATH) return true; // backup exists
      if (s === BASE_DIR) return true;
      if (s.includes('project-icons')) return true;
      return false;
    });

    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s === STORE_PATH) {
        throw new Error('JSON parse error: unexpected token <');
      }
      if (s === BACKUP_PATH) {
        return JSON.stringify(goodStore);
      }
      return '';
    });

    vi.mocked(fsp.rename).mockResolvedValue(undefined);

    const result = await list();

    // Should have recovered the projects from backup
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('proj_backup');
    // Should have quarantined the corrupt file (rename was called)
    expect(vi.mocked(fsp.rename)).toHaveBeenCalledWith(
      STORE_PATH,
      expect.stringMatching(/corrupt-\d+/),
    );
  });

  it('quarantines corrupt file instead of overwriting it', async () => {
    // Simulate a corrupt projects.json
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s === STORE_PATH) return true; // corrupt file exists
      if (s === BACKUP_PATH) return false; // no backup
      if (s === BASE_DIR) return true;
      if (s.includes('project-icons')) return true;
      return false;
    });

    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p) === STORE_PATH) {
        throw new Error('JSON parse error: unexpected token < at position 0');
      }
      return '';
    });

    vi.mocked(fsp.rename).mockResolvedValue(undefined);

    const result = await list();

    // Should return empty list (no backup to recover from)
    expect(result).toEqual([]);
    // Should have quarantined the corrupt file (rename called to move to .corrupt-<ts>)
    expect(vi.mocked(fsp.rename)).toHaveBeenCalledWith(
      STORE_PATH,
      expect.stringMatching(/corrupt-\d+/),
    );
  });

  it('subsequent write does not overwrite quarantined corrupt file', async () => {
    // First: corrupt main file, no backup
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s === STORE_PATH) return true; // corrupt file
      if (s === BACKUP_PATH) return false; // no backup
      if (s === BASE_DIR) return true;
      if (s.includes('project-icons')) return true;
      return false;
    });

    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p) === STORE_PATH) {
        throw new Error('corrupt');
      }
      return '';
    });

    let quarantineTarget = '';
    vi.mocked(fsp.rename).mockImplementation(async (src: any, dst: any) => {
      if (String(src) === STORE_PATH && String(dst).includes('corrupt')) {
        quarantineTarget = String(dst);
      }
    });

    vi.mocked(fsp.copyFile).mockResolvedValue(undefined);
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

    // First, trigger the read which should quarantine
    await list();

    // Verify quarantine happened
    expect(quarantineTarget).toMatch(/corrupt-\d+/);
    expect(quarantineTarget).not.toBe(STORE_PATH);

    // Reset rename mock to track further calls
    vi.mocked(fsp.rename).mockClear();

    // Now mock so that the quarantine file still exists but main doesn't (to simulate recovery scenario)
    // and do a subsequent write
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s === STORE_PATH) return false; // after quarantine, main file gone
      if (s === BACKUP_PATH) return false; // no backup
      if (s === BASE_DIR) return true;
      if (s.includes('project-icons')) return true;
      return false;
    });

    // Now the subsequent write should NOT touch the quarantine file
    await add('/Users/me/recovery-project');

    // Verify that the rename was only used for atomic write (tmpfile -> STORE_PATH),
    // not to touch the quarantine
    const renameCalls = vi.mocked(fsp.rename).mock.calls;
    for (const call of renameCalls) {
      const [, dst] = call;
      expect(String(dst)).not.toMatch(/corrupt-\d+/);
    }
  });
});

describe('registry shape validation (invalid data must not become an empty registry)', () => {
  const BACKUP_PATH = path.join(BASE_DIR, 'projects.json.bak');
  const goodBackup = {
    version: 1,
    projects: [{ id: 'proj_bak', name: 'Backup', path: '/backup' }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.readdir).mockResolvedValue([]);
    vi.mocked(fsp.rename).mockResolvedValue(undefined);
    vi.mocked(fsp.copyFile).mockResolvedValue(undefined);
  });

  function mockPrimaryAndBackup(primary: unknown, backup: unknown) {
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s === STORE_PATH) return true;
      if (s === BACKUP_PATH) return backup !== undefined;
      return true;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s === STORE_PATH) return JSON.stringify(primary);
      if (s === BACKUP_PATH) return JSON.stringify(backup);
      return '';
    });
  }

  it.each([
    ['empty object', {}],
    ['null', null],
    ['v1 with non-array projects', { version: 1, projects: 'nope' }],
    ['array of only invalid entries', [null, 42, { id: 'x' }]],
  ])('%s primary falls back to the backup without overwriting it', async (_label, primary) => {
    mockPrimaryAndBackup(primary, goodBackup);

    const result = await list();

    expect(result).toEqual(goodBackup.projects);
    // Invalid primary is quarantined, not silently accepted as an empty registry
    expect(vi.mocked(fsp.rename)).toHaveBeenCalledWith(STORE_PATH, expect.stringMatching(/corrupt-\d+/));
    // The healthy backup is never overwritten by the invalid primary
    expect(vi.mocked(fsp.copyFile)).not.toHaveBeenCalledWith(STORE_PATH, BACKUP_PATH);
  });

  it('does not rotate an invalid primary over the backup even if quarantine fails', async () => {
    mockPrimaryAndBackup({}, goodBackup);
    vi.mocked(fsp.rename).mockImplementation(async (src: any) => {
      if (String(src) === STORE_PATH) throw new Error('EPERM');
    });

    const result = await list();

    expect(result).toEqual(goodBackup.projects);
    expect(vi.mocked(fsp.copyFile)).not.toHaveBeenCalledWith(STORE_PATH, BACKUP_PATH);
  });

  it('drops null/invalid entries from an array but keeps the valid ones', async () => {
    const valid = { id: 'proj_ok', name: 'OK', path: '/ok' };
    mockPrimaryAndBackup({ version: 1, projects: [null, valid, { name: 'no id' }, 'str'] }, goodBackup);

    const result = await list();

    expect(result).toEqual([valid]);
    expect(vi.mocked(fsp.rename)).not.toHaveBeenCalledWith(STORE_PATH, expect.stringMatching(/corrupt-\d+/));
  });

  it('a partially-malformed primary is not rotated over the backup on write', async () => {
    const valid = { id: 'proj_ok', name: 'OK', path: '/ok' };
    mockPrimaryAndBackup({ version: 1, projects: [null, valid] }, goodBackup);

    await add('/Users/me/new-project');

    expect(vi.mocked(fsp.copyFile)).not.toHaveBeenCalledWith(STORE_PATH, BACKUP_PATH);
  });

  it('a valid empty v1 registry is accepted and still rotated on write', async () => {
    mockPrimaryAndBackup({ version: 1, projects: [] }, goodBackup);

    expect(await list()).toEqual([]);
    expect(vi.mocked(fsp.rename)).not.toHaveBeenCalledWith(STORE_PATH, expect.stringMatching(/corrupt-\d+/));

    await add('/Users/me/new-project');
    expect(vi.mocked(fsp.copyFile)).toHaveBeenCalledWith(STORE_PATH, BACKUP_PATH);
  });
});

describe('writeIconFile', () => {
  it('writes a name that follows the content and removes every older icon of that project only', async () => {
    vi.mocked(fsp.readdir).mockResolvedValue(['proj_a.png', 'proj_a.old.svg', 'proj_ab.png', '_preserved_x.png'] as never);
    const bytes = new Uint8Array([1, 2, 3]);

    const first = await writeIconFile('proj_a', bytes, 'jpg');
    const second = await writeIconFile('proj_a', new Uint8Array([4]), 'jpg');

    expect(first).toMatch(/^proj_a\.[0-9a-f]{12}\.jpg$/);
    expect(second).not.toBe(first);
    expect(fsp.writeFile).toHaveBeenCalledWith(expect.stringContaining(first), bytes);
    const removed = vi.mocked(fsp.unlink).mock.calls.map(([file]) => path.basename(String(file)));
    expect(removed).toContain('proj_a.png');
    expect(removed).toContain('proj_a.old.svg');
    expect(removed).not.toContain('proj_ab.png');
    expect(removed).not.toContain('_preserved_x.png');
  });

  it('keeps the file it just wrote', async () => {
    const bytes = new Uint8Array([9]);
    const name = await writeIconFile('proj_k', bytes, 'png');
    vi.mocked(fsp.readdir).mockResolvedValue([name] as never);
    vi.mocked(fsp.unlink).mockClear();
    await writeIconFile('proj_k', bytes, 'png');
    expect(fsp.unlink).not.toHaveBeenCalled();
  });
});

it('retains uncertainty when the registry becomes unreadable after existence is checked', async () => {
  const { isChatTipProjectReadUncertain } = await import('./project-store');
  vi.mocked(pathExists).mockImplementation(async (p) => String(p) === STORE_PATH);
  vi.mocked(fsp.readFile).mockRejectedValueOnce(Object.assign(new Error('read failed'), { code: 'EACCES' }));
  vi.mocked(fsp.rename).mockResolvedValue(undefined);
  vi.mocked(fsp.readdir).mockResolvedValue([]);
  await list();
  expect(isChatTipProjectReadUncertain()).toBe(true);
});

it('does not rule out the toast when a later valid registry read overlaps the failed list it consumed', async () => {
  vi.resetModules();
  const projects = await import('./project-store');
  const { showChatDefaultTip, CHAT_TIP_RULED_OUT_KEY, CHAT_MESSAGE_SHOWN_KEY } = await import('../../renderer/features/agents/chat/chat-default-tip');
  let entered!: () => void; let release!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  vi.mocked(pathExists).mockImplementation(async (p) => String(p) === STORE_PATH);
  vi.mocked(fsp.readFile).mockImplementation(async (p) => {
    if (String(p) !== STORE_PATH) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    if (++reads === 1) { entered(); await held; return JSON.stringify({ version: 1, projects: [] }); }
    return '{broken';
  });
  vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
  vi.mocked(fsp.rename).mockResolvedValue(undefined);
  vi.mocked(fsp.readdir).mockResolvedValue([]);
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  let releaseStatus!: () => void;
  const statusHeld = new Promise<void>((resolve) => { releaseStatus = resolve; });
  vi.stubGlobal('window', { clubhouse: {
    app: { isExperimentalSettingsUnreadable: async () => false, getExperimentalSettings: async () => ({}), isChatTipReadUncertain: async () => { await statusHeld; return projects.isChatTipProjectReadUncertain(); } },
    chat: { getRuntimeSettings: async () => ({}) },
    project: { list: () => projects.list() },
  } });
  try {
    const laterValid = projects.list();
    await reached;
    const tip = showChatDefaultTip();
    await vi.waitFor(() => expect(projects.isChatTipProjectReadUncertain()).toBe(true));
    release(); await laterValid;
    releaseStatus(); await tip;
    expect(localStorage.getItem(CHAT_TIP_RULED_OUT_KEY)).toBeNull();
    expect(localStorage.getItem(CHAT_MESSAGE_SHOWN_KEY)).toBeNull();
  } finally { release(); releaseStatus(); vi.unstubAllGlobals(); }
});

describe('peekProjectsChecked (D99)', () => {
  const BAK_PATH = path.join(BASE_DIR, 'projects.json.bak');
  const errorWith = (code: string) => Object.assign(new Error(code), { code });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function files(byPath: Record<string, string | Error>) {
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      const v = byPath[String(p)];
      if (v === undefined) throw errorWith('ENOENT');
      if (v instanceof Error) throw v;
      return v;
    });
  }

  const project = { id: 'p1', name: 'one', path: '/one' };

  it.each([
    { label: 'mixed malformed row', primary: JSON.stringify([project, { future: true }]) },
    { label: 'duplicate ID', primary: JSON.stringify([project, { ...project, path: '/two' }]) },
    { label: 'duplicate path', primary: JSON.stringify([project, { ...project, id: 'p2', path: '/one/../one' }]) },
    { label: 'newer version', primary: JSON.stringify({ version: 2, projects: [project] }) },
    { label: 'unknown version', primary: JSON.stringify({ version: '1', projects: [project] }) },
    { label: 'invalid top-level schema', primary: JSON.stringify({ projects: null }) },
    { label: 'corrupt primary', primary: '{torn' },
    { label: 'unreadable primary', primary: errorWith('EACCES') },
    { label: 'invalid parent directory', primary: errorWith('ENOTDIR') },
  ])('strictly refuses $label rather than filtering, merging or using a stale backup', async ({ primary }) => {
    files({ [STORE_PATH]: primary, [BAK_PATH]: JSON.stringify([project]) });

    expect(await peekProjectsChecked({ strict: true })).toEqual({ projects: [], readable: false });
    expect((await peekProjectsChecked()).readable).toBe(true);
    expect(fsp.writeFile).not.toHaveBeenCalled();
    expect(fsp.mkdir).not.toHaveBeenCalled();
    expect(fsp.rename).not.toHaveBeenCalled();
    expect(fsp.copyFile).not.toHaveBeenCalled();
    expect(fsp.unlink).not.toHaveBeenCalled();
  });

  it.each(['symlink', 'inode'])('strictly rejects ambiguous %s directory identities without changing defaults', async (identity) => {
    files({ [STORE_PATH]: JSON.stringify([project, { ...project, id: 'p2', path: '/alias' }]) });
    if (identity === 'symlink') vi.mocked(fsp.realpath).mockImplementation(async (p) => String(p) === '/alias' ? '/one' : String(p));
    if (identity === 'inode') vi.mocked(fsp.stat).mockResolvedValue({ dev: 1n, ino: 42n } as Awaited<ReturnType<typeof fsp.stat>>);

    expect(await peekProjectsChecked({ strict: true })).toEqual({ projects: [], readable: false });
    expect((await peekProjectsChecked()).projects).toHaveLength(2);
    expect(fsp.writeFile).not.toHaveBeenCalled();
    expect(fsp.mkdir).not.toHaveBeenCalled();
    expect(fsp.rename).not.toHaveBeenCalled();
  });

  it('strictly accepts known schemas and empty stores but refuses backup-only data without writes', async () => {
    for (const payload of [[], [project], { version: 1, projects: [project] }]) {
      files({ [STORE_PATH]: JSON.stringify(payload) });
      expect((await peekProjectsChecked({ strict: true })).readable).toBe(true);
    }
    files({});
    expect(await peekProjectsChecked({ strict: true })).toEqual({ projects: [], readable: true });
    files({ [BAK_PATH]: JSON.stringify([project]) });
    expect(await peekProjectsChecked({ strict: true })).toEqual({ projects: [], readable: false });
    expect(await peekProjectsChecked()).toEqual({ projects: [project], readable: true });
    files({ [BAK_PATH]: errorWith('EACCES') });
    expect(await peekProjectsChecked({ strict: true })).toEqual({ projects: [], readable: false });
    expect(fsp.writeFile).not.toHaveBeenCalled();
    expect(fsp.mkdir).not.toHaveBeenCalled();
    expect(fsp.rename).not.toHaveBeenCalled();
  });

  it('reads the projects', async () => {
    files({ [STORE_PATH]: JSON.stringify([{ id: 'p1', name: 'one', path: '/one' }]) });
    const r = await peekProjectsChecked();
    expect(r.readable).toBe(true);
    expect(r.projects.map((p) => p.path)).toEqual(['/one']);
  });

  it('has no projects, readably, when neither file is there', async () => {
    files({});
    expect(await peekProjectsChecked()).toEqual({ projects: [], readable: true });
  });

  it('falls back to the backup', async () => {
    files({ [STORE_PATH]: '{ broken', [BAK_PATH]: JSON.stringify([{ id: 'p1', name: 'one', path: '/one' }]) });
    expect((await peekProjectsChecked()).readable).toBe(true);
  });

  it('says it couldn\'t read them when a file is there but doesn\'t parse or can\'t be read', async () => {
    files({ [STORE_PATH]: '{ broken' });
    expect(await peekProjectsChecked()).toEqual({ projects: [], readable: false });
    files({ [STORE_PATH]: errorWith('EACCES') });
    expect(await peekProjectsChecked()).toEqual({ projects: [], readable: false });
  });
});
