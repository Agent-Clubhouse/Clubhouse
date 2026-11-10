import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Real git, real files and the real project defaults (#3243, #3245): an agent
// gets none of the project's legacy instructions, permissions, MCP or commands
// unless the person asked for the copy, whatever its CLI. A copy into a CLI
// that can't take permission rules skips them, and a copy into an existing
// plain agent does what its preview said.

// Real git and worktrees: a loaded or Windows runner can take longer than the default 10 s.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const h = vi.hoisted(() => ({ provider: null as unknown }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./agent-system', () => ({ resolveOrchestrator: vi.fn(async () => h.provider) }));
vi.mock('./chat-idle-settings', () => ({ setAgentIdleSleep: vi.fn() }));
vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: process.env.PATH ?? '' })),
  invalidateShellEnvironmentCache: vi.fn(),
  buildCliSpawnEnv: vi.fn(() => ({})),
}));

import { clearAgentConfigCache, createDurable, flushAllAgentConfigs, getDurableConfig } from './agent-config';
import { copyIntoAgent, previewCopyIntoAgent, previewCopyIntoNewAgent } from './legacy-defaults';
import { ClaudeCodeProvider } from '../orchestrators/claude-code-provider';
import { CodexCliProvider } from '../orchestrators/codex-cli-provider';
import { CopilotCliProvider } from '../orchestrators/copilot-cli-provider';

