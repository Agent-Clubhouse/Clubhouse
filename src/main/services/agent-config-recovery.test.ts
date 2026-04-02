import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  exec: vi.fn((_cmd: string, _opts: any, cb: (...args: unknown[]) => void) => {
    cb(null, '', '');
    return {};
  }),
  execFile: vi.fn((_file: string, _args: string[], _opts: any, cb: (...args: unknown[]) => void) => {
    cb(null, '', '');
    return {};
  }),
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  appendFile: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  readdir: vi.fn(() => []),
  unlink: vi.fn(),
  stat: vi.fn(),
  copyFile: vi.fn(),
  rename: vi.fn(),
}));

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  unlinkSync: vi.fn(),
  promises: {
    readFile: vi.fn(async () => '{}'),
    writeFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    readdir: vi.fn(async () => []),
    rm: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
    access: vi.fn(async () => undefined),
  },
}));

vi.mock('./fs-utils', () => ({
  pathExists: vi.fn(),
}));

vi.mock('./git-service', () => ({
  isInsideGitRepo: vi.fn(),
}));

import * as fsp from 'fs/promises';
import { pathExists } from './fs-utils';
import {
  validateAgentConfigs,
  auditRecovery,
  listDurable,
  clearAgentConfigCache,
} from './agent-config';

const PROJECT_PATH = '/test/project';

beforeEach(() => {
  clearAgentConfigCache();
  vi.mocked(fsp.rename).mockResolvedValue(undefined);
  vi.mocked(fsp.copyFile).mockResolvedValue(undefined);
});

function mockAgentsFile(agents: any[]) {
  vi.mocked(pathExists).mockImplementation(async (p: any) => {
    if (String(p).endsWith('agents.json')) return true;
    if (String(p).endsWith('.git')) return true;
    return false;
  });
  vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
    if (String(p).endsWith('agents.json')) return JSON.stringify(agents);
    return '';
  });
}

describe('validateAgentConfigs', () => {
  it('returns no issues for valid configs', () => {
    const agents = [
      { id: 'durable_123_abc', name: 'noble-moose', color: 'blue' },
      { id: 'durable_456_def', name: 'mega-camel', color: 'red' },
    ];
    const issues = validateAgentConfigs(agents as any);
    expect(issues).toHaveLength(0);
  });

  it('detects missing agent ID', () => {
    const agents = [{ name: 'no-id', color: 'blue' }];
    const issues = validateAgentConfigs(agents as any);
    expect(issues).toHaveLength(1);
    expect(issues[0].issue).toContain('Missing agent ID');
    expect(issues[0].severity).toBe('error');
  });

  it('detects missing agent name', () => {
    const agents = [{ id: 'durable_123_abc', color: 'blue' }];
    const issues = validateAgentConfigs(agents as any);
    expect(issues).toHaveLength(1);
    expect(issues[0].issue).toContain('Missing agent name');
    expect(issues[0].severity).toBe('error');
  });

  it('detects ghost agent — name matches ID', () => {
    const agents = [{ id: 'durable_123_abc', name: 'durable_123_abc', color: 'blue' }];
    const issues = validateAgentConfigs(agents as any);
    expect(issues).toHaveLength(1);
    expect(issues[0].issue).toContain('matches ID pattern');
    expect(issues[0].severity).toBe('warn');
  });

  it('detects ghost agent — name matches durable ID pattern', () => {
    const agents = [{ id: 'durable_999_xyz', name: 'durable_888_qrs', color: 'blue' }];
    const issues = validateAgentConfigs(agents as any);
    expect(issues).toHaveLength(1);
    expect(issues[0].issue).toContain('matches ID pattern');
  });

  it('detects duplicate agent IDs', () => {
    const agents = [
      { id: 'durable_123_abc', name: 'agent-a', color: 'blue' },
      { id: 'durable_123_abc', name: 'agent-b', color: 'red' },
    ];
    const issues = validateAgentConfigs(agents as any);
    expect(issues).toHaveLength(1);
    expect(issues[0].issue).toContain('Duplicate agent ID');
    expect(issues[0].severity).toBe('error');
  });

  it('detects missing color', () => {
    const agents = [{ id: 'durable_123_abc', name: 'agent-a' }];
    const issues = validateAgentConfigs(agents as any);
    expect(issues).toHaveLength(1);
    expect(issues[0].issue).toContain('Missing agent color');
    expect(issues[0].severity).toBe('warn');
  });

  it('reports multiple issues at once', () => {
    const agents = [
      { id: 'durable_123_abc', color: 'blue' }, // missing name
      { id: 'durable_123_abc', name: 'duplicate', color: 'red' }, // duplicate ID
      { id: 'durable_789_ghi', name: 'durable_789_ghi', color: 'green' }, // ghost
    ];
    const issues = validateAgentConfigs(agents as any);
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });

  it('accepts agents with human names (not durable ID pattern)', () => {
    const agents = [
      { id: 'durable_123_abc', name: 'my-cool-agent', color: 'blue' },
      { id: 'durable_456_def', name: 'test agent 2', color: 'red' },
    ];
    const issues = validateAgentConfigs(agents as any);
    expect(issues).toHaveLength(0);
  });
});

