import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Real git in a temp repository: ownership is decided against HEAD.
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('../util/shell', () => ({ getShellEnvironment: vi.fn(() => ({ PATH: process.env.PATH })) }));

import { CLUBHOUSE_WRITTEN_FILES, parsePorcelain, withoutClubhouseOwnedChanges } from './clubhouse-owned-files';
import { ClaudeCodeProvider } from '../orchestrators/claude-code-provider';
import { CodexCliProvider } from '../orchestrators/codex-cli-provider';
import { CopilotCliProvider } from '../orchestrators/copilot-cli-provider';
import { getHooksConfigPath } from './config-pipeline';

const BRIDGE = { command: 'node', args: ['/Applications/Clubhouse.app/bridge/clubhouse-mcp-bridge.js'] };
const HOOK = { hooks: [{ type: 'command', command: 'curl -s http://127.0.0.1:4000/hook/ -H "X-Agent: $CLUBHOUSE_AGENT_ID"' }] };

let root: string;
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
  const status = git(['status', '--porcelain', '--untracked-files=all']);
  return (await withoutClubhouseOwnedChanges(repo, parsePorcelain(status))).map((c) => c.path);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-owned-'));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(root, 'no-global-ignores'), '');
  git(['init', '-q']);
  write('README.md', 'hi\n');
  commitAll();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('withoutClubhouseOwnedChanges', () => {
  it('drops untracked config files that hold only what Clubhouse wrote', async () => {
    write('.mcp.json', { mcpServers: { clubhouse: BRIDGE } });
    write('.claude/settings.local.json', { hooks: { Stop: [HOOK] } });
    write('.github/hooks/hooks.json', { version: 1, hooks: { preToolUse: [{ type: 'command', bash: 'curl http://127.0.0.1:1/hook/x' }] } });
    write('.codex/config.toml', '[mcp_servers.clubhouse]\ncommand = "node"\nargs = ["clubhouse-mcp-bridge.js"]\n');
    expect(await remaining()).toEqual([]);
  });

  it('keeps an untracked config file with anything of the user\'s in it', async () => {
    write('.mcp.json', { mcpServers: { clubhouse: BRIDGE, mine: { command: 'my-server' } } });
    write('.claude/settings.local.json', { hooks: { Stop: [HOOK] }, permissions: { allow: ['Bash(npm test)'] } });
    expect((await remaining()).sort()).toEqual(['.claude/settings.local.json', '.mcp.json']);
  });

  it('keeps real work next to Clubhouse\'s files', async () => {
    write('.mcp.json', { mcpServers: { clubhouse: BRIDGE } });
    write('src/feature.ts', 'export {};\n');
    expect(await remaining()).toEqual(['src/feature.ts']);
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
    expect(await remaining()).toEqual(['sub/.mcp.json']);
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
