import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Real git in a temp repository: ownership is decided against HEAD.
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('../util/shell', () => ({ getShellEnvironment: vi.fn(() => ({ PATH: process.env.PATH })) }));

import { CLUBHOUSE_WRITTEN_FILES, uncommittedPorcelain, isClubhouseHookCommand } from './clubhouse-owned-files';
import { buildHookCurlCommand } from '../orchestrators/shared';
import { ClaudeCodeProvider } from '../orchestrators/claude-code-provider';
import { CodexCliProvider } from '../orchestrators/codex-cli-provider';
import { CopilotCliProvider } from '../orchestrators/copilot-cli-provider';
import { getHooksConfigPath } from './config-pipeline';

const BRIDGE = { command: 'node', args: ['/Applications/Clubhouse.app/bridge/clubhouse-mcp-bridge.js'] };
/** The hook commands Clubhouse writes, on this platform. */
const CURL = buildHookCurlCommand('http://127.0.0.1:4000/hook');
const COPILOT_CURL = buildHookCurlCommand('http://127.0.0.1:4000/hook', '/preToolUse');
const OUR_HOOK = { type: 'command', command: CURL, async: true, timeout: 5 };
const HOOK = { hooks: [OUR_HOOK] };

let root: string;
let savedEnv: Record<string, string | undefined>;
let repo: string;

