import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
import { deliverManagedSetup, previewManagedSetup, resolveManagedMcpServers } from './delivery';
import type { OrchestratorProvider } from '../../orchestrators/types';

const user = <T>(fn: () => T) => withSettingsSurface('ui', undefined, fn);

let root: string;
let project: string;
let service: ManagedAgentsService;
let agent: DurableAgentConfig;

function provider(conv: Partial<OrchestratorProvider['conventions']> = {}): OrchestratorProvider {
  const conventions = { configDir: '.claude', skillsDir: 'skills', mcpConfigFile: '.mcp.json', legacyInstructionsFile: 'CLAUDE.md', settingsFormat: 'json', ...conv };
  return {
    id: 'claude-code',
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
  service = createManagedAgentsService({
    catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
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
    // A folder Clubhouse didn't write is left alone.
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
