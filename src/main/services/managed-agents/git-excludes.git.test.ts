/** Managed git excludes against real git: a main checkout with agent worktrees, as Clubhouse makes them (D73, D76, D97). */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../../shared/types';
import type { OrchestratorProvider } from '../../orchestrators/types';

const listeners = vi.hoisted(() => new Set<(projectPath: string) => void>());
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../agent-config', () => ({
  peekDurableConfigs: async () => [],
  onAgentConfigChanged: (fn: (projectPath: string) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
}));

import { managedRootExcludesInEffect, refreshManagedExcludes, watchManagedExcludes, type ManagedExcludeDeps } from './git-excludes';

const claude = { id: 'claude-code', conventions: { configDir: '.claude', skillsDir: 'skills', mcpConfigFile: '.mcp.json', legacyInstructionsFile: 'CLAUDE.md', localSettingsFile: 'settings.local.json', settingsFormat: 'json' } } as unknown as OrchestratorProvider;
const codex = { id: 'codex-cli', conventions: { configDir: '.codex', skillsDir: 'skills', skillsRoot: '.agents/skills', previousSkillsRoots: ['.codex/skills'], mcpConfigFile: '.codex/config.toml', legacyInstructionsFile: 'AGENTS.md', localSettingsFile: 'config.toml', settingsFormat: 'toml' } } as unknown as OrchestratorProvider;
const copilot = { id: 'copilot-cli', conventions: { configDir: '.github', skillsDir: 'skills', mcpConfigFile: '.github/mcp.json', legacyInstructionsFile: 'copilot-instructions.md', localSettingsFile: 'settings.json', settingsFormat: 'json' } } as unknown as OrchestratorProvider;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Ignored by this repository's excludes only, not the machine's global ignore file (Claude Code adds settings.local.json there). */
function ignored(cwd: string, rel: string): boolean {
  try {
    execFileSync('git', ['-c', `core.excludesFile=${path.join(os.tmpdir(), 'no-global-ignore')}`, 'check-ignore', '-q', '--', rel], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let project: string;
let agents: DurableAgentConfig[];

/** A managed (or plain) agent with its own worktree in `.clubhouse/agents/<name>`, as Clubhouse makes them. */
function addAgent(name: string, cli: string, managed = true): DurableAgentConfig {
  const worktreePath = path.join(project, '.clubhouse', 'agents', name);
  git(project, 'worktree', 'add', '-q', '-b', `${name}/standby`, worktreePath);
  const agent: DurableAgentConfig = {
    id: name, name, color: 'indigo', createdAt: '', worktreePath, orchestrator: cli,
    ...(managed && { managed: { version: 1, blocks: [], skills: [], mcps: [] } }),
  };
  agents.push(agent);
  return agent;
}

const deps: ManagedExcludeDeps = {
  listAgents: async () => agents,
  cliOf: async (_p, agent) => agent.orchestrator ?? null,
  providers: () => [claude, codex, copilot],
};

const excludeFile = () => fs.readFileSync(path.join(project, '.git', 'info', 'exclude'), 'utf-8');

beforeEach(() => {
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-excludes-')));
  git(project, 'init', '-q');
  git(project, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  // Clubhouse ignores its own folder; worktrees live there.
  fs.writeFileSync(path.join(project, '.git', 'info', 'exclude'), '# mine\n*.log\n.clubhouse/\n');
  agents = [];
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

describe('root files of managed agents (D97)', () => {
  it('ignores the delivered root files in the main checkout and every worktree, anchored to the root', async () => {
    const one = addAgent('one', 'claude-code');
    addAgent('plain', 'claude-code', false);
    await refreshManagedExcludes(project, deps);
    for (const cwd of [project, one.worktreePath!, path.join(project, '.clubhouse', 'agents', 'plain')]) {
      expect(ignored(cwd, 'CLAUDE.md')).toBe(true);
      expect(ignored(cwd, '.mcp.json')).toBe(true);
      expect(ignored(cwd, path.join('.claude', 'settings.local.json'))).toBe(true);
      expect(ignored(cwd, '.clubhouse-managed-excludes.json')).toBe(true);
      expect(ignored(cwd, path.join('.clubhouse-before-managed', '.mcp.json'))).toBe(true);
      // Anchored: the same name in a subfolder, and the person's other files, still show.
      expect(ignored(cwd, path.join('docs', 'CLAUDE.md'))).toBe(false);
      expect(ignored(cwd, path.join('.claude', 'settings.json'))).toBe(false);
      expect(ignored(cwd, 'AGENTS.md')).toBe(false);
    }
    // The person's own lines are kept.
    expect(excludeFile().startsWith('# mine\n*.log\n.clubhouse/\n')).toBe(true);
    expect(await managedRootExcludesInEffect(project, [claude, codex, copilot])).toEqual(['/.claude/settings.local.json', '/.mcp.json', '/CLAUDE.md']);
  });

  it('doesn\'t affect a file the project tracks: it still shows as modified', async () => {
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# ours\n');
    git(project, 'add', 'CLAUDE.md');
    git(project, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'add CLAUDE.md');
    const one = addAgent('one', 'claude-code');
    await refreshManagedExcludes(project, deps);
    expect(excludeFile()).not.toContain('/CLAUDE.md');
    fs.writeFileSync(path.join(one.worktreePath!, 'CLAUDE.md'), '# delivered\n');
    expect(git(one.worktreePath!, 'status', '--porcelain')).toContain('CLAUDE.md');
  });

  it('gives each CLI its own files: Codex its AGENTS.md and no MCP file, Copilot its .github files', async () => {
    addAgent('cx', 'codex-cli');
    addAgent('cp', 'copilot-cli');
    await refreshManagedExcludes(project, deps);
    expect(ignored(project, 'AGENTS.md')).toBe(true);
    expect(ignored(project, path.join('.codex', 'config.toml'))).toBe(false);
    expect(ignored(project, path.join('.github', 'copilot-instructions.md'))).toBe(true);
    expect(ignored(project, path.join('.github', 'mcp.json'))).toBe(true);
    expect(ignored(project, 'CLAUDE.md')).toBe(false);
    expect(ignored(project, '.mcp.json')).toBe(false);
    expect(excludeFile()).not.toContain('# >>> clubhouse-managed-claude-code');
  });

  it('takes a CLI\'s root files out once no managed agent runs it, and keeps the rest of its block', async () => {
    const one = addAgent('one', 'claude-code');
    addAgent('cx', 'codex-cli');
    fs.mkdirSync(path.join(one.worktreePath!, '.claude', 'skills', 'build'), { recursive: true });
    fs.writeFileSync(path.join(one.worktreePath!, '.claude', 'skills', '.clubhouse-managed-skills.json'), JSON.stringify({ skills: ['build'] }));
    await refreshManagedExcludes(project, deps);
    expect(ignored(project, 'CLAUDE.md')).toBe(true);

    // Stop managing it.
    delete one.managed;
    await refreshManagedExcludes(project, deps);
    expect(ignored(project, 'CLAUDE.md')).toBe(false);
    expect(ignored(project, '.mcp.json')).toBe(false);
    expect(ignored(project, path.join('.claude', 'settings.local.json'))).toBe(false);
    // What only Clubhouse wrote stays excluded, and Codex's agent still has its own.
    expect(ignored(project, path.join('.claude', 'skills', 'build', 'SKILL.md'))).toBe(true);
    expect(ignored(project, '.clubhouse-managed-excludes.json')).toBe(true);
    expect(ignored(project, 'AGENTS.md')).toBe(true);

    // The last one goes too.
    agents = agents.filter((a) => a.id !== 'cx');
    await refreshManagedExcludes(project, deps);
    expect(ignored(project, 'AGENTS.md')).toBe(false);
    expect(await managedRootExcludesInEffect(project, [claude, codex, copilot])).toEqual([]);
  });

  it('follows an agent that moves to another CLI', async () => {
    const one = addAgent('one', 'claude-code');
    await refreshManagedExcludes(project, deps);
    one.orchestrator = 'codex-cli';
    await refreshManagedExcludes(project, deps);
    expect(ignored(project, 'CLAUDE.md')).toBe(false);
    expect(ignored(project, 'AGENTS.md')).toBe(true);
  });

  it('excludes exactly the skill folders Clubhouse delivered, across the project\'s managed agents (D73)', async () => {
    const one = addAgent('one', 'claude-code');
    const two = addAgent('two', 'claude-code');
    const plain = addAgent('plain', 'claude-code', false);
    const manifest = (agent: DurableAgentConfig, rel: string, names: string[]) => {
      fs.mkdirSync(path.join(agent.worktreePath!, rel), { recursive: true });
      fs.writeFileSync(path.join(agent.worktreePath!, rel, '.clubhouse-managed-skills.json'), JSON.stringify({ skills: names }));
    };
    manifest(one, path.join('.claude', 'skills'), ['build', 'test']);
    manifest(two, path.join('.claude', 'skills'), ['notes', 'build', '../escape', '*']);
    manifest(plain, path.join('.claude', 'skills'), ['theirs']);
    await refreshManagedExcludes(project, deps);
    expect(ignored(project, path.join('.claude', 'skills', 'notes', 'SKILL.md'))).toBe(true);
    expect(ignored(project, path.join('.claude', 'skills', 'theirs', 'SKILL.md'))).toBe(false);
    expect(ignored(project, path.join('.claude', 'skills', 'mine', 'SKILL.md'))).toBe(false);
    expect(excludeFile()).not.toContain('escape');
  });

  it('excludes Codex\'s .agents/skills folders, and the old .codex/skills ones until that folder is cleaned up', async () => {
    const cx = addAgent('cx', 'codex-cli');
    const later = addAgent('later', 'codex-cli');
    fs.mkdirSync(path.join(cx.worktreePath!, '.agents', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(cx.worktreePath!, '.agents', 'skills', '.clubhouse-managed-skills.json'), JSON.stringify({ skills: ['build'] }));
    fs.mkdirSync(path.join(later.worktreePath!, '.codex', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(later.worktreePath!, '.codex', 'skills', '.clubhouse-managed-skills.json'), JSON.stringify({ skills: ['ship'] }));
    await refreshManagedExcludes(project, deps);
    expect(ignored(project, path.join('.agents', 'skills', 'build', 'SKILL.md'))).toBe(true);
    expect(ignored(project, path.join('.codex', 'skills', 'ship', 'SKILL.md'))).toBe(true);
    expect(ignored(project, path.join('.agents', 'skills', 'mine', 'SKILL.md'))).toBe(false);
  });

  it('removes the dead old-format blocks', async () => {
    fs.appendFileSync(path.join(project, '.git', 'info', 'exclude'), 'CLAUDE.md # clubhouse-mode\n.clubhouse-before-managed/ # clubhouse-managed-backup\n');
    addAgent('one', 'claude-code');
    await refreshManagedExcludes(project, deps);
    expect(excludeFile()).not.toContain(' # ');
  });

  it('writes nothing outside a git checkout', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-excludes-plain-'));
    try {
      agents = [{ id: 'x', name: 'x', color: 'indigo', createdAt: '', worktreePath: path.join(folder, 'x'), orchestrator: 'claude-code', managed: { version: 1, blocks: [], skills: [], mcps: [] } }];
      await refreshManagedExcludes(folder, deps);
      expect(fs.existsSync(path.join(folder, '.git'))).toBe(false);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('queueManagedExcludes (D97)', () => {
  it('says when a refresh has finished, so Settings reads the names as written', async () => {
    addAgent('one', 'claude-code');
    const { queueManagedExcludes } = await import('./git-excludes');
    let ignoredThen: boolean | null = null;
    // By the time it is called, the names are in the exclude file.
    const refreshed = vi.fn(() => { ignoredThen = ignored(project, 'CLAUDE.md'); });
    await queueManagedExcludes(project, { ...deps, onRefreshed: refreshed });
    expect(refreshed).toHaveBeenCalledWith(project);
    expect(ignoredThen).toBe(true);
  });
});

describe('watchManagedExcludes (D97)', () => {
  it('refreshes when a project\'s managed agents change, not on every agent write', async () => {
    const one = addAgent('one', 'claude-code');
    const listAgents = vi.fn(async () => agents);
    const stop = watchManagedExcludes({ ...deps, listAgents });
    try {
      for (const fn of listeners) fn(project);
      await vi.waitFor(() => expect(ignored(project, 'CLAUDE.md')).toBe(true));

      // An unrelated write: nothing to do.
      fs.writeFileSync(path.join(project, '.git', 'info', 'exclude'), '# mine\n.clubhouse/\n');
      const before = listAgents.mock.calls.length;
      for (const fn of listeners) fn(project);
      await vi.waitFor(() => expect(listAgents.mock.calls.length).toBeGreaterThan(before));
      await new Promise((r) => setTimeout(r, 100));
      expect(ignored(project, 'CLAUDE.md')).toBe(false);

      // Unmanaged: its root files come out.
      fs.writeFileSync(path.join(project, '.git', 'info', 'exclude'), '# mine\n.clubhouse/\n# >>> clubhouse-managed-claude-code\n/CLAUDE.md\n# <<< clubhouse-managed-claude-code\n');
      delete one.managed;
      for (const fn of listeners) fn(project);
      await vi.waitFor(() => expect(ignored(project, 'CLAUDE.md')).toBe(false));
    } finally {
      stop();
    }
  });
});
