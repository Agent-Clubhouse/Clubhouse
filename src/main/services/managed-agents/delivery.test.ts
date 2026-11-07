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
import { deliverManagedSetup, parentInstructionFiles, previewManagedSetup, quickManagedLaunch, resolveManagedMcpServers } from './delivery';
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
