import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../../shared/types';
import { CLUBHOUSE_MCP_PART_ID } from '../../../shared/managed-agents-types';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));

import { createAssetCatalogStore } from '../asset-catalog/store';
import { withSettingsSurface, _resetSettingsAuditForTesting } from '../settings-audit';
import { createManagedStateStore } from './state-store';
import { createManagedAgentsService, type ManagedAgentsService } from './service';
import { BUILTIN_BLOCK_IDS } from './builtins';
import { appLog } from '../log-service';
import {
  deliverManagedSetup,
  EXCLUDES_MANIFEST,
  isSameFolder,
  parentInstructionFiles,
  previewManagedSetup,
  quickManagedLaunch,
  removeManagedClaudeExcludes,
  resolveManagedMcpServers,
} from './delivery';
import type { OrchestratorProvider } from '../../orchestrators/types';

const user = <T>(fn: () => T) => withSettingsSurface('ui', undefined, fn);

let root: string;
let project: string;
let service: ManagedAgentsService;
let catalog: ReturnType<typeof createAssetCatalogStore>;
let agent: DurableAgentConfig;

function provider(conv: Partial<OrchestratorProvider['conventions']> = {}, id = 'claude-code'): OrchestratorProvider {
  const conventions = { configDir: '.claude', skillsDir: 'skills', mcpConfigFile: '.mcp.json', legacyInstructionsFile: 'CLAUDE.md', settingsFormat: 'json', ...conv };
  return {
    id,
    displayName: id === 'claude-code' ? 'Claude Code' : 'GitHub Copilot CLI',
    conventions,
    writeInstructions: async (wt: string, content: string) => { fs.writeFileSync(path.join(wt, conventions.legacyInstructionsFile as string), content); },
  } as unknown as OrchestratorProvider;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-delivery-'));
  project = path.join(root, 'project');
  const wt = path.join(project, '.clubhouse', 'agents', 'cool-gazelle');
  fs.mkdirSync(wt, { recursive: true });
  _resetSettingsAuditForTesting(false);
  catalog = createAssetCatalogStore({ dir: path.join(root, 'catalog') });
  service = createManagedAgentsService({
    catalog,
    state: createManagedStateStore(path.join(root, 'managed')),
    listProjects: async () => [],
    listAgents: async () => [],
    getAgent: async () => agent,
    setManagedSetup: async () => {},
    isRunning: () => false,
  });
  await service.ensureBuiltins();
  agent = { id: 'a1', name: 'cool-gazelle', color: 'indigo', createdAt: '2026-11-07T00:00:00.000Z', worktreePath: wt, branch: 'cool-gazelle/standby' };
});

