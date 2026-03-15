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
import * as fsp from 'fs/promises';
import { pathExists } from './fs-utils';
import { list, add, remove, update, reorder, readIconData, setIcon, saveCroppedIcon, removeIconFile } from './project-store';
import { getSettings as getBadgeSettings, saveSettings as saveBadgeSettings } from './badge-settings';
import { getSettings as getSoundSettings, saveSettings as saveSoundSettings } from './sound-service';

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

    const writtenFiles: Record<string, string> = {};
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { writtenFiles[String(p)] = String(data); });

    await remove('proj_del');
    const result = JSON.parse(writtenFiles[STORE_PATH]);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].id).toBe('proj_keep');
    expect(vi.mocked(fsp.unlink)).toHaveBeenCalled();
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

    const writtenFiles: Record<string, string> = {};
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { writtenFiles[String(p)] = String(data); });

    await remove('proj_del');
    const result = JSON.parse(writtenFiles[STORE_PATH]);
    expect(result.projects).toHaveLength(0);
    // Icon file should be renamed (preserved), not deleted
    expect(vi.mocked(fsp.rename)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fsp.unlink)).not.toHaveBeenCalled();
    // Preserved filename should use _preserved_ prefix with path hash
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

    const project = await add('/my-project');

    // The project should have its icon restored
    expect(project.icon).toBeDefined();
    expect(project.icon).toContain(project.id);
    expect(project.icon).toMatch(/\.png$/);

    // The preserved file should be renamed to the new project ID
    expect(vi.mocked(fsp.rename)).toHaveBeenCalledTimes(1);
    const renameCall = vi.mocked(fsp.rename).mock.calls[0];
    expect(String(renameCall[0])).toContain(preservedFile);
    expect(String(renameCall[1])).toContain(project.id);
  });

  it('add without preserved icon returns no icon', async () => {
    mockNoStoreFile();
    vi.mocked(fsp.readdir).mockResolvedValue([]);

    const project = await add('/brand-new-project');
    expect(project.icon).toBeUndefined();
    expect(vi.mocked(fsp.rename)).not.toHaveBeenCalled();
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
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s === STORE_PATH) return true;
      if (s.includes('project-icons')) return true;
      return true;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p) === STORE_PATH) return fileContent;
      return '';
    });
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      if (String(p) === STORE_PATH) fileContent = String(data);
    });

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
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s === STORE_PATH) return true;
      if (s.includes('project-icons')) return true;
      return true;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p) === STORE_PATH) return fileContent;
      return '';
    });
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      if (String(p) === STORE_PATH) fileContent = String(data);
    });

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
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s === STORE_PATH) return true;
      if (s.includes('project-icons')) return true;
      return true;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p) === STORE_PATH) return fileContent;
      return '';
    });
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      if (String(p) === STORE_PATH) fileContent = String(data);
    });

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
    vi.mocked(fsp.rename).mockRejectedValue(new Error('EXDEV: cross-device link not permitted'));

    const writtenFiles: Record<string, string> = {};
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { writtenFiles[String(p)] = String(data); });

    // remove() preserves icon via rename — failure is caught
    await expect(remove('proj_rename')).resolves.not.toThrow();
    const result = JSON.parse(writtenFiles[STORE_PATH]);
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
      if (String(p) === STORE_PATH) writtenData = String(data);
    });

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
      if (String(p) === STORE_PATH) writtenData = String(data);
    });

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
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.readdir).mockResolvedValue([]);
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
      if (String(p) === STORE_PATH) writtenData = String(data);
    });

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
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.readdir).mockResolvedValue([]);
  });

  it('removing nonexistent id is a no-op', async () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_keep', name: 'Keep', path: '/keep' }],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      if (String(p) === STORE_PATH) writtenData = String(data);
    });

    await remove('nonexistent');
    const result = JSON.parse(writtenData);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].id).toBe('proj_keep');
    // No settings preservation for nonexistent project
    expect(vi.mocked(fsp.rename)).not.toHaveBeenCalled();
  });

  it('removing from empty list is a no-op', async () => {
    mockStoreFile({ version: 1, projects: [] });

    let writtenData = '';
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      if (String(p) === STORE_PATH) writtenData = String(data);
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
