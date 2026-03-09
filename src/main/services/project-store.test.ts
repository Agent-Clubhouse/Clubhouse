import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  unlinkSync: vi.fn(),
  copyFileSync: vi.fn(),
  renameSync: vi.fn(),
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
import * as fs from 'fs';
import { list, add, remove, update, reorder, readIconData, setIcon, saveCroppedIcon, removeIconFile } from './project-store';
import { getSettings as getBadgeSettings, saveSettings as saveBadgeSettings } from './badge-settings';
import { getSettings as getSoundSettings, saveSettings as saveSoundSettings } from './sound-service';

// The module uses app.getPath('home') which returns path.join(os.tmpdir(), 'clubhouse-test-home')
// and app.isPackaged = false → dirName = '.clubhouse-dev'
const BASE_DIR = path.join(os.tmpdir(), 'clubhouse-test-home', '.clubhouse-dev');
const STORE_PATH = path.join(BASE_DIR, 'projects.json');

function mockStoreFile(content: any) {
  vi.mocked(fs.existsSync).mockImplementation((p: any) => {
    const s = String(p);
    if (s === STORE_PATH) return true;
    if (s === BASE_DIR) return true;
    if (s.includes('project-icons')) return true;
    return false;
  });
  vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
    if (String(p) === STORE_PATH) return JSON.stringify(content);
    return '';
  });
}

function mockNoStoreFile() {
  vi.mocked(fs.existsSync).mockImplementation((p: any) => {
    const s = String(p);
    if (s === STORE_PATH) return false;
    if (s.includes('project-icons')) return true;
    return true; // base dir exists
  });
}

describe('migrate (tested via list)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.readdirSync).mockReturnValue([]);
  });

  it('null (no file) returns empty v1', () => {
    mockNoStoreFile();
    expect(list()).toEqual([]);
  });

  it('bare array (v0) migrates to v1', () => {
    const projects = [{ id: 'proj_1', name: 'Test', path: '/test' }];
    mockStoreFile(projects);
    const result = list();
    expect(result).toEqual(projects);
    // Should have written a migrated file
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalled();
  });

  it('v1 object returned as-is', () => {
    const store = { version: 1, projects: [{ id: 'proj_1', name: 'Test', path: '/test' }] };
    mockStoreFile(store);
    const result = list();
    expect(result).toEqual(store.projects);
  });

  it('future version with projects preserves data', () => {
    const store = { version: 99, projects: [{ id: 'proj_1', name: 'Future', path: '/future' }] };
    mockStoreFile(store);
    const result = list();
    expect(result).toEqual(store.projects);
  });

  it('future version without projects returns empty', () => {
    const store = { version: 99, data: 'unknown' };
    mockStoreFile(store);
    const result = list();
    expect(result).toEqual([]);
  });
});

describe('list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.readdirSync).mockReturnValue([]);
  });

  it('returns [] when no file', () => {
    mockNoStoreFile();
    expect(list()).toEqual([]);
  });

  it('returns [] on corrupt JSON', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('{{invalid');
    expect(list()).toEqual([]);
  });
});

describe('add', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    mockNoStoreFile();
  });

  it('generates proj_ prefixed ID and uses basename as name', () => {
    let _writtenData = '';
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { _writtenData = String(data); });
    const project = add('/Users/me/my-project');
    expect(project.id).toMatch(/^proj_/);
    expect(project.name).toBe('my-project');
    expect(project.path).toBe('/Users/me/my-project');
  });
});

describe('remove', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
  });

  it('filters by id and cleans up icon when project has no icon', () => {
    const store = {
      version: 1,
      projects: [
        { id: 'proj_keep', name: 'Keep', path: '/keep' },
        { id: 'proj_del', name: 'Del', path: '/del' },
      ],
    };
    mockStoreFile(store);
    vi.mocked(fs.readdirSync).mockReturnValue(['proj_del.png'] as any);

    const writtenFiles: Record<string, string> = {};
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { writtenFiles[String(p)] = String(data); });

    remove('proj_del');
    const result = JSON.parse(writtenFiles[STORE_PATH]);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].id).toBe('proj_keep');
    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalled();
  });

  it('preserves icon file when project has an icon', () => {
    const store = {
      version: 1,
      projects: [
        { id: 'proj_del', name: 'Del', path: '/del', icon: 'proj_del.png' },
      ],
    };
    mockStoreFile(store);
    vi.mocked(fs.readdirSync).mockReturnValue(['proj_del.png'] as any);

    const writtenFiles: Record<string, string> = {};
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { writtenFiles[String(p)] = String(data); });

    remove('proj_del');
    const result = JSON.parse(writtenFiles[STORE_PATH]);
    expect(result.projects).toHaveLength(0);
    // Icon file should be renamed (preserved), not deleted
    expect(vi.mocked(fs.renameSync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fs.unlinkSync)).not.toHaveBeenCalled();
    // Preserved filename should use _preserved_ prefix with path hash
    const renameCall = vi.mocked(fs.renameSync).mock.calls[0];
    expect(String(renameCall[0])).toContain('proj_del.png');
    expect(String(renameCall[1])).toMatch(/_preserved_[0-9a-f]+\.png/);
  });
});