describe('deliverManagedSetup', () => {
  it('writes exactly the blocks in order with wildcards filled, and nothing else', async () => {
    const rules = await user(() => service.createPart({ name: 'Rules', content: { kind: 'block', content: 'Work on @@StandbyBranch.' } }));
    agent.managed = { version: 1, blocks: [BUILTIN_BLOCK_IDS.identity, rules.id], skills: [], mcps: [] };
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    const text = fs.readFileSync(path.join(agent.worktreePath!, 'CLAUDE.md'), 'utf-8');
    expect(text.startsWith('You are cool-gazelle, an agent working in Clubhouse.')).toBe(true);
    expect(text.endsWith('\n\nWork on cool-gazelle/standby.')).toBe(true);
    expect(text).not.toContain('@@');
  });

  it('delivers conditional wildcards as written: a variant is its own block (#2901)', async () => {
    const rules = await user(() => service.createPart({ name: 'Variant', content: { kind: 'block', content: '@@If(nope)\nOnly sometimes.\n@@EndIf' } }));
    agent.managed = { version: 1, blocks: [rules.id], skills: [], mcps: [] };
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    const text = fs.readFileSync(path.join(agent.worktreePath!, 'CLAUDE.md'), 'utf-8');
    expect(text).toContain('@@If(nope)\nOnly sometimes.\n@@EndIf');
  });

  it('copies skills whole, including binary files, and removes a skill dropped from the setup', async () => {
    const a = await user(() => service.createPart({ name: 'Deploy', content: { kind: 'skill', skillName: 'deploy', files: [
      { path: 'SKILL.md', content: '# Deploy' },
      { path: 'scripts/run.sh', content: 'echo hi', executable: true },
      { path: 'assets/logo.bin', content: 'AAH+/w==', encoding: 'base64' },
    ] } }));
    const b = await user(() => service.createPart({ name: 'Notes', content: { kind: 'skill', skillName: 'notes', files: [{ path: 'SKILL.md', content: '# Notes' }] } }));
    agent.managed = { version: 1, blocks: [], skills: [a.id, b.id], mcps: [] };
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    const skills = path.join(agent.worktreePath!, '.claude', 'skills');
    expect(fs.readFileSync(path.join(skills, 'deploy', 'assets', 'logo.bin'))).toEqual(Buffer.from('AAH+/w==', 'base64'));
    if (process.platform !== 'win32') expect(fs.statSync(path.join(skills, 'deploy', 'scripts', 'run.sh')).mode & 0o111).not.toBe(0);
    fs.mkdirSync(path.join(skills, 'mine'));
    agent.managed = { version: 1, blocks: [], skills: [a.id], mcps: [] };
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    expect(fs.existsSync(path.join(skills, 'notes'))).toBe(false);
    // Without a place to move it, a folder Clubhouse didn't write is left alone.
    expect(fs.existsSync(path.join(skills, 'mine'))).toBe(true);
  });

  it('moves a skill folder Clubhouse did not write out of the way instead of deleting it', async () => {
    const skill = await user(() => service.createPart({ name: 'Review', content: { kind: 'skill', skillName: 'review', files: [{ path: 'SKILL.md', content: '# managed' }] } }));
    const mine = path.join(agent.worktreePath!, '.claude', 'skills', 'review');
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, 'SKILL.md'), '# mine');
    agent.managed = { version: 1, blocks: [], skills: [skill.id], mcps: [] };
    const backupRoot = path.join(root, 'backup');
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider(), backupRoot }));
    expect(fs.readFileSync(path.join(mine, 'SKILL.md'), 'utf-8')).toBe('# managed');
    const [saved] = fs.readdirSync(backupRoot);
    expect(fs.readFileSync(path.join(backupRoot, saved, 'SKILL.md'), 'utf-8')).toBe('# mine');
    // Without a place to put it, delivery refuses rather than delete it.
    fs.rmSync(path.join(agent.worktreePath!, '.claude', 'skills', '.clubhouse-managed-skills.json'));
    await expect(user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }))).rejects.toThrow(/in the way/);
  });

  it('writes MCP servers to the JSON file without the Clubhouse part, and none for TOML CLIs', async () => {
    const mcp = await user(() => service.createPart({ name: 'WorkIQ', content: { kind: 'mcp', serverKey: 'workiq', transport: 'stdio', command: 'npx', args: ['-y', 'workiq-mcp'], envVars: ['WORKIQ_TENANT'] } }));
    agent.managed = { version: 1, blocks: [], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID, mcp.id] };
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    const json = JSON.parse(fs.readFileSync(path.join(agent.worktreePath!, '.mcp.json'), 'utf-8'));
    expect(json).toEqual({ mcpServers: { workiq: { command: 'npx', args: ['-y', 'workiq-mcp'], env_vars: ['WORKIQ_TENANT'] } } });
    expect(await user(() => resolveManagedMcpServers(service, agent))).toEqual(json.mcpServers);
    fs.rmSync(path.join(agent.worktreePath!, '.mcp.json'));
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider({ settingsFormat: 'toml', mcpConfigFile: '.codex/config.toml' }) }));
    expect(fs.existsSync(path.join(agent.worktreePath!, '.codex', 'config.toml'))).toBe(false);
  });

  it('fingerprints change when a part is edited, so a running agent knows it is behind', async () => {
    const rules = await user(() => service.createPart({ name: 'Rules', content: { kind: 'block', content: 'one' } }));
    agent.managed = { version: 1, blocks: [rules.id], skills: [], mcps: [] };
    const first = await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    await user(() => service.updatePart({ id: rules.id, expectedRevision: rules.revision, content: { kind: 'block', content: 'two' } }));
    const second = await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    expect(first!.fingerprint).not.toBe(second!.fingerprint);
  });

  it('skips a part that no longer exists instead of failing the start', async () => {
    agent.managed = { version: 1, blocks: [BUILTIN_BLOCK_IDS.identity, 'gone'], skills: [], mcps: [] };
    const record = await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    expect(Object.keys(record!.parts)).toEqual([BUILTIN_BLOCK_IDS.identity]);
    expect(record!.missing).toBe(1);
  });
});

