import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

// Helper access ceiling (#2228) against each provider's real launch flags.

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async () => { throw new Error('ENOENT'); }),
  writeFile: vi.fn(async () => undefined),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(() => { throw new Error('not found'); }),
  execFileSync: vi.fn(() => { throw new Error('not found'); }),
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
    if (cb) cb(new Error('not found'), { stdout: '', stderr: '' });
    return { stdout: '', stderr: '' };
  }),
}));

vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: `${path.join(path.sep, 'usr', 'local', 'bin')}${path.delimiter}${path.join(path.sep, 'usr', 'bin')}` })),
  invalidateShellEnvironmentCache: vi.fn(),
}));

import * as fs from 'fs';
import { ClaudeCodeProvider } from './claude-code-provider';
import { CopilotCliProvider } from './copilot-cli-provider';
import { CodexCliProvider } from './codex-cli-provider';
import { clearBinaryCache } from './shared';
import type { FreeAgentPermissionMode } from '../../shared/types';
import {
  ACCESS_LEVELS,
  accessLevelOf,
  launchAccessFor,
  providerAccessLevel,
  resolveHelperAccess,
  type AgentAccessLevel,
  type OrchestrationAccess,
} from '../../shared/orchestration-policy';

const CWD = path.join(path.sep, 'projects', 'app');

const providers = {
  'claude-code': () => new ClaudeCodeProvider(),
  'codex-cli': () => new CodexCliProvider(),
  'copilot-cli': () => new CopilotCliProvider(),
} as const;
type ProviderId = keyof typeof providers;

async function flags(id: ProviderId, launch: { freeAgentMode: boolean; permissionMode?: FreeAgentPermissionMode }): Promise<string[]> {
  const { args } = await providers[id]().buildSpawnCommand({ cwd: CWD, ...launch });
  return args;
}

/** The access the flags actually grant, read from the flags alone. */
function flagLevel(id: ProviderId, args: string[]): AgentAccessLevel {
  const has = (flag: string) => args.includes(flag);
  switch (id) {
    case 'claude-code':
      if (has('--dangerously-skip-permissions')) return 'bypass';
      return has('--permission-mode') ? 'auto' : 'standard';
    case 'codex-cli':
      if (has('--dangerously-bypass-approvals-and-sandbox')) return 'bypass';
      return has('--ask-for-approval') ? 'auto' : 'standard';
    case 'copilot-cli':
      if (has('--yolo')) return 'bypass';
      return has('--allow-all-tools') ? 'auto' : 'standard';
  }
}

const rank = (level: AgentAccessLevel) => ACCESS_LEVELS.indexOf(level);

describe('helper launch flags per provider (#2228)', () => {
  beforeEach(() => {
    clearBinaryCache();
    vi.mocked(fs.existsSync).mockImplementation((p) => ['claude', 'codex', 'copilot'].some((n) => path.basename(String(p)).replace(/\.(exe|cmd)$/, '') === n));
  });

  it('standard adds no permission flags on any provider', async () => {
    expect(await flags('claude-code', launchAccessFor('standard'))).not.toEqual(expect.arrayContaining(['--permission-mode']));
    for (const id of Object.keys(providers) as ProviderId[]) {
      expect(flagLevel(id, await flags(id, launchAccessFor('standard')))).toBe('standard');
    }
    const copilot = await flags('copilot-cli', launchAccessFor('standard'));
    expect(copilot).not.toContain('--allow-all-tools');
    expect(copilot).not.toContain('--yolo');
  });

  it('providerAccessLevel matches the real flags for every level', async () => {
    for (const id of Object.keys(providers) as ProviderId[]) {
      for (const level of ACCESS_LEVELS) {
        expect(providerAccessLevel(id, launchAccessFor(level))).toBe(flagLevel(id, await flags(id, launchAccessFor(level))));
      }
      // The unpinned combinations an orchestrator may run with, too.
      for (const launch of [{ freeAgentMode: false, permissionMode: 'skip-all' as const }, { freeAgentMode: true }]) {
        expect(providerAccessLevel(id, launch)).toBe(flagLevel(id, await flags(id, launch)));
      }
    }
  });

  it('a helper\'s real flags never exceed its orchestrator\'s', async () => {
    const lives: Array<{ freeAgentMode: boolean; permissionMode?: FreeAgentPermissionMode } | undefined> = [
      undefined,
      { freeAgentMode: false, permissionMode: 'auto' },
      { freeAgentMode: false, permissionMode: 'skip-all' },
      { freeAgentMode: true },
      { freeAgentMode: true, permissionMode: 'auto' },
      { freeAgentMode: true, permissionMode: 'skip-all' },
    ];
    const accesses: OrchestrationAccess[] = ['same', ...ACCESS_LEVELS];
    for (const live of lives) {
      const ceiling = rank(accessLevelOf(live));
      for (const access of accesses) {
        for (const id of Object.keys(providers) as ProviderId[]) {
          const helper = resolveHelperAccess(live, access, id);
          const real = flagLevel(id, await flags(id, { freeAgentMode: helper.freeAgentMode, permissionMode: helper.permissionMode }));
          expect(rank(real), `${id} ${access} ${JSON.stringify(live)}`).toBeLessThanOrEqual(ceiling);
        }
      }
    }
  });
});