describe('icon preservation across close/reopen (#209)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
  });

  it('re-adding same path restores the preserved icon', () => {
    // First, the preserved icon file exists from a previous remove
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update('/my-project').digest('hex').slice(0, 16);
    const preservedFile = `_preserved_${hash}.png`;

    mockNoStoreFile();
    vi.mocked(fs.readdirSync).mockReturnValue([preservedFile] as any);

    const project = add('/my-project');

    // The project should have its icon restored
    expect(project.icon).toBeDefined();
    expect(project.icon).toContain(project.id);
    expect(project.icon).toMatch(/\.png$/);

    // The preserved file should be renamed to the new project ID
    expect(vi.mocked(fs.renameSync)).toHaveBeenCalledTimes(1);
    const renameCall = vi.mocked(fs.renameSync).mock.calls[0];
    expect(String(renameCall[0])).toContain(preservedFile);
    expect(String(renameCall[1])).toContain(project.id);
  });

  it('add without preserved icon returns no icon', () => {
    mockNoStoreFile();
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    const project = add('/brand-new-project');
    expect(project.icon).toBeUndefined();
    expect(vi.mocked(fs.renameSync)).not.toHaveBeenCalled();
  });

  it('different paths get different preserved keys', () => {
    const crypto = require('crypto');
    const hash1 = crypto.createHash('sha256').update('/project-a').digest('hex').slice(0, 16);
    const hash2 = crypto.createHash('sha256').update('/project-b').digest('hex').slice(0, 16);

    // Only project-a has a preserved icon
    const preservedFile = `_preserved_${hash1}.png`;
    mockNoStoreFile();
    vi.mocked(fs.readdirSync).mockReturnValue([preservedFile] as any);

    // Adding project-b should not pick up project-a's icon
    const projectB = add('/project-b');
    expect(projectB.icon).toBeUndefined();

    // Sanity check: hashes differ
    expect(hash1).not.toBe(hash2);
  });
});

