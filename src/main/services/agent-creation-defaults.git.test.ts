import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Real git, real files and the real project defaults (#3243): a managed agent's
// folder holds none of the project's legacy instructions, permissions or MCP,
// whatever its CLI, and a CLI that can't take the defaults refuses a plain
// agent before anything is made.

const h = vi.hoisted(() => ({ provider: null as unknown }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./agent-system', () => ({ resolveOrchestrator: vi.fn(async () => h.provider) }));
vi.mock('./chat-idle-settings', () => ({ setAgentIdleSleep: vi.fn() }));
vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: process.env.PATH ?? '' })),
  invalidateShellEnvironmentCache: vi.fn(),
  buildCliSpawnEnv: vi.fn(() => ({})),
}));

import { clearAgentConfigCache, createDurable, flushAllAgentConfigs, listDurable } from './agent-config';
import { ClaudeCodeProvider } from '../orchestrators/claude-code-provider';
import { CodexCliProvider } from '../orchestrators/codex-cli-provider';
import { CopilotCliProvider } from '../orchestrators/copilot-cli-provider';

const MARKER = 'legacy-default-marker';
const DEFAULTS = {
  instructions: `# Project default\n\n${MARKER} instructions\n`,
  permissions: { allow: [`Bash(${MARKER}:*)`], deny: ['Bash(rm:*)'] },
  mcpJson: JSON.stringify({ mcpServers: { [MARKER]: { command: `${MARKER}-server` } } }),
};

let root: string;
let project: string;

function git(args: string[], cwd = project): string {
  return execFileSync('git', [
    '-c', 'user.name=Clubhouse Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false',
    ...args,
  ], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function branchExists(name: string): boolean {
  try {
    git(['show-ref', '--verify', '--quiet', `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

/** Every file under `dir` that mentions the legacy defaults, as paths relative to it. */
function legacyResidue(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (fs.readFileSync(full, 'utf-8').includes(MARKER)) out.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return out;
}

const PROVIDERS = [
  ['Claude Code', () => new ClaudeCodeProvider()],
  ['Codex', () => new CodexCliProvider()],
  ['Copilot CLI', () => new CopilotCliProvider()],
] as const;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-create-defaults-'));
  project = path.join(root, 'project');
  fs.mkdirSync(project);
  git(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(project, 'README.md'), 'hello\n');
  git(['add', 'README.md']);
  git(['commit', '-q', '-m', 'init']);
  fs.mkdirSync(path.join(project, '.clubhouse'), { recursive: true });
  fs.writeFileSync(path.join(project, '.clubhouse', 'settings.json'), JSON.stringify({ defaults: {}, quickOverrides: {}, agentDefaults: DEFAULTS }));
  clearAgentConfigCache();
});

afterEach(async () => {
  await flushAllAgentConfigs();
  clearAgentConfigCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('legacy project defaults at creation (#3243)', () => {
  it.each(PROVIDERS)('a managed agent on %s gets none of them', async (_name, make) => {
    h.provider = make();
    const config = await createDurable(project, 'managed', 'indigo', undefined, true, undefined, undefined, undefined, undefined, {}, { projectDefaults: false });
    expect(config.worktreePath).toBeTruthy();
    expect(fs.existsSync(config.worktreePath!)).toBe(true);
    expect(legacyResidue(config.worktreePath!)).toEqual([]);
  });

  it('a plain agent on a CLI with permission rules gets them, as before', async () => {
    h.provider = new ClaudeCodeProvider();
    const config = await createDurable(project, 'plain', 'indigo');
    expect(legacyResidue(config.worktreePath!).length).toBeGreaterThan(0);
  });

  it('a plain agent on a CLI without permission rules is refused before its branch, folder or record exist', async () => {
    h.provider = new CopilotCliProvider();
    await expect(createDurable(project, 'copilot', 'indigo')).rejects.toThrow(/Default permissions/);
    expect(fs.existsSync(path.join(project, '.clubhouse', 'agents', 'copilot'))).toBe(false);
    expect(branchExists('copilot/standby')).toBe(false);
    expect(git(['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length).toBe(1);
    expect(await listDurable(project)).toEqual([]);
  });
});
