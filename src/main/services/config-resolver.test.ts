import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  unlinkSync: vi.fn(),
  copyFileSync: vi.fn(),
}));

import * as fs from 'fs';
import {
  mergeConfigLayers,
  resolveProjectDefaults,
  resolveDurableConfig,
  resolveQuickConfig,
  diffConfigLayers,
  defaultOverrideFlags,
} from './config-resolver';

const PROJECT_PATH = '/test/project';

describe('mergeConfigLayers', () => {
  it('overlay wins when present', () => {
    const base = { claudeMd: 'base md' };
    const overlay = { claudeMd: 'overlay md' };
    const result = mergeConfigLayers(base, overlay);
    expect(result.claudeMd).toBe('overlay md');
  });

  it('undefined in overlay inherits from base', () => {
    const base = { claudeMd: 'base md', permissions: { allow: ['Bash(*)'] } };
    const overlay = { claudeMd: 'override' };
    const result = mergeConfigLayers(base, overlay);
    expect(result.claudeMd).toBe('override');
    expect(result.permissions).toEqual({ allow: ['Bash(*)'] });
  });

  it('null in overlay clears the value', () => {
    const base = { claudeMd: 'base md' };
    const overlay: Record<string, string | null> = { claudeMd: null };
    const result = mergeConfigLayers(base, overlay);
    expect(result.claudeMd).toBeNull();
  });

  it('empty overlay returns base unchanged', () => {
    const base = { claudeMd: 'base', permissions: { deny: ['rm'] } };
    const result = mergeConfigLayers(base, {});
    expect(result).toEqual(base);
  });

  it('merges mcpConfig', () => {
    const base = { mcpConfig: { mcpServers: { a: { command: 'cmd-a' } } } };
    const overlay = { mcpConfig: { mcpServers: { b: { command: 'cmd-b' } } } };
    const result = mergeConfigLayers(base, overlay);
    // mcpConfig is replaced entirely (not deep-merged)
    expect(result.mcpConfig?.mcpServers).toEqual({ b: { command: 'cmd-b' } });
  });
});

describe('resolveProjectDefaults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty layer when no settings files exist', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('not found'); });
    const result = resolveProjectDefaults(PROJECT_PATH);
    expect(result).toEqual({});
  });

  it('reads defaults from settings.json', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).endsWith('settings.json')) {
        return JSON.stringify({ defaults: { claudeMd: '# Default' }, quickOverrides: {} });
      }
      throw new Error('not found');
    });
    const result = resolveProjectDefaults(PROJECT_PATH);
    expect(result.claudeMd).toBe('# Default');
  });

  it('merges settings.local.json on top of settings.json', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).endsWith('settings.json')) {
        return JSON.stringify({
          defaults: { claudeMd: '# Default', permissions: { allow: ['Bash(*)'] } },
          quickOverrides: {},
        });
      }
      if (String(p).endsWith('settings.local.json')) {
        return JSON.stringify({ claudeMd: '# Local Override' });
      }
      throw new Error('not found');
    });
    const result = resolveProjectDefaults(PROJECT_PATH);
    expect(result.claudeMd).toBe('# Local Override');
    // permissions inherited from base
    expect(result.permissions).toEqual({ allow: ['Bash(*)'] });
  });
});

describe('resolveDurableConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty for unknown agent', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('not found'); });
    const result = resolveDurableConfig(PROJECT_PATH, 'nonexistent');
    expect(result).toEqual({});
  });

  it('returns all defaults when no overrides', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).endsWith('agents.json')) {
        return JSON.stringify([{
          id: 'agent1',
          name: 'test',
          overrides: defaultOverrideFlags(),
        }]);
      }
      if (String(p).endsWith('settings.json')) {
        return JSON.stringify({ defaults: { claudeMd: '# Proj', permissions: { allow: ['*'] } }, quickOverrides: {} });
      }
      throw new Error('not found');
    });
    const result = resolveDurableConfig(PROJECT_PATH, 'agent1');
    expect(result.claudeMd).toBe('# Proj');
    expect(result.permissions).toEqual({ allow: ['*'] });
  });

  it('excludes overridden items', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).endsWith('agents.json')) {
        return JSON.stringify([{
          id: 'agent1',
          name: 'test',
          overrides: { ...defaultOverrideFlags(), claudeMd: true },
        }]);
      }
      if (String(p).endsWith('settings.json')) {
        return JSON.stringify({ defaults: { claudeMd: '# Proj', permissions: { allow: ['*'] } }, quickOverrides: {} });
      }
      throw new Error('not found');
    });
    const result = resolveDurableConfig(PROJECT_PATH, 'agent1');
    expect(result.claudeMd).toBeUndefined();
    expect(result.permissions).toEqual({ allow: ['*'] });
  });
});

