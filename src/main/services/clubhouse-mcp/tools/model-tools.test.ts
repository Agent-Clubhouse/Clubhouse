import * as path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// What the gate decides is covered in mcp-call-gate.test.ts and test/mcp-off.
vi.mock('../mcp-call-gate', async (original) => ({ ...await original<typeof import('../mcp-call-gate')>(), mcpCallAccess: () => 'open' }));
import type { ModelList } from '../../../orchestrators/types';

// ── Mocks: providers list fixed models; no CLI is spawned ────────────────

interface FakeProvider {
  id: string;
  displayName: string;
  listModels?: ReturnType<typeof vi.fn>;
  getModelOptions: ReturnType<typeof vi.fn>;
  getCapabilities: () => Record<string, never>;
}
const providers: FakeProvider[] = [];
vi.mock('../../../orchestrators', () => ({
  getProvider: (id: string) => providers.find((p) => p.id === id),
  getAllProviders: () => [...providers],
}));


let enabled: string[] = [];
vi.mock('../../orchestrator-settings', () => ({ getSettings: () => ({ enabled }) }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));

import { LIST_SCOPE_NOTE, registerModelTools } from './model-tools';
import { callTool, getScopedToolList, _resetForTesting } from '../tool-registry';
import { agentRegistry } from '../../agent-registry';
import { setOrchestrationEnabled, _resetOrchestrationGateForTesting } from '../orchestration-gate';

const PROJECT = path.join(path.sep, 'tmp', 'project');

