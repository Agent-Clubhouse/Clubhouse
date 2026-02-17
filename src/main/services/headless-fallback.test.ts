import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config-pipeline
vi.mock('./config-pipeline', () => ({
  snapshotFile: vi.fn(),
  restoreForAgent: vi.fn(),
  getHooksConfigPath: vi.fn(() => '/project/.mock/settings.json'),
  restoreAll: vi.fn(),
}));

// Mock pty-manager
const mockPtySpawn = vi.fn();
const mockPtyGracefulKill = vi.fn();
vi.mock('./pty-manager', () => ({
  spawn: (...args: unknown[]) => mockPtySpawn(...args),
  gracefulKill: (...args: unknown[]) => mockPtyGracefulKill(...args),
}));

// Mock hook-server
vi.mock('./hook-server', () => ({
  waitReady: vi.fn(() => Promise.resolve(12345)),
}));

// Mock headless-manager
const mockHeadlessSpawn = vi.fn();
vi.mock('./headless-manager', () => ({
  spawnHeadless: (...args: unknown[]) => mockHeadlessSpawn(...args),
  kill: vi.fn(),
  isHeadless: vi.fn(() => false),
  readTranscript: vi.fn(() => null),
  getTranscriptSummary: vi.fn(() => null),
}));

// Mock headless-settings
const mockGetSettings = vi.fn(() => ({ enabled: true }));
const mockGetSpawnMode = vi.fn(() => 'headless' as const);
vi.mock('./headless-settings', () => ({
  getSettings: () => mockGetSettings(),
  getSpawnMode: (...args: unknown[]) => mockGetSpawnMode(...args),
  saveSettings: vi.fn(),
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

// Provider that does NOT have buildHeadlessCommand (like Copilot/OpenCode)
const providerWithoutHeadless = {
  id: 'copilot-cli',
  displayName: 'Copilot CLI',
  checkAvailability: vi.fn(() => Promise.resolve({ available: true })),
  buildSpawnCommand: vi.fn(() => Promise.resolve({ binary: '/usr/local/bin/copilot', args: [] })),
  // No buildHeadlessCommand!
  getExitCommand: vi.fn(() => '/exit\r'),
  writeHooksConfig: vi.fn(() => Promise.resolve()),
  parseHookEvent: vi.fn(),
  readInstructions: vi.fn(() => ''),
  writeInstructions: vi.fn(),
  conventions: {} as any,
  getModelOptions: vi.fn(() => []),
  getDefaultPermissions: vi.fn(() => []),
  toolVerb: vi.fn(),
  buildSummaryInstruction: vi.fn(() => ''),
  readQuickSummary: vi.fn(() => Promise.resolve(null)),
  getCapabilities: vi.fn(() => ({
    headless: true, structuredOutput: false, hooks: true,
    sessionResume: true, permissions: true,
  })),
};

const providerWithHeadlessNull = {
  ...providerWithoutHeadless,
  id: 'claude-code',
  displayName: 'Claude Code',
  buildHeadlessCommand: vi.fn(() => Promise.resolve(null)),
  getDefaultPermissions: vi.fn((kind: string) => kind === 'quick' ? ['Read'] : []),
};

let activeProvider: any = providerWithoutHeadless;

vi.mock('../orchestrators', () => ({
  getProvider: vi.fn(() => activeProvider),
  getAllProviders: vi.fn(() => [activeProvider]),
}));

import { spawnAgent, untrackAgent } from './agent-system';

describe('Headless fallback behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockReturnValue({ enabled: true });
    mockGetSpawnMode.mockReturnValue('headless');
    activeProvider = providerWithoutHeadless;
  });

  afterEach(() => {
    untrackAgent('test-agent');
  });

  it('falls back to PTY when provider has no buildHeadlessCommand (Copilot)', async () => {
    activeProvider = providerWithoutHeadless;

    await spawnAgent({
      agentId: 'test-agent',
      projectPath: '/project',
      cwd: '/project',
      kind: 'quick',
      mission: 'Fix bug',
    });

    expect(mockPtySpawn).toHaveBeenCalled();
    expect(mockHeadlessSpawn).not.toHaveBeenCalled();
  });

  it('falls back to PTY when headless disabled + Claude Code', async () => {
    mockGetSpawnMode.mockReturnValue('interactive');
    activeProvider = providerWithHeadlessNull;

    await spawnAgent({
      agentId: 'test-agent',
      projectPath: '/project',
      cwd: '/project',
      kind: 'quick',
      mission: 'Fix bug',
    });

    expect(mockPtySpawn).toHaveBeenCalled();
    expect(mockHeadlessSpawn).not.toHaveBeenCalled();
  });

  it('falls back to PTY when buildHeadlessCommand returns null', async () => {
    activeProvider = providerWithHeadlessNull;

    await spawnAgent({
      agentId: 'test-agent',
      projectPath: '/project',
      cwd: '/project',
      kind: 'quick',
      mission: 'Fix bug',
    });

    expect(mockPtySpawn).toHaveBeenCalled();
    expect(mockHeadlessSpawn).not.toHaveBeenCalled();
  });

  it('falls back to PTY for durable agents even with headless enabled', async () => {
    activeProvider = {
      ...providerWithoutHeadless,
      id: 'claude-code',
      buildHeadlessCommand: vi.fn(() => Promise.resolve({
        binary: '/usr/local/bin/claude',
        args: ['-p', 'test'],
      })),
      getDefaultPermissions: vi.fn(() => []),
    };

    await spawnAgent({
      agentId: 'test-agent',
      projectPath: '/project',
      cwd: '/project',
      kind: 'durable',
    });

    expect(mockPtySpawn).toHaveBeenCalled();
    expect(mockHeadlessSpawn).not.toHaveBeenCalled();
  });
});