const MARKER = 'legacy-default-marker';
const DEFAULTS = {
  instructions: `# Project default\n\n${MARKER} instructions\n`,
  permissions: { allow: [`Bash(${MARKER}:*)`], deny: ['Bash(rm:*)'] },
  buildCommand: `make ${MARKER}`,
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

/** A file's text with LF line endings: a Windows checkout can give CRLF. */
const lf = (text: string) => text.replace(/\r\n/g, '\n');

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
  // Windows can hold a just-closed file briefly (EBUSY): retry rather than fail the hook.
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const COPY = { copyLegacyDefaults: true } as const;

describe('legacy project defaults at creation (#3243, #3245)', () => {
  it.each(PROVIDERS)('an agent on %s gets none of them unless asked', async (_name, make) => {
    h.provider = make();
    const config = await createDurable(project, 'plain', 'indigo');
    expect(fs.existsSync(config.worktreePath!)).toBe(true);
    expect(legacyResidue(config.worktreePath!)).toEqual([]);
    expect(config.buildCommand).toBeUndefined();
  });

  it('a copy on a CLI with permission rules brings instructions, rules, MCP servers and commands', async () => {
    h.provider = new ClaudeCodeProvider();
    const config = await createDurable(project, 'copied', 'indigo', undefined, true, undefined, undefined, undefined, undefined, {}, COPY);
    const residue = legacyResidue(config.worktreePath!).map((f) => f.replace(/\\/g, '/'));
    expect(residue).toEqual(expect.arrayContaining(['CLAUDE.md', '.mcp.json', '.claude/settings.local.json']));
    expect(config.buildCommand).toBe(`make ${MARKER}`);
  });

  it('a copy on a CLI without permission rules makes the agent and skips the rules', async () => {
    h.provider = new CopilotCliProvider();
    const config = await createDurable(project, 'copilot', 'indigo', undefined, true, undefined, undefined, undefined, undefined, {}, COPY);
    expect(config).not.toHaveProperty('creation');
    const files = legacyResidue(config.worktreePath!);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(fs.readFileSync(path.join(config.worktreePath!, f), 'utf-8')).not.toContain(`Bash(${MARKER}`);
  });

  it('a copy into an existing plain agent does what its preview said, keeping its own instructions', async () => {
    h.provider = new ClaudeCodeProvider();
    const made = await createDurable(project, 'existing', 'indigo');
    fs.writeFileSync(path.join(made.worktreePath!, 'CLAUDE.md'), 'My own notes.\n');

    const preview = await previewCopyIntoAgent(project, made.id);
    expect(preview.blocked).toBeNull();
    expect(preview.changes.map((c) => `${c.item}:${c.action}`)).toEqual(['instructions:append', 'permissions:write', 'mcp:write', 'buildCommand:set']);
    expect(legacyResidue(made.worktreePath!)).toEqual([]);

    const done = await copyIntoAgent(project, made.id);
    expect(done.changes).toEqual(preview.changes);
    const instructions = fs.readFileSync(path.join(made.worktreePath!, 'CLAUDE.md'), 'utf-8');
    expect(instructions.startsWith('My own notes.')).toBe(true);
    expect(instructions).toContain(MARKER);
    expect((await getDurableConfig(project, made.id))?.buildCommand).toBe(`make ${MARKER}`);

    const again = await previewCopyIntoAgent(project, made.id);
    expect(again.changes.every((c) => c.action === 'unchanged')).toBe(true);
  });

  it('previews a new agent\'s copy from the files git checks out for it, and writes exactly that (#3245 review)', async () => {
    h.provider = new ClaudeCodeProvider();
    // The repository already tracks its own instructions and MCP file, one server sharing a name with the defaults.
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Repo rules\n\nKeep it tidy.\n');
    fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { repo: { command: 'repo-mcp' }, [MARKER]: { command: 'repo-owned' } } }, null, 2));
    git(['add', 'CLAUDE.md', '.mcp.json']);
    git(['commit', '-q', '-m', 'tracked agent files']);

    const preview = await previewCopyIntoNewAgent(project, 'tracked');
    expect(preview.changes.map((c) => `${c.item}:${c.action}`)).toEqual(['instructions:append', 'permissions:write', 'mcp:unchanged', 'buildCommand:set']);

    // The same plan for an agent whose worktree really has those files.
    const twin = await createDurable(project, 'twin', 'indigo');
    const twinPreview = await previewCopyIntoAgent(project, twin.id);
    expect(twinPreview.changes.map(({ item, target, action }) => ({ item, target, action })))
      .toEqual(preview.changes.map(({ item, target, action }) => ({ item, target, action })));

    // Creating with the copy writes what the preview said: added to the tracked files, never over them.
    const made = await createDurable(project, 'tracked', 'indigo', undefined, true, undefined, undefined, undefined, undefined, {}, COPY);
    const instructions = lf(fs.readFileSync(path.join(made.worktreePath!, 'CLAUDE.md'), 'utf-8'));
    expect(instructions.startsWith('# Repo rules\n\nKeep it tidy.')).toBe(true);
    expect(instructions).toContain(`${MARKER} instructions`);
    const mcp = JSON.parse(fs.readFileSync(path.join(made.worktreePath!, '.mcp.json'), 'utf-8'));
    expect(mcp.mcpServers).toEqual({ repo: { command: 'repo-mcp' }, [MARKER]: { command: 'repo-owned' } });
    expect((await previewCopyIntoAgent(project, made.id)).changes.every((c) => c.action === 'unchanged')).toBe(true);
  });

  it('previews from an existing <name>/standby branch, which creation reuses, not from HEAD', async () => {
    h.provider = new ClaudeCodeProvider();
    // The leftover branch already has the project's instructions; HEAD has none.
    git(['checkout', '-q', '-b', 'stale/standby']);
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), `Old notes.\n\n${DEFAULTS.instructions.trim()}\n`);
    git(['add', 'CLAUDE.md']);
    git(['commit', '-q', '-m', 'left over']);
    git(['checkout', '-q', 'main']);
    // As a Windows checkout does: the worktree gets CRLF, while the preview reads LF from git.
    git(['config', 'core.autocrlf', 'true']);

    const preview = await previewCopyIntoNewAgent(project, 'stale');
    expect(preview.changes.find((c) => c.item === 'instructions')?.action).toBe('unchanged');
    const made = await createDurable(project, 'stale', 'indigo', undefined, true, undefined, undefined, undefined, undefined, {}, COPY);
    expect(lf(fs.readFileSync(path.join(made.worktreePath!, 'CLAUDE.md'), 'utf-8'))).toBe(`Old notes.\n\n${DEFAULTS.instructions.trim()}\n`);
  });

  it('previews from a detached HEAD, where creation starts the branch', async () => {
    h.provider = new ClaudeCodeProvider();
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Detached\n');
    git(['add', 'CLAUDE.md']);
    git(['commit', '-q', '-m', 'instructions']);
    git(['checkout', '-q', '--detach', 'HEAD']);

    const preview = await previewCopyIntoNewAgent(project, 'detached');
    expect(preview.changes.find((c) => c.item === 'instructions')?.action).toBe('append');
    const made = await createDurable(project, 'detached', 'indigo', undefined, true, undefined, undefined, undefined, undefined, {}, COPY);
    expect(lf(fs.readFileSync(path.join(made.worktreePath!, 'CLAUDE.md'), 'utf-8')).startsWith('# Detached\n\n')).toBe(true);
  });
});