describe('settings preservation across close/reopen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
  });

  it('remove preserves displayName, color, orchestrator, and previous ID to sidecar', () => {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update('/my-project').digest('hex').slice(0, 16);

    const store = {
      version: 1,
      projects: [
        { id: 'proj_del', name: 'MyProj', path: '/my-project', displayName: 'Workshop', color: 'emerald', orchestrator: 'claude' },
      ],
    };
    mockStoreFile(store);
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    const writtenFiles: Record<string, string> = {};
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { writtenFiles[String(p)] = String(data); });

    remove('proj_del');

    const sidecarPath = path.join(BASE_DIR, `_preserved_${hash}.json`);
    expect(writtenFiles[sidecarPath]).toBeDefined();
    const saved = JSON.parse(writtenFiles[sidecarPath]);
    expect(saved._previousId).toBe('proj_del');
    expect(saved.displayName).toBe('Workshop');
    expect(saved.color).toBe('emerald');
    expect(saved.orchestrator).toBe('claude');
  });

  it('remove with no custom settings still writes sidecar with previous ID', () => {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update('/plain').digest('hex').slice(0, 16);

    const store = {
      version: 1,
      projects: [
        { id: 'proj_plain', name: 'Plain', path: '/plain' },
      ],
    };
    mockStoreFile(store);
    vi.mocked(fs.readdirSync).mockReturnValue(['proj_plain.png'] as any);

    const writtenFiles: Record<string, string> = {};
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { writtenFiles[String(p)] = String(data); });

    remove('proj_plain');

    // Sidecar should still be written with _previousId for override migration
    const sidecarPath = path.join(BASE_DIR, `_preserved_${hash}.json`);
    expect(writtenFiles[sidecarPath]).toBeDefined();
    const saved = JSON.parse(writtenFiles[sidecarPath]);
    expect(saved._previousId).toBe('proj_plain');
  });

  it('re-adding same path restores preserved settings', () => {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update('/my-project').digest('hex').slice(0, 16);
    const sidecarPath = path.join(BASE_DIR, `_preserved_${hash}.json`);

    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s === sidecarPath) return true;
      if (s.includes('project-icons')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p) === sidecarPath) return JSON.stringify({ _previousId: 'proj_old', displayName: 'Workshop', color: 'emerald' });
      return '';
    });
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

    const project = add('/my-project');

    expect(project.displayName).toBe('Workshop');
    expect(project.color).toBe('emerald');
    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledWith(sidecarPath);
  });

  it('re-adding different path does not pick up another path settings', () => {
    const crypto = require('crypto');
    const hashA = crypto.createHash('sha256').update('/project-a').digest('hex').slice(0, 16);
    const hashB = crypto.createHash('sha256').update('/project-b').digest('hex').slice(0, 16);
    const sidecarA = path.join(BASE_DIR, `_preserved_${hashA}.json`);

    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s === sidecarA) return true;
      if (s.includes('project-icons')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p) === sidecarA) return JSON.stringify({ _previousId: 'proj_a_old', displayName: 'A Name' });
      return '';
    });
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

    const projectB = add('/project-b');

    expect(projectB.displayName).toBeUndefined();
    expect(hashA).not.toBe(hashB);
  });

  it('migrates badge overrides from old project ID to new ID on re-add', () => {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update('/my-project').digest('hex').slice(0, 16);
    const sidecarPath = path.join(BASE_DIR, `_preserved_${hash}.json`);

    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s === sidecarPath) return true;
      if (s.includes('project-icons')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p) === sidecarPath) return JSON.stringify({ _previousId: 'proj_old_123' });
      return '';
    });
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

    // Badge settings have an override for the old project ID
    const badgeOverrides = { enabled: false, pluginBadges: false };
    vi.mocked(getBadgeSettings).mockReturnValue({
      enabled: true, pluginBadges: true, projectRailBadges: true,
      projectOverrides: { proj_old_123: badgeOverrides },
    });
    vi.mocked(getSoundSettings).mockReturnValue({ activePack: null, eventSettings: {} as any });

    const project = add('/my-project');

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

  it('migrates sound overrides from old project ID to new ID on re-add', () => {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update('/my-project').digest('hex').slice(0, 16);
    const sidecarPath = path.join(BASE_DIR, `_preserved_${hash}.json`);

    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s === sidecarPath) return true;
      if (s.includes('project-icons')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p) === sidecarPath) return JSON.stringify({ _previousId: 'proj_old_456' });
      return '';
    });
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

    vi.mocked(getBadgeSettings).mockReturnValue({ enabled: true, pluginBadges: true, projectRailBadges: true });
    const soundOverride = { activePack: 'retro-sounds' };
    vi.mocked(getSoundSettings).mockReturnValue({
      activePack: null, eventSettings: {} as any,
      projectOverrides: { proj_old_456: soundOverride },
    });

    const project = add('/my-project');

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

  it('skips migration when no previous ID in sidecar', () => {
    mockNoStoreFile();
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    add('/brand-new-project');

    expect(saveBadgeSettings).not.toHaveBeenCalled();
    expect(saveSoundSettings).not.toHaveBeenCalled();
  });
});

describe('update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.readdirSync).mockReturnValue([]);
  });

  it('sets/clears color, icon, name correctly', () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_up', name: 'Old', path: '/test', color: 'indigo' }],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { writtenData = String(data); });

    // Update name and color
    update('proj_up', { name: 'New', color: 'amber' });
    let result = JSON.parse(writtenData);
    expect(result.projects[0].name).toBe('New');
    expect(result.projects[0].color).toBe('amber');

    // Clear color
    mockStoreFile(result);
    update('proj_up', { color: '' });
    result = JSON.parse(writtenData);
    expect(result.projects[0].color).toBeUndefined();
  });

  it('empty string name is ignored', () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_name', name: 'Original', path: '/test' }],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { writtenData = String(data); });

    update('proj_name', { name: '' });
    const result = JSON.parse(writtenData);
    expect(result.projects[0].name).toBe('Original');
  });

  it('non-existent id is a no-op', () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_exist', name: 'Exist', path: '/test' }],
    };
    mockStoreFile(store);

    const result = update('nonexistent', { name: 'New' });
    expect(result).toEqual(store.projects);
  });
});