describe('resolveQuickConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses project defaults + quickOverrides', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).endsWith('settings.json')) {
        return JSON.stringify({
          defaults: { claudeMd: '# Default' },
          quickOverrides: { claudeMd: '# Quick Override' },
        });
      }
      throw new Error('not found');
    });
    const result = resolveQuickConfig(PROJECT_PATH);
    expect(result.claudeMd).toBe('# Quick Override');
  });

  it('inherits from defaults when quickOverrides omit a key', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).endsWith('settings.json')) {
        return JSON.stringify({
          defaults: { claudeMd: '# Default', permissions: { allow: ['*'] } },
          quickOverrides: { claudeMd: '# Quick' },
        });
      }
      throw new Error('not found');
    });
    const result = resolveQuickConfig(PROJECT_PATH);
    expect(result.claudeMd).toBe('# Quick');
    expect(result.permissions).toEqual({ allow: ['*'] });
  });

  it('applies parent durable quickConfigLayer when quickOverrides enabled', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).endsWith('settings.json')) {
        return JSON.stringify({
          defaults: { claudeMd: '# Default' },
          quickOverrides: { claudeMd: '# Quick' },
        });
      }
      if (String(p).endsWith('agents.json')) {
        return JSON.stringify([{
          id: 'parent1',
          name: 'parent',
          quickOverrides: { ...defaultOverrideFlags(), claudeMd: true },
          quickConfigLayer: { claudeMd: '# Parent Quick' },
        }]);
      }
      throw new Error('not found');
    });
    const result = resolveQuickConfig(PROJECT_PATH, 'parent1');
    expect(result.claudeMd).toBe('# Parent Quick');
  });

  it('ignores parent quickConfigLayer when quickOverrides disabled for key', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).endsWith('settings.json')) {
        return JSON.stringify({
          defaults: { claudeMd: '# Default' },
          quickOverrides: { claudeMd: '# Quick' },
        });
      }
      if (String(p).endsWith('agents.json')) {
        return JSON.stringify([{
          id: 'parent1',
          name: 'parent',
          quickOverrides: defaultOverrideFlags(), // all false
          quickConfigLayer: { claudeMd: '# Parent Quick (should be ignored)' },
        }]);
      }
      throw new Error('not found');
    });
    const result = resolveQuickConfig(PROJECT_PATH, 'parent1');
    expect(result.claudeMd).toBe('# Quick');
  });
});

describe('diffConfigLayers', () => {
  it('detects changed claudeMd', () => {
    const changed = diffConfigLayers({ claudeMd: 'old' }, { claudeMd: 'new' });
    expect(changed).toContain('claudeMd');
  });

  it('detects no changes for identical layers', () => {
    const layer = { claudeMd: 'same', permissions: { allow: ['*'] } };
    const changed = diffConfigLayers(layer, layer);
    expect(changed).toEqual([]);
  });

  it('detects added key', () => {
    const changed = diffConfigLayers({}, { claudeMd: 'new' });
    expect(changed).toContain('claudeMd');
  });

  it('detects removed key (to undefined)', () => {
    const changed = diffConfigLayers({ claudeMd: 'old' }, {});
    expect(changed).toContain('claudeMd');
  });

  it('detects null vs string change', () => {
    const changed = diffConfigLayers({ claudeMd: 'old' }, { claudeMd: null });
    expect(changed).toContain('claudeMd');
  });

  it('returns multiple changed keys', () => {
    const changed = diffConfigLayers(
      { claudeMd: 'a', permissions: { allow: ['x'] } },
      { claudeMd: 'b', permissions: { allow: ['y'] } },
    );
    expect(changed).toContain('claudeMd');
    expect(changed).toContain('permissions');
  });
});

describe('defaultOverrideFlags', () => {
  it('returns all false', () => {
    const flags = defaultOverrideFlags();
    expect(flags.claudeMd).toBe(false);
    expect(flags.permissions).toBe(false);
    expect(flags.mcpConfig).toBe(false);
    expect(flags.skills).toBe(false);
    expect(flags.agents).toBe(false);
  });
});
