import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execSync: vi.fn(() => { throw new Error('not found'); }),
}));

vi.mock('util', () => ({
  promisify: vi.fn((fn: any) => vi.fn(async (...args: any[]) => fn(...args))),
}));

vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: `/usr/local/bin${path.delimiter}/usr/bin` })),
}));

import * as fs from 'fs';
import { BaseProvider } from './base-provider';
import type {
  ProviderCapabilities,
  SpawnOpts,
  SpawnCommandResult,
  OrchestratorConventions,
} from './types';

// ── Concrete test subclass ────────────────────────────────────────────────

class TestProvider extends BaseProvider {
  readonly id = 'test-provider';
  readonly displayName = 'Test Provider';
  readonly shortName = 'TP';

  readonly conventions: OrchestratorConventions = {
    configDir: '.test',
    localInstructionsFile: 'TEST.md',
    legacyInstructionsFile: 'TEST.md',
    mcpConfigFile: '.test/mcp.json',
    skillsDir: 'skills',
    agentTemplatesDir: 'agents',
    localSettingsFile: 'settings.json',
  };

  protected readonly binaryNames = ['test-cli'];
  protected getExtraBinaryPaths() { return ['/custom/path/test-cli']; }

  protected getInstructionsPath(worktreePath: string) {
    return path.join(worktreePath, '.test', 'TEST.md');
  }

  protected readonly toolVerbs = {
    run: 'Running command',
    edit: 'Editing file',
    read: 'Reading file',
  };

  protected readonly durablePermissions = ['run(git:*)', 'run(npm:*)'];
  protected readonly quickPermissions = ['run(git:*)', 'run(npm:*)', 'read', 'edit'];
  protected readonly fallbackModelOptions = [
    { id: 'default', label: 'Default' },
    { id: 'model-a', label: 'Model A' },
    { id: 'model-b', label: 'Model B' },
  ];
  protected readonly configEnvKeys = ['TEST_CONFIG_DIR'];

  getCapabilities(): ProviderCapabilities {
    return {
      headless: true,
      structuredOutput: false,
      hooks: false,
      sessionResume: false,
      permissions: false,
      structuredMode: false,
    };
  }

  async buildSpawnCommand(_opts: SpawnOpts): Promise<SpawnCommandResult> {
    return { binary: this.findBinary(), args: [] };
  }
}

// Subclass with model fetching enabled
class TestProviderWithModelFetch extends TestProvider {
  protected readonly modelFetchConfig = {
    args: ['--list-models'],
    parser: (stdout: string) => {
      const models = stdout.trim().split('\n').filter(Boolean);
      if (models.length === 0) return null;
      return [
        { id: 'default', label: 'Default' },
        ...models.map(m => ({ id: m, label: m.toUpperCase() })),
      ];
    },
    timeout: 3000,
  };
}