describe('reorder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.readdirSync).mockReturnValue([]);
  });

  it('reorders by orderedIds and appends missing', () => {
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
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { writtenData = String(data); });

    // Reorder to C, A — B should be appended
    reorder(['proj_c', 'proj_a']);
    const result = JSON.parse(writtenData);
    expect(result.projects.map((p: any) => p.id)).toEqual(['proj_c', 'proj_a', 'proj_b']);
  });
});

describe('sequential update correctness (no lost updates)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.readdirSync).mockReturnValue([]);
  });

  it('sequential add() calls do not lose projects', () => {
    // Simulate file I/O: writeFileSync updates what readFileSync returns
    let fileContent = JSON.stringify({ version: 1, projects: [] });
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s === STORE_PATH) return true;
      if (s.includes('project-icons')) return true;
      return true;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p) === STORE_PATH) return fileContent;
      return '';
    });
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => {
      if (String(p) === STORE_PATH) fileContent = String(data);
    });

    add('/project-a');
    add('/project-b');
    add('/project-c');

    const result = JSON.parse(fileContent);
    expect(result.projects).toHaveLength(3);
  });

  it('sequential update() calls each see the result of the previous update', () => {
    const initial = {
      version: 1,
      projects: [
        { id: 'proj_1', name: 'One', path: '/one' },
        { id: 'proj_2', name: 'Two', path: '/two' },
      ],
    };
    let fileContent = JSON.stringify(initial);
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s === STORE_PATH) return true;
      if (s.includes('project-icons')) return true;
      return true;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p) === STORE_PATH) return fileContent;
      return '';
    });
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => {
      if (String(p) === STORE_PATH) fileContent = String(data);
    });

    update('proj_1', { displayName: 'First' });
    update('proj_2', { displayName: 'Second' });

    const result = JSON.parse(fileContent);
    // Both updates should be present — neither should be lost
    expect(result.projects[0].displayName).toBe('First');
    expect(result.projects[1].displayName).toBe('Second');
  });

  it('sequential remove() calls do not lose removals', () => {
    const initial = {
      version: 1,
      projects: [
        { id: 'proj_a', name: 'A', path: '/a' },
        { id: 'proj_b', name: 'B', path: '/b' },
        { id: 'proj_c', name: 'C', path: '/c' },
      ],
    };
    let fileContent = JSON.stringify(initial);
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s === STORE_PATH) return true;
      if (s.includes('project-icons')) return true;
      return true;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p) === STORE_PATH) return fileContent;
      return '';
    });
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => {
      if (String(p) === STORE_PATH) fileContent = String(data);
    });

    remove('proj_a');
    remove('proj_c');

    const result = JSON.parse(fileContent);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].id).toBe('proj_b');
  });

  it('update() does not mutate the projects array read from disk', () => {
    const initial = {
      version: 1,
      projects: [
        { id: 'proj_1', name: 'Original', path: '/test', color: 'blue' },
      ],
    };
    mockStoreFile(initial);

    let capturedProjects: any[] | undefined;
    const originalReadFileSync = vi.mocked(fs.readFileSync).getMockImplementation();
    vi.mocked(fs.readFileSync).mockImplementation((p: any, ...args: any[]) => {
      const data = originalReadFileSync?.(p, ...args);
      if (String(p) === STORE_PATH) {
        const parsed = JSON.parse(String(data));
        capturedProjects = parsed.projects;
      }
      return data;
    });

    let writtenData = '';
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { writtenData = String(data); });

    update('proj_1', { color: 'red' });

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
  });

  it('correct MIME types', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-image'));
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);

    const png = readIconData('proj.png');
    expect(png).toContain('data:image/png;base64,');

    const jpg = readIconData('proj.jpg');
    expect(jpg).toContain('data:image/jpeg;base64,');

    const svg = readIconData('proj.svg');
    expect(svg).toContain('data:image/svg+xml;base64,');
  });

  it('null when file missing', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      // Icons dir creation check — return true for dir, false for file
      if (String(p).includes('project-icons') && !String(p).includes('.')) return true;
      return false;
    });
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    const result = readIconData('missing.png');
    expect(result).toBeNull();
  });

  it('base64 encoding', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const testData = Buffer.from('test-data');
    vi.mocked(fs.readFileSync).mockReturnValue(testData);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);

    const result = readIconData('test.png');
    expect(result).toBe(`data:image/png;base64,${testData.toString('base64')}`);
  });
});

