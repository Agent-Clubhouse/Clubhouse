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
import { list, add, remove, update, reorder, readIconData } from './project-store';
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
