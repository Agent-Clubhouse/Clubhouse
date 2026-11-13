/**
 * Switching to managed keeps an agent's saved legacy values (#2855): the real
 * agent-config writes the setup, and a saved persona or Clubhouse features off
 * stays in agents.json, ignored while managed and there again after Switch to plain.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ home: '', service: null as unknown }));

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => h.home } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../git-exclude-manager', () => ({ addExclusions: vi.fn(async () => {}), replaceExclusions: vi.fn(async () => {}) }));
vi.mock('../agent-system', () => ({
  resolveOrchestrator: async () => ({
    id: 'claude-code', displayName: 'Claude Code', checkAvailability: async () => ({ available: true }),
    conventions: { configDir: '.claude', skillsDir: 'skills', mcpConfigFile: '.mcp.json', legacyInstructionsFile: 'CLAUDE.md', localInstructionsFile: 'CLAUDE.md', settingsFormat: 'json' },
    readInstructions: async (worktree: string) => fs.readFileSync(path.join(worktree, 'CLAUDE.md'), 'utf-8'),
  }),
}));
vi.mock('./index', () => ({ managedAgents: () => h.service }));

import * as agentConfig from '../agent-config';
import { createAssetCatalogStore } from '../asset-catalog/store';
import { _resetSettingsAuditForTesting, withSettingsSurface } from '../settings-audit';
import { createManagedStateStore } from './state-store';
import { createManagedAgentsService } from './service';
import { convertToManaged } from './agents';

let root: string, project: string, worktree: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-legacy-'));
  h.home = path.join(root, 'home');
  project = path.join(root, 'project');
  worktree = path.join(project, 'wt');
  fs.mkdirSync(h.home, { recursive: true });
  fs.mkdirSync(path.join(project, '.clubhouse'), { recursive: true });
  fs.mkdirSync(path.join(worktree, '.claude', 'skills', 'ship'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'CLAUDE.md'), 'You are ada.');
  fs.writeFileSync(path.join(worktree, '.claude', 'skills', 'ship', 'SKILL.md'), '# Ship');
  fs.writeFileSync(path.join(project, '.clubhouse', 'agents.json'), JSON.stringify([{
    id: 'ada', name: 'ada', color: 'blue', createdAt: '2020-01-01T00:00:00.000Z', worktreePath: worktree, persona: 'qa', clubhouseFeatures: false,
  }]));
  agentConfig.clearAgentConfigCache();
  _resetSettingsAuditForTesting(false);
  const service = createManagedAgentsService({
    catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
    state: createManagedStateStore(path.join(root, 'managed')),
    listProjects: async () => [{ path: project, name: 'Project' }],
    listAgents: (p) => agentConfig.peekDurableConfigs(p),
    getAgent: (p, id) => agentConfig.getDurableConfig(p, id),
    setManagedSetup: (p, id, setup) => agentConfig.setManagedSetup(p, id, setup),
    isRunning: () => false,
  });
  await service.ensureBuiltins();
  h.service = service;
});

afterEach(async () => {
  await agentConfig.flushAgentConfig(project).catch(() => undefined);
  agentConfig.clearAgentConfigCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('switching to managed keeps saved legacy values (#2855)', () => {
  it('keeps persona and Clubhouse features off in agents.json, managed or switched back', async () => {
    const setup = await withSettingsSurface('ui', undefined, () => convertToManaged(project, 'ada', { keep: true }));
    expect(setup.skills).toHaveLength(1);
    await agentConfig.flushAgentConfig(project);
    const saved = JSON.parse(fs.readFileSync(path.join(project, '.clubhouse', 'agents.json'), 'utf8'))
      .find((a: { id: string }) => a.id === 'ada');
    expect(saved).toMatchObject({ persona: 'qa', clubhouseFeatures: false, managed: { skills: setup.skills } });
    await agentConfig.setManagedSetup(project, 'ada', null);
    expect(await agentConfig.getDurableConfig(project, 'ada')).toMatchObject({ persona: 'qa', clubhouseFeatures: false });
    expect((await agentConfig.getDurableConfig(project, 'ada'))?.managed).toBeUndefined();
  });
});