// ── Filesystem Error Handling ──────────────────────────────────────────

describe('filesystem error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.readdirSync).mockReturnValue([]);
  });

  it('writeFileSync failure during add does not corrupt state', () => {
    mockNoStoreFile();
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    expect(() => add('/test-project')).toThrow('ENOSPC');
  });

  it('writeFileSync failure during update propagates error', () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_1', name: 'Test', path: '/test' }],
    };
    mockStoreFile(store);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    expect(() => update('proj_1', { name: 'New' })).toThrow('EACCES');
  });

  it('readFileSync throwing non-JSON error returns empty list', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

    expect(list()).toEqual([]);
  });

  it('readdirSync failure in removeIconFile is silently caught', () => {
    vi.mocked(fs.readdirSync).mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

    // Should not throw
    expect(() => removeIconFile('proj_1')).not.toThrow();
  });

  it('unlinkSync failure in removeIconFile is silently caught', () => {
    vi.mocked(fs.readdirSync).mockReturnValue(['proj_1.png'] as any);
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      throw new Error('EPERM: operation not permitted');
    });
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.existsSync).mockReturnValue(true);

    // The function catches errors from the icons dir operations
    expect(() => removeIconFile('proj_1')).not.toThrow();
  });

  it('copyFileSync failure in setIcon propagates error', () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_icon', name: 'Test', path: '/test' }],
    };
    mockStoreFile(store);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.copyFileSync).mockImplementation(() => {
      throw new Error('ENOENT: source file not found');
    });

    expect(() => setIcon('proj_icon', '/missing/image.png')).toThrow('ENOENT');
  });

  it('renameSync failure during icon preservation is silently caught', () => {
    const store = {
      version: 1,
      projects: [
        { id: 'proj_rename', name: 'Test', path: '/test', icon: 'proj_rename.png' },
      ],
    };
    mockStoreFile(store);
    vi.mocked(fs.readdirSync).mockReturnValue(['proj_rename.png'] as any);
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw new Error('EXDEV: cross-device link not permitted');
    });

    const writtenFiles: Record<string, string> = {};
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { writtenFiles[String(p)] = String(data); });

    // remove() preserves icon via renameSync — failure is caught
    expect(() => remove('proj_rename')).not.toThrow();
    const result = JSON.parse(writtenFiles[STORE_PATH]);
    expect(result.projects).toHaveLength(0);
  });

  it('corrupt preserved settings sidecar returns empty object gracefully', () => {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update('/corrupt-project').digest('hex').slice(0, 16);
    const sidecarPath = path.join(BASE_DIR, `_preserved_${hash}.json`);

    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s === sidecarPath) return true;
      if (s.includes('project-icons')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p) === sidecarPath) return '{{invalid json';
      return '';
    });
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

    // Should not throw and should not apply any restored settings
    const project = add('/corrupt-project');
    expect(project.displayName).toBeUndefined();
    expect(project.color).toBeUndefined();
  });
});

// ── setIcon edge cases ─────────────────────────────────────────────────

describe('setIcon', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.copyFileSync).mockReturnValue(undefined);
  });

  it('copies file and updates project icon field', () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_si', name: 'Test', path: '/test' }],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => {
      if (String(p) === STORE_PATH) writtenData = String(data);
    });

    const filename = setIcon('proj_si', '/tmp/icon.png');
    expect(filename).toBe('proj_si.png');
    expect(vi.mocked(fs.copyFileSync)).toHaveBeenCalled();

    const result = JSON.parse(writtenData);
    expect(result.projects[0].icon).toBe('proj_si.png');
  });

  it('removes old icon file before setting new one', () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_replace', name: 'Test', path: '/test', icon: 'proj_replace.jpg' }],
    };
    mockStoreFile(store);
    vi.mocked(fs.readdirSync).mockReturnValue(['proj_replace.jpg'] as any);

    setIcon('proj_replace', '/tmp/new-icon.png');
    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalled();
    expect(vi.mocked(fs.copyFileSync)).toHaveBeenCalled();
  });

  it('uses source file extension', () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_ext', name: 'Test', path: '/test' }],
    };
    mockStoreFile(store);

    const filename = setIcon('proj_ext', '/tmp/icon.webp');
    expect(filename).toBe('proj_ext.webp');
  });

  it('defaults to .png when source has no extension', () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_noext', name: 'Test', path: '/test' }],
    };
    mockStoreFile(store);

    const filename = setIcon('proj_noext', '/tmp/icon');
    expect(filename).toBe('proj_noext.png');
  });
});