function git(args: string[]): string {
  return execFileSync('git', [
    '-c', 'user.name=Clubhouse Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false',
    // The machine's global ignores (Claude Code adds settings.local.json there) must not hide files.
    '-c', `core.excludesFile=${path.join(root, 'no-global-ignores')}`, ...args,
  ], { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(rel: string, content: unknown): void {
  const file = path.join(repo, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

function commitAll(): void {
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'commit']);
}

async function remaining(): Promise<string[]> {
  return (await uncommittedPorcelain(repo)).map((line) => line.slice(3));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-owned-'));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(root, 'no-global-ignores'), '');
  // The code under test runs its own git: keep the machine's global config and
  // ignores (Claude Code adds settings.local.json there) out of it.
  savedEnv = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.GIT_CONFIG_GLOBAL = path.join(root, 'no-global-ignores');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.XDG_CONFIG_HOME = root;
  git(['init', '-q']);
  write('README.md', 'hi\n');
  commitAll();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('withoutClubhouseOwnedChanges', () => {
  it('drops untracked config files that hold only what Clubhouse wrote', async () => {
    write('.mcp.json', { mcpServers: { clubhouse: BRIDGE } });
    write('.claude/settings.local.json', { hooks: { Stop: [HOOK] } });
    write('.github/hooks/hooks.json', { version: 1, hooks: { preToolUse: [{ type: 'command', bash: COPILOT_CURL, timeoutSec: 5 }] } });
    write('.codex/hooks.json', { hooks: { Notification: [{ matcher: '', hooks: [OUR_HOOK] }] } });
    write('.codex/config.toml', '[mcp_servers.clubhouse]\ncommand = "node"\nargs = ["clubhouse-mcp-bridge.js"]\n');
    expect(await remaining()).toEqual([]);
  });

  it('keeps an untracked config file with anything of the user\'s in it', async () => {
    write('.mcp.json', { mcpServers: { clubhouse: BRIDGE, mine: { command: 'my-server' } } });
    write('.claude/settings.local.json', { hooks: { Stop: [HOOK] }, permissions: { allow: ['Bash(npm test)'] } });
    expect((await remaining()).sort()).toEqual(['.claude/settings.local.json', '.mcp.json']);
  });

  it('keeps real work next to Clubhouse\'s files, in its folder and elsewhere', async () => {
    write('.mcp.json', { mcpServers: { clubhouse: BRIDGE } });
    write('.claude/settings.local.json', { hooks: { Stop: [HOOK] } });
    write('.claude/commands/review.md', '# review\n');
    write('src/feature.ts', 'export {};\n');
    expect((await remaining()).sort()).toEqual(['.claude/commands/review.md', 'src/']);
  });

  it('keeps a user hook that shares a group with Clubhouse\'s', async () => {
    const userHook = { type: 'command', command: 'npm run lint' };
    write('.claude/settings.local.json', { hooks: { Stop: [{ hooks: [OUR_HOOK, userHook] }] } });
    expect(await remaining()).toEqual(['.claude/settings.local.json']);
  });

  it('keeps a user hook whose command merely has /hook/ in it', async () => {
    write('.claude/settings.local.json', { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: './scripts/hook/lint.sh' }] }] } });
    expect(await remaining()).toEqual(['.claude/settings.local.json']);
    expect(isClubhouseHookCommand('./scripts/hook/lint.sh')).toBe(false);
    expect(isClubhouseHookCommand('curl -s http://127.0.0.1:4000/hook/x')).toBe(false);
  });

  it('keeps a hook group with a matcher of the user\'s', async () => {
    write('.claude/settings.local.json', { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [OUR_HOOK] }] } });
    expect(await remaining()).toEqual(['.claude/settings.local.json']);
  });

  it('keeps a "clubhouse" MCP server that is not the bridge', async () => {
    write('.mcp.json', { mcpServers: { clubhouse: { command: 'node', args: ['my-own-clubhouse-server.js'] } } });
    expect(await remaining()).toEqual(['.mcp.json']);
  });

  it('lists an untracked folder without Clubhouse files as one line, as git does', async () => {
    for (let i = 0; i < 50; i++) write(`build/out-${i}.txt`, 'x');
    expect(await remaining()).toEqual(['build/']);
  });

  it('throws when git cannot read the status, never reporting it clean', async () => {
    await expect(uncommittedPorcelain(path.join(root, 'not-a-repo'))).rejects.toThrow();
  });

  it('drops a committed .mcp.json that Clubhouse only added its entry to', async () => {
    write('.mcp.json', { mcpServers: { project: { command: 'project-server' } } });
    commitAll();
    write('.mcp.json', { mcpServers: { project: { command: 'project-server' }, clubhouse: BRIDGE } });
    expect(await remaining()).toEqual([]);
  });

  it('keeps a committed .mcp.json the user also changed', async () => {
    write('.mcp.json', { mcpServers: { project: { command: 'project-server' } } });
    commitAll();
    write('.mcp.json', { mcpServers: { project: { command: 'project-server', args: ['--new'] }, clubhouse: BRIDGE } });
    expect(await remaining()).toEqual(['.mcp.json']);
  });

  it('keeps a committed .mcp.json that was deleted', async () => {
    write('.mcp.json', { mcpServers: { clubhouse: BRIDGE } });
    commitAll();
    fs.rmSync(path.join(repo, '.mcp.json'));
    expect(await remaining()).toEqual(['.mcp.json']);
  });

  it('keeps a config file that does not parse', async () => {
    write('.mcp.json', '{ "mcpServers": ');
    expect(await remaining()).toEqual(['.mcp.json']);
  });

  it('keeps a file of the same name elsewhere in the tree', async () => {
    write('sub/.mcp.json', { mcpServers: { clubhouse: BRIDGE } });
    expect(await remaining()).toEqual(['sub/']);
  });
});

describe('CLUBHOUSE_WRITTEN_FILES', () => {
  it('names every provider\'s MCP config and hooks file', () => {
    for (const provider of [new ClaudeCodeProvider(), new CodexCliProvider(), new CopilotCliProvider()]) {
      expect(CLUBHOUSE_WRITTEN_FILES).toContain(provider.conventions.mcpConfigFile);
      const hooks = getHooksConfigPath(provider, '');
      if (hooks) expect(CLUBHOUSE_WRITTEN_FILES).toContain(hooks.split(path.sep).join('/'));
    }
  });
});
