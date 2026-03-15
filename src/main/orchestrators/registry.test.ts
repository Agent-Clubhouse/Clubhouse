import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OrchestratorProvider, OrchestratorId, ProviderCapabilities, OrchestratorConventions } from './types';

// Mock all provider constructors so registerBuiltinProviders doesn't need real binaries
vi.mock('./claude-code-provider', () => ({
  ClaudeCodeProvider: class { constructor() { return makeFakeProvider('claude-code', 'Claude Code'); } },
}));
vi.mock('./copilot-cli-provider', () => ({
  CopilotCliProvider: class { constructor() { return makeFakeProvider('copilot-cli', 'Copilot CLI'); } },
}));
vi.mock('./codex-cli-provider', () => ({
  CodexCliProvider: class { constructor() { return makeFakeProvider('codex-cli', 'Codex CLI'); } },
}));
vi.mock('./opencode-provider', () => ({
  OpenCodeProvider: class { constructor() { return makeFakeProvider('opencode', 'OpenCode'); } },
}));

function makeFakeProvider(id: OrchestratorId, displayName: string): OrchestratorProvider {
  return {
    id,
    displayName,
    shortName: id,
    conventions: {} as OrchestratorConventions,
    getCapabilities: () => ({} as ProviderCapabilities),
    checkAvailability: async () => ({ available: false }),
    buildSpawnCommand: async () => ({ binary: '', args: [] }),
    getExitCommand: () => '',
    readInstructions: () => '',
    writeInstructions: () => {},
    getModelOptions: async () => [],
    getDefaultPermissions: () => [],
    toolVerb: () => undefined,
    getProfileEnvKeys: () => [],
  };
}

// Use dynamic imports after resetModules to get a fresh providers Map per test
async function loadRegistry() {
  const mod = await import('./registry');
  return mod;
}

describe('Orchestrator Registry', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe('registerProvider', () => {
    it('registers a provider that can be retrieved by id', async () => {
      const { registerProvider, getProvider } = await loadRegistry();
      const provider = makeFakeProvider('test-provider', 'Test');

      registerProvider(provider);

      expect(getProvider('test-provider')).toBe(provider);
    });

    it('overwrites a provider with the same id', async () => {
      const { registerProvider, getProvider } = await loadRegistry();
      const first = makeFakeProvider('dupe', 'First');
      const second = makeFakeProvider('dupe', 'Second');

      registerProvider(first);
      registerProvider(second);

      expect(getProvider('dupe')).toBe(second);
      expect(getProvider('dupe')!.displayName).toBe('Second');
    });
  });

  describe('getProvider', () => {
    it('returns undefined for an unregistered id', async () => {
      const { getProvider } = await loadRegistry();

      expect(getProvider('nonexistent')).toBeUndefined();
    });

    it('returns the correct provider among many', async () => {
      const { registerProvider, getProvider } = await loadRegistry();
      const a = makeFakeProvider('alpha', 'Alpha');
      const b = makeFakeProvider('beta', 'Beta');
      const c = makeFakeProvider('gamma', 'Gamma');

      registerProvider(a);
      registerProvider(b);
      registerProvider(c);

      expect(getProvider('beta')).toBe(b);
    });
  });

  describe('getAllProviders', () => {
    it('returns an empty array when no providers registered', async () => {
      const { getAllProviders } = await loadRegistry();

      expect(getAllProviders()).toEqual([]);
    });

    it('returns all registered providers', async () => {
      const { registerProvider, getAllProviders } = await loadRegistry();
      const a = makeFakeProvider('p1', 'Provider 1');
      const b = makeFakeProvider('p2', 'Provider 2');

      registerProvider(a);
      registerProvider(b);

      const all = getAllProviders();
      expect(all).toHaveLength(2);
      expect(all).toContain(a);
      expect(all).toContain(b);
    });

    it('returns a new array on each call (not a reference to internal state)', async () => {
      const { registerProvider, getAllProviders } = await loadRegistry();
      registerProvider(makeFakeProvider('x', 'X'));

      const first = getAllProviders();
      const second = getAllProviders();
      expect(first).toEqual(second);
      expect(first).not.toBe(second);
    });
  });

  describe('registerBuiltinProviders', () => {
    it('registers all four built-in providers', async () => {
      const { registerBuiltinProviders, getAllProviders, getProvider } = await loadRegistry();

      registerBuiltinProviders();

      const all = getAllProviders();
      expect(all).toHaveLength(4);
      expect(getProvider('claude-code')).toBeDefined();
      expect(getProvider('copilot-cli')).toBeDefined();
      expect(getProvider('codex-cli')).toBeDefined();
      expect(getProvider('opencode')).toBeDefined();
    });

    it('is idempotent — calling twice does not duplicate providers', async () => {
      const { registerBuiltinProviders, getAllProviders } = await loadRegistry();

      registerBuiltinProviders();
      registerBuiltinProviders();

      expect(getAllProviders()).toHaveLength(4);
    });
  });
});