// ── saveCroppedIcon edge cases ─────────────────────────────────────────

describe('saveCroppedIcon', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
  });

  it('strips data URL prefix and writes PNG buffer', () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_crop', name: 'Test', path: '/test' }],
    };
    mockStoreFile(store);

    const writtenBuffers: Record<string, Buffer> = {};
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => {
      if (Buffer.isBuffer(data)) writtenBuffers[String(p)] = data;
    });

    const base64Data = Buffer.from('fake-png-data').toString('base64');
    const filename = saveCroppedIcon('proj_crop', `data:image/png;base64,${base64Data}`);

    expect(filename).toBe('proj_crop.png');
    // Find the icon file write (not the JSON store write)
    const iconPath = Object.keys(writtenBuffers).find(k => k.endsWith('.png'));
    expect(iconPath).toBeDefined();
    expect(writtenBuffers[iconPath!].toString()).toBe('fake-png-data');
  });

  it('handles webp data URL prefix', () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_webp', name: 'Test', path: '/test' }],
    };
    mockStoreFile(store);

    const base64Data = Buffer.from('fake-webp-data').toString('base64');
    const filename = saveCroppedIcon('proj_webp', `data:image/webp;base64,${base64Data}`);

    // Always saves as .png regardless of source format
    expect(filename).toBe('proj_webp.png');
  });

  it('updates project icon field in store', () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_cropup', name: 'Test', path: '/test' }],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => {
      if (String(p) === STORE_PATH) writtenData = String(data);
    });

    const base64Data = Buffer.from('data').toString('base64');
    saveCroppedIcon('proj_cropup', `data:image/png;base64,${base64Data}`);

    const result = JSON.parse(writtenData);
    expect(result.projects[0].icon).toBe('proj_cropup.png');
  });
});

// ── update edge cases ──────────────────────────────────────────────────

describe('update — additional edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.readdirSync).mockReturnValue([]);
  });

  it('sets displayName', () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_dn', name: 'Test', path: '/test' }],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { writtenData = String(data); });

    update('proj_dn', { displayName: 'My Custom Name' });
    const result = JSON.parse(writtenData);
    expect(result.projects[0].displayName).toBe('My Custom Name');
  });

  it('clears displayName with empty string', () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_dn_clear', name: 'Test', path: '/test', displayName: 'Old Name' }],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { writtenData = String(data); });

    update('proj_dn_clear', { displayName: '' });
    const result = JSON.parse(writtenData);
    expect(result.projects[0].displayName).toBeUndefined();
  });

  it('sets orchestrator', () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_orch', name: 'Test', path: '/test' }],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { writtenData = String(data); });

    update('proj_orch', { orchestrator: 'claude-code' as any });
    const result = JSON.parse(writtenData);
    expect(result.projects[0].orchestrator).toBe('claude-code');
  });

  it('setting icon to empty string removes it and triggers file cleanup', () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_icon_rm', name: 'Test', path: '/test', icon: 'proj_icon_rm.png' }],
    };
    mockStoreFile(store);
    vi.mocked(fs.readdirSync).mockReturnValue(['proj_icon_rm.png'] as any);

    let writtenData = '';
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => {
      if (String(p) === STORE_PATH) writtenData = String(data);
    });

    update('proj_icon_rm', { icon: '' });
    const result = JSON.parse(writtenData);
    expect(result.projects[0].icon).toBeUndefined();
    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalled();
  });

  it('setting icon to a value updates it without file cleanup', () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_icon_set', name: 'Test', path: '/test' }],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { writtenData = String(data); });

    update('proj_icon_set', { icon: 'proj_icon_set.png' });
    const result = JSON.parse(writtenData);
    expect(result.projects[0].icon).toBe('proj_icon_set.png');
    expect(vi.mocked(fs.unlinkSync)).not.toHaveBeenCalled();
  });

  it('multiple fields can be updated simultaneously', () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_multi', name: 'Old', path: '/test' }],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { writtenData = String(data); });

    update('proj_multi', { name: 'New', color: 'violet', displayName: 'Display' });
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
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.readdirSync).mockReturnValue([]);
  });

  it('removing nonexistent id is a no-op', () => {
    const store = {
      version: 1,
      projects: [{ id: 'proj_keep', name: 'Keep', path: '/keep' }],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => {
      if (String(p) === STORE_PATH) writtenData = String(data);
    });

    remove('nonexistent');
    const result = JSON.parse(writtenData);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].id).toBe('proj_keep');
    // No settings preservation for nonexistent project
    expect(vi.mocked(fs.renameSync)).not.toHaveBeenCalled();
  });

  it('removing from empty list is a no-op', () => {
    mockStoreFile({ version: 1, projects: [] });

    let writtenData = '';
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => {
      if (String(p) === STORE_PATH) writtenData = String(data);
    });

    remove('proj_1');
    const result = JSON.parse(writtenData);
    expect(result.projects).toHaveLength(0);
  });
});