describe('previewManagedSetup', () => {
  it('matches what delivery writes, with line ranges per block', async () => {
    const rules = await user(() => service.createPart({ name: 'Rules', content: { kind: 'block', content: 'a\nb' } }));
    agent.managed = { version: 1, blocks: [BUILTIN_BLOCK_IDS.identity, rules.id], skills: [], mcps: [] };
    const preview = await user(() => previewManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    expect(preview.instructions).toBe(fs.readFileSync(path.join(agent.worktreePath!, 'CLAUDE.md'), 'utf-8'));
    expect(preview.blocks.map((b) => [b.name, b.startLine, b.endLine])).toEqual([['Identity', 1, 2], ['Rules', 4, 5]]);
  });
});

describe('quickManagedLaunch (D25)', () => {
  const listing = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

  it('renders the template for the quick agent in its folder and writes nothing', async () => {
    const mcp = await user(() => service.createPart({ name: 'WorkIQ', content: { kind: 'mcp', serverKey: 'workiq', transport: 'stdio', command: 'npx', envVars: ['WORKIQ_TENANT'] } }));
    const skill = await user(() => service.createPart({ name: 'Notes', content: { kind: 'skill', skillName: 'notes', files: [{ path: 'SKILL.md', content: '# Notes' }] } }));
    const template = await user(() => service.saveTemplate({
      name: 'Release', description: '', settings: {},
      setup: { blocks: [BUILTIN_BLOCK_IDS.identity], skills: [skill.id], mcps: [CLUBHOUSE_MCP_PART_ID, mcp.id] },
    }));
    const before = listing(project);
    const launch = await user(() => quickManagedLaunch({
      service, projectPath: project, cwd: project, agentId: 'quick_1', agentName: 'swift-otter', templateId: template.id, branch: 'main',
    }));
    expect(launch.instructions).toBe('You are swift-otter, an agent working in Clubhouse.\nYour workspace is ./ and your branch is main.');
    expect(launch.servers).toEqual({ workiq: { command: 'npx', env_vars: ['WORKIQ_TENANT'] } });
    expect(launch).toMatchObject({ templateId: template.id, bridge: true, skippedSkills: 1, missing: 0 });
    expect(listing(project)).toEqual(before);
  });

  it('names a durable agent\'s worktree relative to the project, and says so when there is no branch', async () => {
    const launch = await user(() => quickManagedLaunch({
      service, projectPath: project, cwd: agent.worktreePath!, agentId: 'quick_2', agentName: 'calm-heron', templateId: 'builtin-template-researcher',
    }));
    expect(launch.instructions.split('\n')[1]).toBe('Your workspace is .clubhouse/agents/cool-gazelle/ and your branch is the checked-out branch.');
    expect(launch.bridge).toBe(true);
    expect(launch.servers).toEqual({});
  });

  it('reports no bridge for a template without the Clubhouse MCP part', async () => {
    const template = await user(() => service.saveTemplate({ name: 'Plain', description: '', settings: {}, setup: { blocks: [], skills: [], mcps: [] } }));
    const launch = await user(() => quickManagedLaunch({ service, projectPath: project, cwd: project, agentId: 'q', agentName: 'q', templateId: template.id }));
    expect(launch).toMatchObject({ bridge: false, instructions: '' });
  });

  it('counts the parts the template names that no longer exist', async () => {
    const keep = await user(() => service.createPart({ name: 'Keep', content: { kind: 'block', content: 'kept' } }));
    const gone = await user(() => service.createPart({ name: 'Gone', content: { kind: 'block', content: 'gone' } }));
    const goneSkill = await user(() => service.createPart({ name: 'Old', content: { kind: 'skill', skillName: 'old', files: [{ path: 'SKILL.md', content: '# Old' }] } }));
    const template = await user(() => service.saveTemplate({ name: 'Stale', description: '', settings: {}, setup: { blocks: [keep.id, gone.id], skills: [goneSkill.id], mcps: [] } }));
    // Gone from the catalog behind the service's back, so the template still names them.
    await catalog.deleteAsset({ assetId: gone.id, expectedRevision: gone.revision });
    await catalog.deleteAsset({ assetId: goneSkill.id, expectedRevision: goneSkill.revision });
    const launch = await user(() => quickManagedLaunch({ service, projectPath: project, cwd: project, agentId: 'q', agentName: 'q', templateId: template.id }));
    expect(launch).toMatchObject({ instructions: 'kept', skippedSkills: 0, missing: 2 });
  });

  it('refuses a template that doesn\'t exist', async () => {
    await expect(user(() => quickManagedLaunch({ service, projectPath: project, cwd: project, agentId: 'q', agentName: 'q', templateId: 'nope' }))).rejects.toThrow();
  });
});

describe('quickLaunchFor (D25)', () => {
  it('keeps the servers for a CLI with launch flags and drops them, logged, for one without', async () => {
    const { quickLaunchFor, _setManagedAgentsForTesting } = await import('./index');
    const { appLog } = await import('../log-service');
    _setManagedAgentsForTesting(service);
    try {
      const mcp = await user(() => service.createPart({ name: 'WorkIQ', content: { kind: 'mcp', serverKey: 'workiq', transport: 'stdio', command: 'npx' } }));
      const template = await user(() => service.saveTemplate({ name: 'Reader', description: '', settings: {}, setup: { blocks: [], skills: [], mcps: [mcp.id] } }));
      const flags = { ...provider(), id: 'codex-cli', buildMcpArgs: () => [] } as unknown as OrchestratorProvider;
      const withFlags = await user(() => quickLaunchFor(project, project, 'q1', { id: template.id, agentName: 'q' }, flags));
      expect(Object.keys(withFlags.servers)).toEqual(['workiq']);
      vi.mocked(appLog).mockClear();
      const without = await user(() => quickLaunchFor(project, project, 'q2', { id: template.id, agentName: 'q' }, provider()));
      expect(without.servers).toEqual({});
      expect(appLog).toHaveBeenCalledWith('core:managed', 'warn', expect.stringContaining('not delivered'), expect.objectContaining({ meta: expect.objectContaining({ mcpServers: 1 }) }));
    } finally {
      _setManagedAgentsForTesting(null);
    }
  });
});

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('exactly its parts (#2819)', () => {
  it('moves every untracked skill folder the setup does not list to app data, and leaves tracked ones for Preview (D48)', async () => {
    const wt = agent.worktreePath!;
    const skills = path.join(wt, '.claude', 'skills');
    git(wt, 'init', '-q');
    fs.mkdirSync(path.join(skills, 'repo-skill'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'repo-skill', 'SKILL.md'), '# tracked');
    git(wt, 'add', '.claude/skills/repo-skill/SKILL.md');
    fs.mkdirSync(path.join(skills, 'stray'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'stray', 'SKILL.md'), '# stray');
    const mine = await user(() => service.createPart({ name: 'Mine', content: { kind: 'skill', skillName: 'mine', files: [{ path: 'SKILL.md', content: '# mine' }] } }));
    agent.managed = { version: 1, blocks: [], skills: [mine.id], mcps: [] };
    const backupRoot = path.join(root, 'backup');
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider(), backupRoot }));
    expect(fs.existsSync(path.join(skills, 'stray'))).toBe(false);
    const [moved] = fs.readdirSync(backupRoot);
    expect(moved.startsWith('stray-')).toBe(true);
    expect(fs.readFileSync(path.join(backupRoot, moved, 'SKILL.md'), 'utf-8')).toBe('# stray');
    expect(fs.readFileSync(path.join(skills, 'repo-skill', 'SKILL.md'), 'utf-8')).toBe('# tracked');
    const preview = await user(() => previewManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    expect(preview.repoSkills).toEqual(['.claude/skills/repo-skill']);
  });

  it('never delivers literal env values, even from a part stored with them (D46)', async () => {
    const catalog = createAssetCatalogStore({ dir: path.join(root, 'catalog') });
    const old = await user(() => catalog.createAsset({ kind: 'mcp', name: 'Old', payload: { serverKey: 'old', transport: 'stdio', command: 'old', env: { MODE: 'fast' } } }));
    agent.managed = { version: 1, blocks: [], skills: [], mcps: [old.id] };
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    const json = JSON.parse(fs.readFileSync(path.join(agent.worktreePath!, '.mcp.json'), 'utf-8'));
    expect(json).toEqual({ mcpServers: { old: { command: 'old', env_vars: ['MODE'] } } });
  });

  it('says which stored env values are no longer used, in Preview and once in the log, by name only (D46)', async () => {
    const catalog = createAssetCatalogStore({ dir: path.join(root, 'catalog') });
    const old = await user(() => catalog.createAsset({ kind: 'mcp', name: 'Old', payload: { serverKey: 'old', transport: 'stdio', command: 'old', env: { MODE: 'fast-secretish' } } }));
    const clean = await user(() => service.createPart({ name: 'Clean', content: { kind: 'mcp', serverKey: 'clean', transport: 'stdio', command: 'c', envVars: ['REGION'] } }));
    agent.managed = { version: 1, blocks: [], skills: [], mcps: [old.id, clean.id] };
    vi.mocked(appLog).mockClear();
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    const logged = vi.mocked(appLog).mock.calls.filter(([, , msg]) => /no longer uses/.test(String(msg)));
    expect(logged).toHaveLength(1);
    expect(logged[0][3]).toEqual({ meta: { agentId: 'a1', names: ['MODE'] } });
    expect(JSON.stringify(vi.mocked(appLog).mock.calls)).not.toContain('fast-secretish');
    const preview = await user(() => previewManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    expect(preview.mcps.find((m) => m.id === old.id)!.droppedEnvValues).toEqual(['MODE']);
    expect(preview.mcps.find((m) => m.id === clean.id)!.droppedEnvValues).toBeUndefined();
    expect(JSON.stringify(preview)).not.toContain('fast-secretish');
  });

  it('tells Claude Code not to read CLAUDE.md files above the worktree, keeping the local settings it has (D49)', async () => {
    const wt = agent.worktreePath!;
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# project');
    fs.writeFileSync(path.join(project, '.clubhouse', 'CLAUDE.local.md'), '# local');
    fs.mkdirSync(path.join(project, '.claude', 'rules'), { recursive: true });
    const settings = path.join(wt, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ hooks: { Stop: [] }, claudeMdExcludes: ['/elsewhere/CLAUDE.md'] }));
    agent.managed = { version: 1, blocks: [BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [] };
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    const written = JSON.parse(fs.readFileSync(settings, 'utf-8'));
    expect(written.hooks).toEqual({ Stop: [] });
    expect(written.claudeMdExcludes[0]).toBe('/elsewhere/CLAUDE.md');
    const fwd = (p: string) => p.replace(/\\/g, '/');
    expect(written.claudeMdExcludes).toContain(fwd(path.join(project, 'CLAUDE.md')));
    expect(written.claudeMdExcludes).toContain(fwd(path.join(project, '.clubhouse', 'CLAUDE.local.md')));
    expect(written.claudeMdExcludes).toContain(`${fwd(path.join(project, '.claude', 'rules'))}/**`);
    // A second start adds nothing twice.
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    expect(JSON.parse(fs.readFileSync(settings, 'utf-8')).claudeMdExcludes).toEqual(written.claudeMdExcludes);
    const preview = await user(() => previewManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    expect(preview.notRead).toEqual(expect.arrayContaining(['CLAUDE.md', '.clubhouse/CLAUDE.local.md', '.claude/rules/']));
    expect(preview.alsoRead).toBeUndefined();
  });

  it('leaves a local settings file it cannot read alone, and Preview says the parent files are read', async () => {
    const wt = agent.worktreePath!;
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# project');
    const settings = path.join(wt, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, '{ not json');
    agent.managed = { version: 1, blocks: [BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [] };
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    expect(fs.readFileSync(settings, 'utf-8')).toBe('{ not json');
    const preview = await user(() => previewManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    expect(preview.alsoRead).toContain('CLAUDE.md');
    expect(preview.cliName).toBe('Claude Code');
  });

  it('writes no local settings when nothing above the worktree would be read', async () => {
    expect((await parentInstructionFiles(agent.worktreePath!)).filter((f) => f.path.startsWith(root))).toEqual([]);
    agent.managed = { version: 1, blocks: [BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [] };
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    // Only when the machine has no CLAUDE.md above the temp folder; otherwise the file holds just those.
    const settings = path.join(agent.worktreePath!, '.claude', 'settings.local.json');
    if ((await parentInstructionFiles(agent.worktreePath!)).length === 0) expect(fs.existsSync(settings)).toBe(false);
  });

  it('lists the instruction files Copilot also reads that git tracks in the worktree (D50)', async () => {
    const wt = agent.worktreePath!;
    git(wt, 'init', '-q');
    fs.writeFileSync(path.join(wt, 'AGENTS.md'), '# agents');
    fs.writeFileSync(path.join(wt, 'CLAUDE.md'), '# claude');
    fs.mkdirSync(path.join(wt, '.claude', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.claude', 'rules', 'style.md'), '# style');
    git(wt, 'add', 'AGENTS.md', '.claude/rules/style.md');
    agent.managed = { version: 1, blocks: [], skills: [], mcps: [] };
    const copilot = provider({ configDir: '.github', mcpConfigFile: '.github/mcp.json', legacyInstructionsFile: 'copilot-instructions.md' }, 'copilot-cli');
    const preview = await user(() => previewManagedSetup({ service, projectPath: project, agent, provider: copilot }));
    expect(preview.alsoRead).toEqual(['.claude/rules/style.md', 'AGENTS.md']);
    expect(preview.notRead).toBeUndefined();
  });
});

/** A folder link that works without admin rights on Windows too. */
function linkDir(target: string, link: string) {
  fs.symlinkSync(target, link, 'junction');
}

describe('skill folders Clubhouse must not move (D48)', () => {
  const backupRoot = () => path.join(root, 'backup');
  const backedUp = () => (fs.existsSync(backupRoot()) ? fs.readdirSync(backupRoot()) : []);
  async function mineSkill() {
    const mine = await user(() => service.createPart({ name: 'Mine', content: { kind: 'skill', skillName: 'mine', files: [{ path: 'SKILL.md', content: '# mine' }] } }));
    agent.managed = { version: 1, blocks: [], skills: [mine.id], mcps: [] };
  }

  it('moves nothing when the skills folder is a link to somewhere outside, and Preview lists the folders', async () => {
    const outside = path.join(root, 'shared-skills');
    fs.mkdirSync(path.join(outside, 'theirs'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'theirs', 'SKILL.md'), '# theirs');
    fs.mkdirSync(path.join(agent.worktreePath!, '.claude'), { recursive: true });
    linkDir(outside, path.join(agent.worktreePath!, '.claude', 'skills'));
    await mineSkill();
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider(), backupRoot: backupRoot() }));
    expect(fs.readFileSync(path.join(outside, 'theirs', 'SKILL.md'), 'utf-8')).toBe('# theirs');
    expect(backedUp()).toEqual([]);
    const preview = await user(() => previewManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    expect(preview.keptSkills).toEqual(['.claude/skills/theirs']);
    expect(preview.keptSkillsReason).toBe('link');
    expect(preview.repoSkills).toBeUndefined();
  });

  it('moves nothing when .claude itself is a link, and refuses to move a clashing folder out of it', async () => {
    const outside = path.join(root, 'shared-claude');
    fs.mkdirSync(path.join(outside, 'skills', 'theirs'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'skills', 'theirs', 'SKILL.md'), '# theirs');
    linkDir(outside, path.join(agent.worktreePath!, '.claude'));
    await mineSkill();
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider(), backupRoot: backupRoot() }));
    expect(fs.readFileSync(path.join(outside, 'skills', 'theirs', 'SKILL.md'), 'utf-8')).toBe('# theirs');
    expect(backedUp()).toEqual([]);
    const preview = await user(() => previewManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    expect(preview.keptSkills).toEqual(['.claude/skills/theirs']);
    // A folder in the way of a managed skill isn't moved out of a linked folder either.
    const clash = await user(() => service.createPart({ name: 'Theirs', content: { kind: 'skill', skillName: 'theirs', files: [{ path: 'SKILL.md', content: '# managed' }] } }));
    agent.managed = { version: 1, blocks: [], skills: [clash.id], mcps: [] };
    await expect(user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider(), backupRoot: backupRoot() }))).rejects.toThrow(/link/);
    expect(fs.readFileSync(path.join(outside, 'skills', 'theirs', 'SKILL.md'), 'utf-8')).toBe('# theirs');
  });

  it('treats a submodule folder as tracked: git lists it with no trailing slash', async () => {
    const wt = agent.worktreePath!;
    git(wt, 'init', '-q');
    fs.mkdirSync(path.join(wt, '.claude', 'skills', 'vendored'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.claude', 'skills', 'vendored', 'SKILL.md'), '# vendored');
    // A gitlink entry, as `git submodule add` records it.
    git(wt, 'update-index', '--add', '--cacheinfo', '160000,0123456789abcdef0123456789abcdef01234567,.claude/skills/vendored');
    await mineSkill();
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider(), backupRoot: backupRoot() }));
    expect(fs.existsSync(path.join(wt, '.claude', 'skills', 'vendored', 'SKILL.md'))).toBe(true);
    expect(backedUp()).toEqual([]);
    const preview = await user(() => previewManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    expect(preview.repoSkills).toEqual(['.claude/skills/vendored']);
  });

  it('moves nothing when git fails for a reason other than "not a git repository", logging the code only', async () => {
    const wt = agent.worktreePath!;
    fs.writeFileSync(path.join(wt, '.git'), 'not a gitfile');
    fs.mkdirSync(path.join(wt, '.claude', 'skills', 'maybe-tracked'), { recursive: true });
    await mineSkill();
    vi.mocked(appLog).mockClear();
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider(), backupRoot: backupRoot() }));
    expect(fs.existsSync(path.join(wt, '.claude', 'skills', 'maybe-tracked'))).toBe(true);
    expect(backedUp()).toEqual([]);
    const warned = vi.mocked(appLog).mock.calls.find(([, level, msg]) => level === 'warn' && /git could not list/.test(String(msg)));
    expect(warned?.[3]).toEqual({ meta: { code: '128' } });
    const preview = await user(() => previewManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    expect(preview.keptSkills).toEqual(['.claude/skills/maybe-tracked']);
    expect(preview.keptSkillsReason).toBe('git');
  });

  it('moves nothing when git is missing', async () => {
    fs.mkdirSync(path.join(agent.worktreePath!, '.claude', 'skills', 'maybe-tracked'), { recursive: true });
    await mineSkill();
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    try {
      await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider(), backupRoot: backupRoot() }));
    } finally {
      process.env.PATH = savedPath;
    }
    expect(fs.existsSync(path.join(agent.worktreePath!, '.claude', 'skills', 'maybe-tracked'))).toBe(true);
    expect(backedUp()).toEqual([]);
  });

  it('still moves untracked folders out when the agent folder is not a git checkout', async () => {
    fs.mkdirSync(path.join(agent.worktreePath!, '.claude', 'skills', 'stray'), { recursive: true });
    await mineSkill();
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider(), backupRoot: backupRoot() }));
    expect(fs.existsSync(path.join(agent.worktreePath!, '.claude', 'skills', 'stray'))).toBe(false);
    expect(backedUp().some((n) => n.startsWith('stray-'))).toBe(true);
  });
});

