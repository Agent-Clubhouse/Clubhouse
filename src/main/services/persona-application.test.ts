import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

vi.mock('fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

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

import { CopilotCliProvider } from '../orchestrators/copilot-cli-provider';
import { extractAgentPersona } from './materialization-service';
import { writeSourcePersonaContent } from './agent-settings-service';
import { serializePersonaFile } from '../../shared/persona-pattern';
import { resolveOrchestrator } from './agent-system';
import { isClubhouseModeEnabled } from './clubhouse-mode-settings';
import type { DurableAgentConfig } from '../../shared/types';

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
    vi.mocked(resolveOrchestrator).mockResolvedValue(provider as never);
    vi.mocked(isClubhouseModeEnabled).mockReturnValue(false);
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

  it('leaves alone what a start asked for by name, and still applies the rest (#2671)', async () => {
    await writePersona(projectPersonas(), 'pinned', '---\nmodel: sonnet\norchestrator: codex-cli\nfreeAgentMode: true\n---\n\n# Pinned\n');
    store.set('agent-1', { ...store.get('agent-1'), model: 'opus', orchestrator: 'claude-code' });
    await applyPersonaToAgent(projectPath, 'agent-1', 'pinned', { keep: ['orchestrator', 'model'] });
    expect(store.get('agent-1')).toMatchObject({ persona: 'pinned', model: 'opus', orchestrator: 'claude-code', freeAgentMode: true });
  });

  it('without keep, a persona still sets them: nothing changes for a start that named nothing', async () => {
    await writePersona(projectPersonas(), 'pinned', '---\nmodel: sonnet\norchestrator: codex-cli\n---\n\n# Pinned\n');
    store.set('agent-1', { ...store.get('agent-1'), model: 'opus', orchestrator: 'claude-code' });
    await applyPersonaToAgent(projectPath, 'agent-1', 'pinned');
    expect(store.get('agent-1')).toMatchObject({ model: 'sonnet', orchestrator: 'codex-cli' });
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
  it.each([false, true])('Extract -> save -> Apply preserves Copilot root custom text without a persona (Clubhouse mode %s)', async (mode) => {
    const source = path.join(projectPath, 'source');
    const target = path.join(projectPath, 'target');
    await fsp.mkdir(path.join(source, '.github'), { recursive: true });
    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(path.join(source, '.github/copilot-instructions.md'), 'Identity for source-bot with @@Path.');
    await fsp.writeFile(path.join(source, 'CLAUDE.md'), 'UNIQUE_CUSTOM_MARKER: preserve the operator checklist.');
    await fsp.writeFile(path.join(source, 'AGENTS.md'), 'ADDITIONAL_ROOT_MARKER');
    const copilot = new CopilotCliProvider();
    const agent: DurableAgentConfig = { id: 'source', name: 'source-bot', color: 'blue', createdAt: '2026-11-05T00:00:00Z', worktreePath: source, orchestrator: 'copilot-cli' };
    const captured = await extractAgentPersona({ projectPath, agent, provider: copilot });
    expect(captured.sources).toEqual(['.github/copilot-instructions.md', 'AGENTS.md', 'CLAUDE.md']);
    expect(captured.content).toContain('UNIQUE_CUSTOM_MARKER');
    expect(captured.content).toContain('@@AgentName');
    await writeSourcePersonaContent(projectPath, 'captured', serializePersonaFile(captured.settings, captured.content), 'project');
    store.set('target', { ...agent, id: 'target', name: 'target-bot', worktreePath: target });
    vi.mocked(resolveOrchestrator).mockResolvedValue(copilot);
    vi.mocked(isClubhouseModeEnabled).mockReturnValue(mode);
    await applyPersonaToAgent(projectPath, 'target', 'captured');
    const delivered = await fsp.readFile(path.join(target, '.github/copilot-instructions.md'), 'utf8');
    expect(delivered).toContain('UNIQUE_CUSTOM_MARKER: preserve the operator checklist.');
    expect(delivered).toContain('ADDITIONAL_ROOT_MARKER');
    expect(delivered).toContain('target-bot');
    expect(delivered).not.toContain('source-bot');
    expect(await fsp.readFile(path.join(source, 'CLAUDE.md'), 'utf8')).toBe('UNIQUE_CUSTOM_MARKER: preserve the operator checklist.');
    expect(store.get('target')?.orchestrator).toBe('copilot-cli');
  });

  it('refuses extraction when a supplementary document is unreadable instead of exporting the primary alone', async () => {
    const source = path.join(projectPath, 'source');
    await fsp.mkdir(path.join(source, '.github'), { recursive: true });
    await fsp.writeFile(path.join(source, '.github/copilot-instructions.md'), 'generic identity');
    await fsp.mkdir(path.join(source, 'CLAUDE.md')); // deterministic non-regular source, including root-run tests
    const agent = { id: 'source', name: 'source', color: 'blue', createdAt: '', worktreePath: source };
    await expect(extractAgentPersona({ projectPath, agent, provider: new CopilotCliProvider() })).rejects.toThrow('Cannot extract CLAUDE.md');
    await expect(fsp.stat(path.join(projectPath, '.clubhouse/personas/captured.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('surfaces a primary read failure instead of returning an empty export', async () => {
    const source = path.join(projectPath, 'source');
    await fsp.mkdir(path.join(source, '.github/copilot-instructions.md'), { recursive: true });
    const agent = { id: 'source', name: 'source', color: 'blue', createdAt: '', worktreePath: source };
    await expect(extractAgentPersona({ projectPath, agent, provider: new CopilotCliProvider() })).rejects.toThrow('No persona was extracted');
  });

  it('refuses primary extraction when open fails after a successful inspection', async () => {
    const source = path.join(projectPath, 'source');
    await fsp.mkdir(path.join(source, '.github'), { recursive: true });
    const file = path.join(source, '.github/copilot-instructions.md');
    await fsp.writeFile(file, 'PRIMARY_CUSTOM_MARKER');
    const open = vi.mocked(fsp.open).mockRejectedValueOnce(Object.assign(new Error('gone after inspection'), { code: 'ENOENT' }));
    try {
      const agent = { id: 'source', name: 'source', color: 'blue', createdAt: '', worktreePath: source };
      await expect(extractAgentPersona({ projectPath, agent, provider: new CopilotCliProvider() })).rejects.toThrow('No persona was extracted');
      expect(open).toHaveBeenCalled();
    } finally { open.mockClear(); }
  });

});
