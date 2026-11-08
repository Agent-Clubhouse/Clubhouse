import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../../shared/types';
import { CLUBHOUSE_MCP_PART_ID, isListed } from '../../../shared/managed-agents-types';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));

import { createAssetCatalogStore } from '../asset-catalog/store';
import { withSettingsSurface, _resetSettingsAuditForTesting } from '../settings-audit';
import { createManagedStateStore } from './state-store';
import { createManagedAgentsService, type ManagedAgentsService } from './service';
import { BUILTIN_BLOCK_IDS, BUILTIN_SKILL_IDS, builtinParts, builtinTemplates } from './builtins';
import { BUILTIN_SKILL_TEXT } from './builtin-text/index';
import { appLog } from '../log-service';
import {
  deliverManagedSetup,
  EXCLUDES_MANIFEST,
  isSameFolder,
  parentInstructionFiles,
  previewManagedSetup,
  rootFileExcludes,
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

  it('every built-in template that is offered composes with no @@If and only wildcards delivery fills (#2902)', async () => {
    const text = new Map(builtinParts().map((p) => [p.id, 'content' in p.payload ? p.payload.content : '']));
    const offered = builtinTemplates().filter(isListed);
    expect(offered.length).toBeGreaterThan(0);
    for (const t of offered) {
      const raw = t.setup.blocks.map((id) => text.get(id)!).join('\n\n');
      expect(raw, t.id).not.toMatch(/@@(If|EndIf)\b/);
      const { setup } = await user(() => service.setupFromTemplate(t.id));
      expect(setup.blocks, t.id).toEqual(t.setup.blocks);
      agent.managed = setup;
      await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
      const delivered = fs.readFileSync(path.join(agent.worktreePath!, 'CLAUDE.md'), 'utf-8');
      expect(delivered.startsWith('You are cool-gazelle, an agent working in Clubhouse.'), t.id).toBe(true);
      // Every wildcard was one delivery fills: none is left as written.
      expect(delivered, t.id).not.toMatch(/@@\w/);
    }
  });

  it('writes the built-in build, test, lint and validate skill folders for a Developer agent (#2902)', async () => {
    const { setup } = await user(() => service.setupFromTemplate('builtin-template-developer-no-merge'));
    expect(setup.skills).toEqual([BUILTIN_SKILL_IDS.build, BUILTIN_SKILL_IDS.test, BUILTIN_SKILL_IDS.lint, BUILTIN_SKILL_IDS.validate]);
    agent.managed = setup;
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    const skills = path.join(agent.worktreePath!, '.claude', 'skills');
    expect(fs.readdirSync(skills).filter((f) => !f.startsWith('.')).sort()).toEqual(['build', 'lint', 'test', 'validate']);
    for (const name of ['build', 'lint', 'test', 'validate']) {
      expect(fs.readFileSync(path.join(skills, name, 'SKILL.md'), 'utf-8'), name).toBe(BUILTIN_SKILL_TEXT[`skills/${name}/SKILL.md`]);
    }
    expect(JSON.parse(fs.readFileSync(path.join(skills, '.clubhouse-managed-skills.json'), 'utf-8'))).toEqual({ skills: ['build', 'test', 'lint', 'validate'] });
    const preview = await user(() => previewManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    expect(preview.skills.map((sk) => sk.folder)).toEqual(['.claude/skills/build', '.claude/skills/test', '.claude/skills/lint', '.claude/skills/validate']);
  });

  it('leaves @@SourceControlProvider and the build, test and lint wildcards as written, in delivery and Preview (#2902)', async () => {
    const tokens = 'Host: @@SourceControlProvider\nBuild: @@BuildCommand\nTest: @@TestCommand\nLint: @@LintCommand\nName: @@AgentName at @@Path on @@StandbyBranch';
    const rules = await user(() => service.createPart({ name: 'Commands', content: { kind: 'block', content: tokens } }));
    agent.managed = { version: 1, blocks: [rules.id], skills: [], mcps: [] };
    agent.buildCommand = 'make';
    agent.sourceControlProvider = 'azure-devops';
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    const text = fs.readFileSync(path.join(agent.worktreePath!, 'CLAUDE.md'), 'utf-8');
    expect(text).toBe('Host: @@SourceControlProvider\nBuild: @@BuildCommand\nTest: @@TestCommand\nLint: @@LintCommand\nName: cool-gazelle at .clubhouse/agents/cool-gazelle/ on cool-gazelle/standby');
    const preview = await user(() => previewManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    expect(preview.instructions).toBe(text);
    const template = await user(() => service.saveTemplate({ name: 'Commands', description: '', settings: {}, setup: { blocks: [rules.id], skills: [], mcps: [] } }));
    const launch = await user(() => quickManagedLaunch({ service, projectPath: project, cwd: project, agentId: 'q', agentName: 'q', templateId: template.id, branch: 'main' }));
    expect(launch.instructions.split('\n').slice(0, 4)).toEqual(['Host: @@SourceControlProvider', 'Build: @@BuildCommand', 'Test: @@TestCommand', 'Lint: @@LintCommand']);
  });

  it('delivers conditional wildcards as written: a variant is its own block (#2901)', async () => {
    const rules = await user(() => service.createPart({ name: 'Variant', content: { kind: 'block', content: '@@If(nope)\nOnly sometimes.\n@@EndIf' } }));
    agent.managed = { version: 1, blocks: [rules.id], skills: [], mcps: [] };
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    const text = fs.readFileSync(path.join(agent.worktreePath!, 'CLAUDE.md'), 'utf-8');
    expect(text).toContain('@@If(nope)\nOnly sometimes.\n@@EndIf');
  });

  it('leaves @@Mission and @@Persona as written, and Preview shows the same bytes (D60)', async () => {
    const rules = await user(() => service.createPart({ name: 'Tokens', content: { kind: 'block', content: 'Mission: @@Mission\nPersona: @@Persona\nName: @@AgentName' } }));
    agent.managed = { version: 1, blocks: [rules.id], skills: [], mcps: [] };
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    const text = fs.readFileSync(path.join(agent.worktreePath!, 'CLAUDE.md'), 'utf-8');
    expect(text).toBe('Mission: @@Mission\nPersona: @@Persona\nName: cool-gazelle');
    const preview = await user(() => previewManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    expect(preview.instructions).toBe(text);
    expect(preview.blocks[0]).toMatchObject({ startLine: 1, endLine: 3 });
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

  it('writes Codex skills to .agents/skills and removes only the ones it delivered to .codex/skills before', async () => {
    const skill = await user(() => service.createPart({ name: 'Ship', content: { kind: 'skill', skillName: 'ship', files: [{ path: 'SKILL.md', content: '# Ship' }] } }));
    const wt = agent.worktreePath!;
    const old = path.join(wt, '.codex', 'skills');
    for (const name of ['ship', 'stale', 'mine']) {
      fs.mkdirSync(path.join(old, name), { recursive: true });
      fs.writeFileSync(path.join(old, name, 'SKILL.md'), `# ${name}`);
    }
    // What an earlier delivery to .codex/skills wrote; a bad entry is never followed.
    fs.writeFileSync(path.join(old, '.clubhouse-managed-skills.json'), JSON.stringify({ skills: ['ship', 'stale', '..', ''] }));
    const codex = provider({ configDir: '.codex', skillsRoot: '.agents/skills', previousSkillsRoots: ['.codex/skills'], settingsFormat: 'toml', mcpConfigFile: '.codex/config.toml', legacyInstructionsFile: 'AGENTS.md' }, 'codex-cli');
    agent.managed = { version: 1, blocks: [], skills: [skill.id], mcps: [] };
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: codex }));
    expect(fs.readFileSync(path.join(wt, '.agents', 'skills', 'ship', 'SKILL.md'), 'utf-8')).toBe('# Ship');
    expect(JSON.parse(fs.readFileSync(path.join(wt, '.agents', 'skills', '.clubhouse-managed-skills.json'), 'utf-8'))).toEqual({ skills: ['ship'] });
    expect(fs.readdirSync(old)).toEqual(['mine']);
    expect(fs.readFileSync(path.join(old, 'mine', 'SKILL.md'), 'utf-8')).toBe('# mine');
    const preview = await user(() => previewManagedSetup({ service, projectPath: project, agent, provider: codex }));
    expect(preview.skills.map((s) => s.folder)).toEqual(['.agents/skills/ship']);
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
    // The Clubhouse MCP part reads as in every setup, saved before it was required or not (D69).
    expect(Object.keys(record!.parts)).toEqual([BUILTIN_BLOCK_IDS.identity, CLUBHOUSE_MCP_PART_ID]);
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

  it('gives the text with wildcards as written for "Show wildcards", and a settings summary (#2895)', async () => {
    const rules = await user(() => service.createPart({ name: 'Rules', content: { kind: 'block', content: 'Work in @@Path on @@StandbyBranch.' } }));
    agent.managed = { version: 1, blocks: [rules.id], skills: [], mcps: [] };
    Object.assign(agent, { orchestrator: 'claude-code', model: 'opus', effort: 'high', freeAgentMode: true, orchestration: { orchestrate: true, maxHelpers: 3, autoHelpers: true } });
    const preview = await user(() => previewManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    expect(preview.instructions).toBe('Work in .clubhouse/agents/cool-gazelle/ on cool-gazelle/standby.');
    expect(preview.rawInstructions).toBe('Work in @@Path on @@StandbyBranch.');
    expect(preview.settings).toEqual([
      { key: 'cli', label: 'CLI', value: 'Claude Code' },
      { key: 'model', label: 'Model', value: 'opus' },
      { key: 'effort', label: 'Effort', value: 'high' },
      { key: 'freeAgentMode', label: 'Free Agent Mode', value: 'On' },
      { key: 'orchestration', label: 'Orchestration', value: 'Can start helpers' },
      { key: 'helpers', label: 'Helpers', value: 'Up to 3 at once, Smart selection, no approvals' },
      { key: 'helperTemplate', label: 'Helper template', value: 'Helper' },
      { key: 'dispatcher', label: 'Dispatcher', value: 'Connected' },
    ]);
  });

  it('renders an agent that doesn\'t exist yet as delivery will, once it has its folder (#2895)', async () => {
    const rules = await user(() => service.createPart({ name: 'Rules', content: { kind: 'block', content: 'I am @@AgentName in @@Path on @@StandbyBranch.' } }));
    const setup = { version: 1 as const, blocks: [BUILTIN_BLOCK_IDS.identity, rules.id], skills: [], mcps: [] };
    // The New agent builder's draft: no folder yet, the name typed.
    const draft: DurableAgentConfig = { id: 'new-agent', name: 'cool-gazelle', color: 'gray', createdAt: '2026-11-07T00:00:00.000Z' };
    const preview = await user(() => previewManagedSetup({ service, projectPath: project, agent: draft, provider: provider(), setup }));
    // The agent as created: its folder is .clubhouse/agents/<name>, its branch <name>/standby.
    agent.managed = setup;
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    expect(preview.instructions).toBe(fs.readFileSync(path.join(agent.worktreePath!, 'CLAUDE.md'), 'utf-8'));
  });
});

describe('what a running session started with (D9, #2895)', () => {
  it('keeps the delivered text, parts and settings in the record for "Running now"', async () => {
    const rules = await user(() => service.createPart({ name: 'Rules', content: { kind: 'block', content: 'Name: @@AgentName' } }));
    const notes = await user(() => service.createPart({ name: 'Notes', content: { kind: 'skill', skillName: 'notes', files: [{ path: 'SKILL.md', content: '# n' }] } }));
    agent.managed = { version: 1, blocks: [rules.id], skills: [notes.id], mcps: [] };
    agent.model = 'opus';
    const record = await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    expect(record!.snapshot).toMatchObject({
      instructions: 'Name: cool-gazelle',
      rawInstructions: 'Name: @@AgentName',
      skills: ['Notes'],
      mcps: ['Clubhouse'],
    });
    expect(record!.snapshot!.settings.find((r) => r.key === 'model')!.value).toBe('opus');
  });

  it('fingerprints the effort, which every launch passes', async () => {
    agent.managed = { version: 1, blocks: [BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [] };
    const first = await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    agent.effort = 'high';
    const second = await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    expect(first!.fingerprint).not.toBe(second!.fingerprint);
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
    expect(launch).toMatchObject({ templateId: template.id, skippedSkills: 1, missing: 0 });
    expect(launch).not.toHaveProperty('bridge');
    expect(listing(project)).toEqual(before);
  });

  it('gives a quick agent from a built-in template the working Identity, and skips its skills (#2902)', async () => {
    const launch = await user(() => quickManagedLaunch({
      service, projectPath: project, cwd: project, agentId: 'quick_3', agentName: 'brisk-wren', templateId: 'builtin-template-developer-no-merge', branch: 'fix/thing',
    }));
    expect(launch.instructions.startsWith('You are brisk-wren, an agent working in Clubhouse.\nYour workspace is ./ and your branch is fix/thing.\n\n')).toBe(true);
    // Not the durable Identity's standby-branch wording.
    expect(launch.instructions).not.toContain('standby branch');
    expect(launch).toMatchObject({ skippedSkills: 4, missing: 0 });
  });

  it('names a durable agent\'s worktree relative to the project, and says so when there is no branch', async () => {
    const launch = await user(() => quickManagedLaunch({
      service, projectPath: project, cwd: agent.worktreePath!, agentId: 'quick_2', agentName: 'calm-heron', templateId: 'builtin-template-researcher',
    }));
    expect(launch.instructions.split('\n')[1]).toBe('Your workspace is .clubhouse/agents/cool-gazelle/ and your branch is the checked-out branch.');
    expect(launch.servers).toEqual({});
  });

  it('gives a template saved without the Clubhouse part no extra server: the bridge is added at launch (D69)', async () => {
    const template = await user(() => service.saveTemplate({ name: 'Plain', description: '', settings: {}, setup: { blocks: [], skills: [], mcps: [] } }));
    const launch = await user(() => quickManagedLaunch({ service, projectPath: project, cwd: project, agentId: 'q', agentName: 'q', templateId: template.id }));
    expect(launch).toMatchObject({ instructions: '', servers: {}, missing: 0 });
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

describe('rootFileExcludes (D16, D97)', () => {
  /** Ignored by this repository's excludes only, not the machine's global ignore file. */
  function ignored(cwd: string, rel: string): boolean {
    try {
      execFileSync('git', ['-c', `core.excludesFile=${path.join(os.tmpdir(), 'no-global-ignore')}`, 'check-ignore', '-q', '--', rel], { cwd, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  const claude = () => provider({ localSettingsFile: 'settings.local.json' });

  it('anchors the instructions file, the MCP file and Claude Code\'s local settings to the root', async () => {
    const wt = agent.worktreePath!;
    git(wt, 'init', '-q');
    const patterns = await rootFileExcludes(wt, claude());
    expect(patterns).toEqual(['/CLAUDE.md', '/.mcp.json', '/.claude/settings.local.json']);
    fs.writeFileSync(path.join(wt, '.git', 'info', 'exclude'), `${patterns.join('\n')}\n`);
    expect(ignored(wt, 'CLAUDE.md')).toBe(true);
    expect(ignored(wt, '.mcp.json')).toBe(true);
    expect(ignored(wt, path.join('.claude', 'settings.local.json'))).toBe(true);
    // An untracked file of that name in a subfolder still shows.
    expect(ignored(wt, path.join('docs', 'CLAUDE.md'))).toBe(false);
    expect(ignored(wt, path.join('pkg', '.mcp.json'))).toBe(false);
  });

  it('uses Copilot\'s paths in its config folder, and has no local settings for it', async () => {
    const wt = agent.worktreePath!;
    git(wt, 'init', '-q');
    const copilot = provider({ configDir: '.github', legacyInstructionsFile: 'copilot-instructions.md', mcpConfigFile: '.github/mcp.json' }, 'copilot-cli');
    expect(await rootFileExcludes(wt, copilot)).toEqual(['/.github/copilot-instructions.md', '/.github/mcp.json']);
  });

  it('lists no MCP file for a TOML CLI, which gets its servers as launch flags', async () => {
    const wt = agent.worktreePath!;
    git(wt, 'init', '-q');
    const codex = provider({ configDir: '.codex', legacyInstructionsFile: 'AGENTS.md', mcpConfigFile: '.codex/config.toml', settingsFormat: 'toml' }, 'codex-cli');
    expect(await rootFileExcludes(wt, codex)).toEqual(['/AGENTS.md']);
  });

  it('leaves out a file the worktree tracks', async () => {
    const wt = agent.worktreePath!;
    git(wt, 'init', '-q');
    fs.writeFileSync(path.join(wt, 'CLAUDE.md'), '# theirs');
    git(wt, 'add', 'CLAUDE.md');
    expect(await rootFileExcludes(wt, claude())).toEqual(['/.mcp.json', '/.claude/settings.local.json']);
  });

  it('still lists them all outside a git checkout', async () => {
    expect(await rootFileExcludes(agent.worktreePath!, claude())).toEqual(['/CLAUDE.md', '/.mcp.json', '/.claude/settings.local.json']);
  });
});

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

  it('leaves a built-in skill folder git tracks to the project, and never writes, records or removes it (D74)', async () => {
    const wt = agent.worktreePath!;
    const skills = path.join(wt, '.claude', 'skills');
    git(wt, 'init', '-q');
    fs.mkdirSync(path.join(skills, 'build'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'build', 'SKILL.md'), '# ours');
    git(wt, 'add', '.claude/skills/build/SKILL.md');
    agent.managed = { version: 1, blocks: [], skills: [BUILTIN_SKILL_IDS.build, BUILTIN_SKILL_IDS.validate], mcps: [] };
    const backupRoot = path.join(root, 'backup');
    vi.mocked(appLog).mockClear();
    for (let start = 0; start < 2; start++) {
      await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider(), backupRoot }));
      expect(fs.readFileSync(path.join(skills, 'build', 'SKILL.md'), 'utf-8')).toBe('# ours');
      expect(fs.readFileSync(path.join(skills, 'validate', 'SKILL.md'), 'utf-8')).toBe(BUILTIN_SKILL_TEXT['skills/validate/SKILL.md']);
      expect(JSON.parse(fs.readFileSync(path.join(skills, '.clubhouse-managed-skills.json'), 'utf-8'))).toEqual({ skills: ['validate'] });
    }
    expect(fs.existsSync(backupRoot)).toBe(false);
    expect(appLog).toHaveBeenCalledWith('core:managed', 'info', "Using the project's own build skill; its built-in isn't delivered", { meta: { agentId: agent.id, folder: 'build' } });
    const preview = await user(() => previewManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    expect(preview.skills.find((sk) => sk.id === BUILTIN_SKILL_IDS.build)!.projectOwn).toBe("Using the project's own build skill");
    expect(preview.skills.find((sk) => sk.id === BUILTIN_SKILL_IDS.validate)!.projectOwn).toBeUndefined();
  });

  it('says the same in a New agent draft\'s Preview, from the project checkout its worktree comes from (#2895)', async () => {
    git(project, 'init', '-q');
    fs.mkdirSync(path.join(project, '.claude', 'skills', 'build'), { recursive: true });
    fs.writeFileSync(path.join(project, '.claude', 'skills', 'build', 'SKILL.md'), '# ours');
    git(project, 'add', '.claude/skills/build/SKILL.md');
    const draft: DurableAgentConfig = { id: 'new-agent', name: 'keen-heron', color: 'gray', createdAt: '2026-11-07T00:00:00.000Z' };
    const setup = { version: 1 as const, blocks: [], skills: [BUILTIN_SKILL_IDS.build, BUILTIN_SKILL_IDS.validate], mcps: [] };
    const preview = await user(() => previewManagedSetup({ service, projectPath: project, agent: draft, provider: provider(), setup, projectOwnFrom: project }));
    expect(preview.skills.find((sk) => sk.id === BUILTIN_SKILL_IDS.build)!.projectOwn).toBe("Using the project's own build skill");
    expect(preview.skills.find((sk) => sk.id === BUILTIN_SKILL_IDS.validate)!.projectOwn).toBeUndefined();
  });

  it('matches a tracked folder to a built-in ignoring case, so a tracked Build/ is the project\'s build skill (D74)', async () => {
    const wt = agent.worktreePath!;
    const skills = path.join(wt, '.claude', 'skills');
    git(wt, 'init', '-q');
    fs.mkdirSync(path.join(skills, 'Build'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'Build', 'SKILL.md'), '# ours');
    git(wt, 'add', '.claude/skills/Build/SKILL.md');
    agent.managed = { version: 1, blocks: [], skills: [BUILTIN_SKILL_IDS.build], mcps: [] };
    const backupRoot = path.join(root, 'backup');
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider(), backupRoot }));
    // On a case-insensitive file system build/ is Build/; either way only the project's folder is there.
    expect(fs.readdirSync(skills).filter((f) => !f.startsWith('.'))).toEqual(['Build']);
    expect(fs.readFileSync(path.join(skills, 'Build', 'SKILL.md'), 'utf-8')).toBe('# ours');
    expect(fs.existsSync(backupRoot)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(skills, '.clubhouse-managed-skills.json'), 'utf-8'))).toEqual({ skills: [] });
  });

  it('never removes a folder it delivered once the project commits it, even after the skill leaves the setup (D74)', async () => {
    const wt = agent.worktreePath!;
    const skills = path.join(wt, '.claude', 'skills');
    git(wt, 'init', '-q');
    agent.managed = { version: 1, blocks: [], skills: [BUILTIN_SKILL_IDS.build], mcps: [] };
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    git(wt, 'add', '.claude/skills/build/SKILL.md');
    agent.managed = { version: 1, blocks: [], skills: [], mcps: [] };
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    expect(fs.existsSync(path.join(skills, 'build', 'SKILL.md'))).toBe(true);
  });

  it('still replaces an untracked folder in a built-in skill\'s way, and leaves one it delivered once git tracks it (D74)', async () => {
    const wt = agent.worktreePath!;
    const skills = path.join(wt, '.claude', 'skills');
    git(wt, 'init', '-q');
    fs.mkdirSync(path.join(skills, 'build'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'build', 'SKILL.md'), '# stray');
    agent.managed = { version: 1, blocks: [], skills: [BUILTIN_SKILL_IDS.build], mcps: [] };
    const backupRoot = path.join(root, 'backup');
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider(), backupRoot }));
    const builtin = BUILTIN_SKILL_TEXT['skills/build/SKILL.md'];
    expect(fs.readFileSync(path.join(skills, 'build', 'SKILL.md'), 'utf-8')).toBe(builtin);
    const [moved] = fs.readdirSync(backupRoot);
    expect(fs.readFileSync(path.join(backupRoot, moved, 'SKILL.md'), 'utf-8')).toBe('# stray');

    // The project commits Clubhouse's copy and edits it: from then on it's the project's.
    fs.writeFileSync(path.join(skills, 'build', 'SKILL.md'), '# committed');
    git(wt, 'add', '.claude/skills/build/SKILL.md');
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider(), backupRoot }));
    expect(fs.readFileSync(path.join(skills, 'build', 'SKILL.md'), 'utf-8')).toBe('# committed');
    expect(JSON.parse(fs.readFileSync(path.join(skills, '.clubhouse-managed-skills.json'), 'utf-8'))).toEqual({ skills: [] });
    // Dropped from the setup, it's still never removed.
    agent.managed = { version: 1, blocks: [], skills: [], mcps: [] };
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider(), backupRoot }));
    expect(fs.readFileSync(path.join(skills, 'build', 'SKILL.md'), 'utf-8')).toBe('# committed');
  });

  it('keeps today\'s behavior for a custom skill whose folder git tracks: the folder moves aside and the skill takes its place (D48, D74)', async () => {
    const wt = agent.worktreePath!;
    const skills = path.join(wt, '.claude', 'skills');
    git(wt, 'init', '-q');
    fs.mkdirSync(path.join(skills, 'build'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'build', 'SKILL.md'), '# ours');
    git(wt, 'add', '.claude/skills/build/SKILL.md');
    const mine = await user(() => service.createPart({ name: 'My build', content: { kind: 'skill', skillName: 'build', files: [{ path: 'SKILL.md', content: '# mine' }] } }));
    agent.managed = { version: 1, blocks: [], skills: [mine.id], mcps: [] };
    const backupRoot = path.join(root, 'backup');
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider(), backupRoot }));
    expect(fs.readFileSync(path.join(skills, 'build', 'SKILL.md'), 'utf-8')).toBe('# mine');
    const [moved] = fs.readdirSync(backupRoot);
    expect(fs.readFileSync(path.join(backupRoot, moved, 'SKILL.md'), 'utf-8')).toBe('# ours');
    const preview = await user(() => previewManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    expect(preview.skills[0].projectOwn).toBeUndefined();
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