describe('the claudeMdExcludes entries Clubhouse adds (D49)', () => {
  const fwd = (p: string) => p.replace(/\\/g, '/');
  const settingsFile = () => path.join(agent.worktreePath!, '.claude', 'settings.local.json');
  const readSettings = () => JSON.parse(fs.readFileSync(settingsFile(), 'utf-8'));
  const manifestFile = () => path.join(agent.worktreePath!, EXCLUDES_MANIFEST);
  const deliver = (p = provider()) => user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: p }));
  /** Clubhouse's entries inside this test's folder; the machine may have CLAUDE.md files above it too. */
  const ours = (entries: string[]) => entries.filter((e) => e.startsWith(fwd(root)));

  beforeEach(() => {
    agent.managed = { version: 1, blocks: [BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [] };
  });

  it('replaces exactly the entries it added at each start and never touches the person\'s', async () => {
    const projectMd = fwd(path.join(project, 'CLAUDE.md'));
    const localMd = fwd(path.join(project, '.clubhouse', 'CLAUDE.local.md'));
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# project');
    fs.writeFileSync(path.join(project, '.clubhouse', 'CLAUDE.local.md'), '# local');
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    // The person excluded the project CLAUDE.md themselves before Clubhouse did.
    fs.writeFileSync(settingsFile(), JSON.stringify({ hooks: { Stop: [] }, claudeMdExcludes: ['/elsewhere/CLAUDE.md', projectMd] }));
    await deliver();
    expect(ours(readSettings().claudeMdExcludes)).toEqual([projectMd, localMd]);
    const manifest = JSON.parse(fs.readFileSync(manifestFile(), 'utf-8'));
    expect(manifest.settingsFile).toBe('.claude/settings.local.json');
    expect(ours(manifest.entries)).toEqual([localMd]);
    // The local file goes away: its entry comes out at the next start, the person's stay.
    fs.rmSync(path.join(project, '.clubhouse', 'CLAUDE.local.md'));
    await deliver();
    expect(readSettings().claudeMdExcludes.slice(0, 2)).toEqual(['/elsewhere/CLAUDE.md', projectMd]);
    expect(ours(readSettings().claudeMdExcludes)).toEqual([projectMd]);
    expect(readSettings().hooks).toEqual({ Stop: [] });
  });

  it('removes its entries and the manifest on unmanage, keeping the rest of the settings', async () => {
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# project');
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({ hooks: { Stop: [] }, claudeMdExcludes: ['/elsewhere/CLAUDE.md'] }));
    await deliver();
    expect(ours(readSettings().claudeMdExcludes)).toContain(fwd(path.join(project, 'CLAUDE.md')));
    await removeManagedClaudeExcludes(agent.worktreePath!);
    expect(readSettings()).toEqual({ hooks: { Stop: [] }, claudeMdExcludes: ['/elsewhere/CLAUDE.md'] });
    expect(fs.existsSync(manifestFile())).toBe(false);
  });

  it('removes a settings file it created once nothing else is in it', async () => {
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# project');
    await deliver();
    expect(fs.existsSync(settingsFile())).toBe(true);
    await removeManagedClaudeExcludes(agent.worktreePath!);
    expect(fs.existsSync(settingsFile())).toBe(false);
    expect(fs.existsSync(manifestFile())).toBe(false);
  });

  it('keeps a settings file it created once the person adds to it', async () => {
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# project');
    await deliver();
    fs.writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), model: 'opus' }));
    await removeManagedClaudeExcludes(agent.worktreePath!);
    expect(readSettings()).toEqual({ model: 'opus' });
  });

  it('takes its entries out when the agent starts on a CLI that does not read them', async () => {
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# project');
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({ claudeMdExcludes: ['/elsewhere/CLAUDE.md'] }));
    await deliver();
    await deliver(provider({ configDir: '.github', mcpConfigFile: '.github/mcp.json', legacyInstructionsFile: 'copilot-instructions.md' }, 'copilot-cli'));
    expect(readSettings()).toEqual({ claudeMdExcludes: ['/elsewhere/CLAUDE.md'] });
    expect(fs.existsSync(manifestFile())).toBe(false);
  });

  it('leaves an unreadable settings file and its manifest alone on unmanage', async () => {
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# project');
    await deliver();
    fs.writeFileSync(settingsFile(), '{ broken');
    await removeManagedClaudeExcludes(agent.worktreePath!);
    expect(fs.readFileSync(settingsFile(), 'utf-8')).toBe('{ broken');
    expect(fs.existsSync(manifestFile())).toBe(true);
  });
});

describe('isSameFolder', () => {
  it('compares folders after resolving links', async () => {
    const real = path.join(root, 'home-real');
    const link = path.join(root, 'home-link');
    fs.mkdirSync(real);
    linkDir(real, link);
    expect(await isSameFolder(link, real)).toBe(true);
    expect(await isSameFolder(path.join(real, '.'), real)).toBe(true);
    expect(await isSameFolder(real, project)).toBe(false);
  });

  it('ignores case only on Windows', async () => {
    const a = path.join(root, 'Missing', 'Home');
    const b = path.join(root, 'missing', 'home');
    expect(await isSameFolder(a, b, 'win32')).toBe(true);
    expect(await isSameFolder(a, b, 'linux')).toBe(false);
  });
});
