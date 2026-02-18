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
}));

// electron is aliased to our mock by vitest.config.ts
import * as fs from 'fs';
import { list, add, remove, update, reorder, readIconData } from './project-store';

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

  it('filters by id and cleans up icon', () => {
    const store = {
      version: 1,
      projects: [
        { id: 'proj_keep', name: 'Keep', path: '/keep' },
        { id: 'proj_del', name: 'Del', path: '/del' },
      ],
    };
    mockStoreFile(store);
    vi.mocked(fs.readdirSync).mockReturnValue(['proj_del.png'] as any);

    let writtenData = '';
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { writtenData = String(data); });

    remove('proj_del');
    const result = JSON.parse(writtenData);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].id).toBe('proj_keep');
    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalled();
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