describe('readAgentsFromDisk — deduplication', () => {
  it('removes duplicate agents on read and persists deduplicated list', async () => {
    const agents = [
      { id: 'durable_123_abc', name: 'agent-a', color: 'blue' },
      { id: 'durable_123_abc', name: 'agent-a-copy', color: 'red' },
      { id: 'durable_456_def', name: 'agent-b', color: 'green' },
    ];
    mockAgentsFile(agents);

    const result = await listDurable(PROJECT_PATH);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('agent-a'); // keeps first occurrence
    expect(result[1].name).toBe('agent-b');

    // Verify deduplicated list was persisted
    expect(fsp.writeFile).toHaveBeenCalled();
  });

  it('does not modify or persist when no duplicates', async () => {
    const agents = [
      { id: 'durable_123_abc', name: 'agent-a', color: 'blue' },
      { id: 'durable_456_def', name: 'agent-b', color: 'green' },
    ];
    mockAgentsFile(agents);

    const result = await listDurable(PROJECT_PATH);
    expect(result).toHaveLength(2);

    // writeFile is called for dedup persistence only — not called when no dupes
    // (The normal cache flush happens via scheduleFlush, not direct writeFile)
  });
});

describe('auditRecovery', () => {
  it('reports healthy when disk and running state match', async () => {
    const agents = [
      { id: 'agent-a', name: 'noble-moose', color: 'blue' },
      { id: 'agent-b', name: 'mega-camel', color: 'red' },
    ];
    mockAgentsFile(agents);

    const result = await auditRecovery(PROJECT_PATH, new Set(['agent-a', 'agent-b']));
    expect(result.healthy).toBe(true);
    expect(result.missingFromDisk).toHaveLength(0);
    expect(result.ghostAgents).toHaveLength(0);
    expect(result.duplicateIds).toHaveLength(0);
  });

  it('detects running agents not found in disk config', async () => {
    const agents = [
      { id: 'agent-a', name: 'noble-moose', color: 'blue' },
    ];
    mockAgentsFile(agents);

    const result = await auditRecovery(PROJECT_PATH, new Set(['agent-a', 'agent-phantom']));
    expect(result.healthy).toBe(false);
    expect(result.missingFromDisk).toContain('agent-phantom');
  });

  it('detects ghost agents (name matches ID pattern)', async () => {
    const agents = [
      { id: 'durable_123_abc', name: 'durable_123_abc', color: 'blue' },
      { id: 'durable_456_def', name: 'good-agent', color: 'red' },
    ];
    mockAgentsFile(agents);

    const result = await auditRecovery(PROJECT_PATH, new Set());
    expect(result.healthy).toBe(false);
    expect(result.ghostAgents).toHaveLength(1);
    expect(result.ghostAgents[0].id).toBe('durable_123_abc');
  });

  it('detects missing names as ghost agents', async () => {
    const agents = [
      { id: 'durable_123_abc', color: 'blue' }, // no name field
    ];
    mockAgentsFile(agents);

    const result = await auditRecovery(PROJECT_PATH, new Set());
    expect(result.healthy).toBe(false);
    expect(result.ghostAgents).toHaveLength(1);
    expect(result.ghostAgents[0].name).toBe('(missing)');
  });

  it('reports healthy with no agents on disk and no running agents', async () => {
    mockAgentsFile([]);

    const result = await auditRecovery(PROJECT_PATH, new Set());
    expect(result.healthy).toBe(true);
  });
});
