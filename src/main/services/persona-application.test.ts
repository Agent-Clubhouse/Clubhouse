import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const { home } = vi.hoisted(() => ({ home: { dir: '' } }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => home.dir || actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/clubhouse-test' },
}));

vi.mock('./log-service', () => ({ appLog: vi.fn() }));

vi.mock('./clubhouse-mode-settings', () => ({
  getSettings: vi.fn(() => ({ enabled: false })),
  isClubhouseModeEnabled: vi.fn(() => false),
}));

// In-memory agent store standing in for agents.json.
const store = new Map<string, Record<string, unknown>>();
// The real persona rule (#2551); the store stays in memory.
vi.mock('./agent-config', async () => ({
  assertPersonaAllowed: (await vi.importActual<typeof import('./agent-config')>('./agent-config')).assertPersonaAllowed,
  getDurableConfig: vi.fn(async (_p: string, id: string) => (store.has(id) ? { ...store.get(id) } : null)),
  updateDurableConfig: vi.fn(async (_p: string, id: string, updates: Record<string, unknown>) => {
    store.set(id, { ...store.get(id), ...updates });
  }),
}));

// In-memory instructions standing in for the orchestrator's instructions file.
const instructions = new Map<string, string>();
const provider = {
  id: 'claude-code',
  conventions: { configDir: '.claude', mcpConfigFile: '.mcp.json' },
  readInstructions: vi.fn(async (wt: string) => {
    if (!instructions.has(wt)) throw new Error('ENOENT');
    return instructions.get(wt)!;
  }),
  writeInstructions: vi.fn(async (wt: string, content: string) => { instructions.set(wt, content); }),
};
vi.mock('./agent-system', () => ({
  resolveOrchestrator: vi.fn(async () => provider),
}));

import { applyPersonaToAgent } from './persona-application';
import { updateDurableConfig } from './agent-config';
import { getPersonaTemplate } from '../../renderer/features/personas';
import { getDispatcherPath } from './dispatcher/dispatcher-paths';

describe('applyPersonaToAgent', () => {
  let root: string;
  let projectPath: string;
  const worktreePath = '/wt/agent';

  async function writePersona(dir: string, id: string, content: string) {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${id}.md`), content, 'utf-8');
  }
  const projectPersonas = () => path.join(projectPath, '.clubhouse', 'personas');
  const userPersonas = () => path.join(home.dir, '.clubhouse', 'personas');

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'persona-apply-'));
    home.dir = path.join(root, 'home');
    projectPath = path.join(root, 'project');
    await fsp.mkdir(projectPath, { recursive: true });
    store.clear();
    instructions.clear();
    store.set('agent-1', { id: 'agent-1', name: 'bot', color: 'red', worktreePath, model: 'sonnet' });
  });

  afterEach(async () => {
    home.dir = '';
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('prefers the project persona over the user persona and applies its front-matter', async () => {
    await writePersona(userPersonas(), 'reviewer', '---\nmodel: haiku\n---\n\n# User reviewer\n');
    await writePersona(projectPersonas(), 'reviewer', '---\nmodel: opus\nmcpIds: ["github"]\nfreeAgentMode: true\n---\n\n# Project reviewer for @@AgentName\n');
    instructions.set(worktreePath, 'Project defaults');

    await applyPersonaToAgent(projectPath, 'agent-1', 'reviewer', { appendToExisting: true });

    expect(updateDurableConfig).toHaveBeenCalledWith(projectPath, 'agent-1', {
      persona: 'reviewer', model: 'opus', mcpIds: ['github'], freeAgentMode: true,
    });
    expect(store.get('agent-1')).toMatchObject({ persona: 'reviewer', model: 'opus', mcpIds: ['github'], freeAgentMode: true });
    // Front-matter is stripped, wildcards resolved, and the defaults snapshot kept.
    expect(instructions.get(worktreePath)).toBe('Project defaults\n\n# Project reviewer for bot\n');
  });

  it('falls back to the user persona when the project has none', async () => {
    await writePersona(userPersonas(), 'reviewer', '---\nmodel: haiku\n---\n\n# User reviewer\n');

    await applyPersonaToAgent(projectPath, 'agent-1', 'reviewer', { appendToExisting: true });

    expect(store.get('agent-1')).toMatchObject({ persona: 'reviewer', model: 'haiku' });
    expect(instructions.get(worktreePath)).toBe('# User reviewer\n');
  });

  it('falls back to the built-in persona when neither layer defines it', async () => {
    await applyPersonaToAgent(projectPath, 'agent-1', 'qa', { appendToExisting: true });

    expect(store.get('agent-1')).toMatchObject({ persona: 'qa', model: 'sonnet' });
    const builtin = getPersonaTemplate('qa')!.content;
    expect(instructions.get(worktreePath)).toContain(builtin.split('\n')[0]);
  });

  it('applies the built-in Orchestrator without copying its orchestration front-matter', async () => {
    await applyPersonaToAgent(projectPath, 'agent-1', 'orchestrator');

    expect(updateDurableConfig).toHaveBeenCalledWith(projectPath, 'agent-1', { persona: 'orchestrator' });
    expect(store.get('agent-1')).not.toHaveProperty('orchestration');
    const written = instructions.get(worktreePath)!;
    expect(written.startsWith('# Orchestrator')).toBe(true);
    expect(written).not.toContain('orchestration:');
    expect(written).toContain('`start_helper`');
  });

  it('applies the built-in Workhorse', async () => {
    await applyPersonaToAgent(projectPath, 'agent-1', 'workhorse');

    expect(store.get('agent-1')).toMatchObject({ persona: 'workhorse', model: 'sonnet' });
    expect(instructions.get(worktreePath)).toContain('`message_parent`');
  });

  it('replaces the instructions by default (Apply persona on an existing agent)', async () => {
    await writePersona(projectPersonas(), 'reviewer', '# Reviewer\n');
    instructions.set(worktreePath, 'Old instructions');

    await applyPersonaToAgent(projectPath, 'agent-1', 'reviewer');

    expect(instructions.get(worktreePath)).toBe('# Reviewer\n');
  });

  it('does nothing for an unknown agent', async () => {
    await applyPersonaToAgent(projectPath, 'missing', 'qa');
    expect(updateDurableConfig).not.toHaveBeenCalled();
    expect(provider.writeInstructions).not.toHaveBeenCalled();
  });

  describe('the dispatcher persona (#2551)', () => {
    it('refuses it for a project agent, writing nothing', async () => {
      instructions.set(worktreePath, 'Old instructions');
      await expect(applyPersonaToAgent(projectPath, 'agent-1', 'dispatcher')).rejects.toThrow('The Dispatcher persona is only for the Dispatcher.');
      expect(updateDurableConfig).not.toHaveBeenCalled();
      expect(store.get('agent-1')).not.toHaveProperty('persona');
      expect(instructions.get(worktreePath)).toBe('Old instructions');
    });

    it('refuses another persona for the Dispatcher, writing nothing', async () => {
      const dir = getDispatcherPath();
      store.set('disp', { id: 'disp', name: 'Dispatcher', color: 'indigo', persona: 'dispatcher' });
      await expect(applyPersonaToAgent(dir, 'disp', 'orchestrator')).rejects.toThrow("The Dispatcher's persona can't be changed.");
      expect(updateDurableConfig).not.toHaveBeenCalled();
      expect(store.get('disp')?.persona).toBe('dispatcher');
      expect(provider.writeInstructions).not.toHaveBeenCalled();
    });
  });
});