// ── reorder edge cases ─────────────────────────────────────────────────

describe('reorder — additional edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.readdirSync).mockReturnValue([]);
  });

  it('empty orderedIds appends all projects', () => {
    const store = {
      version: 1,
      projects: [
        { id: 'proj_a', name: 'A', path: '/a' },
        { id: 'proj_b', name: 'B', path: '/b' },
      ],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { writtenData = String(data); });

    reorder([]);
    const result = JSON.parse(writtenData);
    // All projects appended (order preserved from map iteration)
    expect(result.projects).toHaveLength(2);
  });

  it('duplicate IDs in orderedIds does not duplicate projects', () => {
    const store = {
      version: 1,
      projects: [
        { id: 'proj_a', name: 'A', path: '/a' },
        { id: 'proj_b', name: 'B', path: '/b' },
      ],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { writtenData = String(data); });

    reorder(['proj_a', 'proj_a', 'proj_b']);
    const result = JSON.parse(writtenData);
    // First occurrence picks up proj_a, second is no-op (deleted from map)
    expect(result.projects).toHaveLength(2);
    expect(result.projects[0].id).toBe('proj_a');
    expect(result.projects[1].id).toBe('proj_b');
  });

  it('unknown IDs in orderedIds are ignored', () => {
    const store = {
      version: 1,
      projects: [
        { id: 'proj_a', name: 'A', path: '/a' },
      ],
    };
    mockStoreFile(store);

    let writtenData = '';
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { writtenData = String(data); });

    reorder(['proj_unknown', 'proj_a']);
    const result = JSON.parse(writtenData);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].id).toBe('proj_a');
  });
});

// ── readIconData edge cases ────────────────────────────────────────────

describe('readIconData — additional edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('unknown extension defaults to image/png', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('data'));
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);

    const result = readIconData('proj.bmp');
    expect(result).toContain('data:image/png;base64,');
  });

  it('ico extension uses image/x-icon', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('data'));
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);

    const result = readIconData('proj.ico');
    expect(result).toContain('data:image/x-icon;base64,');
  });

  it('gif extension uses image/gif', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('data'));
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);

    const result = readIconData('proj.gif');
    expect(result).toContain('data:image/gif;base64,');
  });

  it('webp extension uses image/webp', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('data'));
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);

    const result = readIconData('proj.webp');
    expect(result).toContain('data:image/webp;base64,');
  });
});

// ── readIconData path traversal protection ─────────────────────────────

describe('readIconData — path traversal protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('secret'));
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
  });

  it('rejects ../ traversal', () => {
    const result = readIconData('../../../../etc/passwd');
    expect(result).toBeNull();
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('rejects absolute path', () => {
    const result = readIconData('/etc/passwd');
    expect(result).toBeNull();
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('rejects path with embedded traversal', () => {
    const result = readIconData('subdir/../../../etc/shadow');
    expect(result).toBeNull();
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('allows simple filename', () => {
    const result = readIconData('proj.png');
    expect(result).toContain('data:image/png;base64,');
  });
});