// Subclass with instructions at project root (like ClaudeCode/Codex)
class TestProviderRootInstructions extends TestProvider {
  protected getInstructionsPath(worktreePath: string) {
    return path.join(worktreePath, 'TEST.md');
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

function isBinaryPath(p: string): boolean {
  const base = path.basename(p);
  return base === 'test-cli' || base === 'test-cli.exe' || base === 'test-cli.cmd';
}

describe('BaseProvider', () => {
  let provider: TestProvider;

  beforeEach(() => {
    provider = new TestProvider();
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockImplementation((p) => isBinaryPath(String(p)));
  });

  describe('findBinary', () => {
    it('delegates to findBinaryInPath with binaryNames and extraPaths', async () => {
      const { binary } = await provider.buildSpawnCommand({ cwd: '/p' });
      expect(binary).toContain('test-cli');
    });
  });

  describe('checkAvailability', () => {
    it('returns available when binary is found', async () => {
      const result = await provider.checkAvailability();
      expect(result.available).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('returns unavailable with error when binary not found', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const result = await provider.checkAvailability();
      expect(result.available).toBe(false);
      expect(result.error).toMatch(/Could not find/);
    });

    it('includes binary name context in error when binary not found', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const result = await provider.checkAvailability();
      expect(result.available).toBe(false);
      // Error from findBinaryInPath includes binary name
      expect(result.error).toContain('test-cli');
    });
  });

  describe('getExitCommand', () => {
    it('returns /exit with carriage return', () => {
      expect(provider.getExitCommand()).toBe('/exit\r');
    });
  });

  describe('readInstructions', () => {
    it('reads from the instructions path', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('test instructions');
      const result = provider.readInstructions('/project');
      expect(result).toBe('test instructions');
      expect(fs.readFileSync).toHaveBeenCalledWith(
        path.join('/project', '.test', 'TEST.md'),
        'utf-8',
      );
    });

    it('returns empty string when file does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(provider.readInstructions('/project')).toBe('');
    });
  });

  describe('writeInstructions', () => {
    it('writes to the instructions path', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = String(p);
        return isBinaryPath(s) || s === path.join('/project', '.test');
      });

      provider.writeInstructions('/project', 'new content');

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        path.join('/project', '.test', 'TEST.md'),
        'new content',
        'utf-8',
      );
    });

    it('creates parent directory if it does not exist', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => isBinaryPath(String(p)));

      provider.writeInstructions('/project', 'content');

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        path.join('/project', '.test'),
        { recursive: true },
      );
    });

    it('skips mkdir when parent directory already exists', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = String(p);
        return isBinaryPath(s) || s === path.join('/project', '.test');
      });

      provider.writeInstructions('/project', 'content');

      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });
  });

  describe('writeInstructions (root-level instructions)', () => {
    let rootProvider: TestProviderRootInstructions;

    beforeEach(() => {
      rootProvider = new TestProviderRootInstructions();
    });

    it('does not create subdirectories when instructions are at root', () => {
      const projectDir = path.join('/project');
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = String(p);
        return isBinaryPath(s) || s === projectDir;
      });

      rootProvider.writeInstructions('/project', 'root content');

      expect(fs.mkdirSync).not.toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        path.join('/project', 'TEST.md'),
        'root content',
        'utf-8',
      );
    });
  });

  describe('getModelOptions', () => {
    it('returns fallback model options when no modelFetchConfig', async () => {
      const options = await provider.getModelOptions();
      expect(options).toEqual([
        { id: 'default', label: 'Default' },
        { id: 'model-a', label: 'Model A' },
        { id: 'model-b', label: 'Model B' },
      ]);
    });

    it('returns a new array each call (defensive copy)', async () => {
      const a = await provider.getModelOptions();
      const b = await provider.getModelOptions();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  describe('getModelOptions (with modelFetchConfig)', () => {
    let fetchProvider: TestProviderWithModelFetch;

    beforeEach(async () => {
      fetchProvider = new TestProviderWithModelFetch();
      // With promisify mocked, execFile is called directly (no callback).
      // Default: throw so getModelOptions falls back to static list.
      const { execFile } = await import('child_process');
      vi.mocked(execFile).mockImplementation(() => {
        throw new Error('not found');
      });
    });

    it('falls back to static list when binary help fails', async () => {
      const options = await fetchProvider.getModelOptions();
      expect(options).toEqual([
        { id: 'default', label: 'Default' },
        { id: 'model-a', label: 'Model A' },
        { id: 'model-b', label: 'Model B' },
      ]);
    });

    it('parses dynamic models when binary succeeds', async () => {
      const { execFile } = await import('child_process');
      vi.mocked(execFile).mockReturnValue({ stdout: 'fast-model\nslow-model\n', stderr: '' } as any);

      const options = await fetchProvider.getModelOptions();
      expect(options).toEqual([
        { id: 'default', label: 'Default' },
        { id: 'fast-model', label: 'FAST-MODEL' },
        { id: 'slow-model', label: 'SLOW-MODEL' },
      ]);
    });

    it('falls back when parser returns null', async () => {
      const { execFile } = await import('child_process');
      vi.mocked(execFile).mockReturnValue({ stdout: '', stderr: '' } as any);

      const options = await fetchProvider.getModelOptions();
      expect(options).toEqual([
        { id: 'default', label: 'Default' },
        { id: 'model-a', label: 'Model A' },
        { id: 'model-b', label: 'Model B' },
      ]);
    });
  });

  describe('getDefaultPermissions', () => {
    it('returns durable permissions for durable kind', () => {
      expect(provider.getDefaultPermissions('durable')).toEqual(['run(git:*)', 'run(npm:*)']);
    });

    it('returns quick permissions for quick kind', () => {
      expect(provider.getDefaultPermissions('quick')).toEqual(['run(git:*)', 'run(npm:*)', 'read', 'edit']);
    });

    it('returns a new array each call (defensive copy)', () => {
      const a = provider.getDefaultPermissions('durable');
      const b = provider.getDefaultPermissions('durable');
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  describe('toolVerb', () => {
    it('returns verb for known tools', () => {
      expect(provider.toolVerb('run')).toBe('Running command');
      expect(provider.toolVerb('edit')).toBe('Editing file');
      expect(provider.toolVerb('read')).toBe('Reading file');
    });

    it('returns undefined for unknown tools', () => {
      expect(provider.toolVerb('unknown')).toBeUndefined();
    });
  });

  describe('getProfileEnvKeys', () => {
    it('returns configured env keys', () => {
      expect(provider.getProfileEnvKeys()).toEqual(['TEST_CONFIG_DIR']);
    });

    it('returns a new array each call (defensive copy)', () => {
      const a = provider.getProfileEnvKeys();
      const b = provider.getProfileEnvKeys();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });
});