const claudeLive: ModelList = {
  source: 'live', via: 'handshake', fetchedAt: 0,
  models: [
    { id: 'default', label: 'Default (recommended)', isDefault: true, resolvedId: 'claude-opus-5-5', efforts: ['low', 'high'] },
    { id: 'haiku', label: 'Haiku 5.5', resolvedId: 'claude-haiku-5-5', description: 'Fastest' },
  ],
};
const codexFallback: ModelList = {
  source: 'fallback', via: 'command', fetchedAt: 0, liveError: 'Could not find Codex CLI',
  models: [{ id: 'default', label: 'Default' }, { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', hidden: true }],
};

function fakeProvider(id: string, displayName: string, list?: ModelList): FakeProvider {
  return {
    id,
    displayName,
    getCapabilities: () => ({}),
    ...(list && { listModels: vi.fn(async () => list) }),
    getModelOptions: vi.fn(async () => [{ id: 'default', label: 'Default' }, { id: 'static-x', label: 'Static X' }]),
  };
}

function parse(result: { content: Array<{ text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
  providers.splice(0, providers.length,
    fakeProvider('claude-code', 'Claude Code', claudeLive),
    fakeProvider('codex-cli', 'Codex CLI', codexFallback),
    fakeProvider('copilot-cli', 'GitHub Copilot CLI'));
  enabled = ['claude-code', 'codex-cli'];
  for (const id of [...agentRegistry.getAllRegistrations().keys()]) agentRegistry.untrack(id);
  _resetForTesting();
  _resetOrchestrationGateForTesting();
  registerModelTools();
  agentRegistry.register('orch', { projectPath: PROJECT, orchestrator: 'claude-code', runtime: 'chat' });
  setOrchestrationEnabled('orch', true);
});

describe('list_models', () => {
  it('is listed and callable only while orchestration is on', async () => {
    const tool = getScopedToolList('orch').find((t) => t.name === 'list_models');
    expect(tool?.description).toContain('user-level settings; a project-level model restriction is not applied');
    agentRegistry.register('plain', { projectPath: PROJECT, orchestrator: 'claude-code', runtime: 'chat' });
    setOrchestrationEnabled('plain', false);
    expect(getScopedToolList('plain').map((t) => t.name)).not.toContain('list_models');
    expect((await callTool('plain', 'list_models', {})).isError).toBe(true);
  });

  it('lists every enabled provider with its source', async () => {
    const body = parse(await callTool('orch', 'list_models', {}));
    expect(body.note).toBe(LIST_SCOPE_NOTE);
    expect(body.providers.map((p: any) => p.cli)).toEqual(['claude-code', 'codex-cli']);
    expect(body.providers[0]).toEqual({
      provider: 'claude-code',
      cli: 'claude-code',
      name: 'Claude Code',
      source: 'live',
      via: 'handshake',
      models: [
        { id: 'default', label: 'Default (recommended)', default: true, resolvesTo: 'claude-opus-5-5', efforts: ['low', 'high'] },
        { id: 'haiku', label: 'Haiku 5.5', resolvesTo: 'claude-haiku-5-5', description: 'Fastest' },
      ],
    });
  });

  it('marks a fallback list, with why the live list was unavailable', async () => {
    const body = parse(await callTool('orch', 'list_models', { cli: 'codex-cli' }));
    expect(body.providers).toEqual([{
      provider: 'codex-cli',
      cli: 'codex-cli',
      name: 'Codex CLI',
      source: 'fallback',
      via: 'command',
      liveError: 'Could not find Codex CLI',
      models: [{ id: 'default', label: 'Default' }, { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', hidden: true }],
    }]);
  });

  it('lists a single cli, enabled or not', async () => {
    const body = parse(await callTool('orch', 'list_models', { cli: 'claude-code' }));
    expect(body.providers.map((p: any) => p.cli)).toEqual(['claude-code']);
    const copilot = parse(await callTool('orch', 'list_models', { cli: 'copilot-cli' }));
    // A provider that can't list models reports its static options as a fallback.
    expect(copilot.providers[0]).toMatchObject({ cli: 'copilot-cli', source: 'fallback', via: 'static' });
    expect(copilot.providers[0].models.map((m: any) => m.id)).toEqual(['default', 'static-x']);
  });

  it('refuses an unknown cli, naming the known ones', async () => {
    const result = await callTool('orch', 'list_models', { cli: 'aider' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Unknown CLI "aider". Available: claude-code, codex-cli, copilot-cli');
  });

  it('takes the provider as provider, or as cli, its older name (#2776)', async () => {
    for (const args of [{ provider: 'codex-cli' }, { cli: 'codex-cli' }, { provider: 'codex-cli', cli: 'codex-cli' }]) {
      const body = parse(await callTool('orch', 'list_models', args));
      expect(body.providers.map((p: any) => [p.provider, p.cli]), JSON.stringify(args)).toEqual([['codex-cli', 'codex-cli']]);
    }
  });

  it('refuses provider and cli that disagree, asking no CLI (#2776)', async () => {
    const result = await callTool('orch', 'list_models', { provider: 'codex-cli', cli: 'claude-code' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('provider "codex-cli" and cli "claude-code" name different CLIs. Pass only provider.');
    expect(providers[0].listModels).not.toHaveBeenCalled();
    expect(providers[1].listModels).not.toHaveBeenCalled();
  });

  it('has no "auto" by either name: it lists real providers only', async () => {
    for (const args of [{ provider: 'auto' }, { cli: 'auto' }, { provider: 'auto', cli: 'auto' }]) {
      const result = await callTool('orch', 'list_models', args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(result.content[0].text).toBe('Unknown CLI "auto". Available: claude-code, codex-cli, copilot-cli');
    }
  });

  it('describes provider as the parameter, with cli as its older name', () => {
    const tool = getScopedToolList('orch').find((t) => t.name === 'list_models');
    const props = (tool?.inputSchema as { properties: Record<string, { description: string }> }).properties;
    expect(props.provider.description).toContain('CLI id');
    expect(props.cli.description).toContain('older name for provider');
  });

  it('lists every provider when none is enabled', async () => {
    enabled = [];
    const body = parse(await callTool('orch', 'list_models', {}));
    expect(body.providers.map((p: any) => p.cli)).toEqual(['claude-code', 'codex-cli', 'copilot-cli']);
  });

  it('lists for the CLI\'s local login, and refresh asks again', async () => {
    await callTool('orch', 'list_models', { cli: 'claude-code', refresh: true });
    expect(providers[0].listModels).toHaveBeenCalledWith({ refresh: true });
  });

  it('reports one provider\'s failure without failing the others', async () => {
    providers[1].listModels!.mockRejectedValueOnce(new Error('boom'));
    const body = parse(await callTool('orch', 'list_models', {}));
    expect(body.providers[0].source).toBe('live');
    expect(body.providers[1]).toEqual({ provider: 'codex-cli', cli: 'codex-cli', name: 'Codex CLI', error: 'boom', models: [] });
  });
});
