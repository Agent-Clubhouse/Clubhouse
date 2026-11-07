import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DurableAgentConfig, ProjectAgentDefaults } from '../../shared/types';

const h = vi.hoisted(() => ({ defaults: {} as ProjectAgentDefaults, appScp: 'github' as 'github' | 'azure-devops' }));

vi.mock('./agent-settings-service', () => ({ readProjectAgentDefaults: vi.fn(async () => h.defaults) }));
// The app level as source-control-settings.test.ts pins it: its own setting, then the old Clubhouse Mode one, then GitHub.
vi.mock('./source-control-settings', () => ({ effectiveAppSourceControlProvider: () => h.appScp }));

import { buildWildcardContext, resolveAgentCommands, resolveSourceControlProvider } from './agent-wildcards';

const testAgent: DurableAgentConfig = {
  id: 'test_001',
  name: 'bold-falcon',
  color: 'blue',
  branch: 'bold-falcon/standby',
  worktreePath: '/project/.clubhouse/agents/bold-falcon',
  createdAt: '2024-01-01',
};

beforeEach(() => {
  h.defaults = {};
  h.appScp = 'github';
});

describe('buildWildcardContext', () => {
  it('builds context from agent config', () => {
    const ctx = buildWildcardContext(testAgent, '/project');
    expect(ctx.agentName).toBe('bold-falcon');
    expect(ctx.standbyBranch).toBe('bold-falcon/standby');
    expect(ctx.agentPath).toBe('.clubhouse/agents/bold-falcon/');
  });

  it('falls back to name-based path when no worktreePath', () => {
    const ctx = buildWildcardContext({ ...testAgent, worktreePath: undefined }, '/project');
    expect(ctx.agentPath).toBe('.clubhouse/agents/bold-falcon/');
  });

  it('falls back to name-based standby branch when no branch set', () => {
    const ctx = buildWildcardContext({ ...testAgent, branch: undefined }, '/project');
    expect(ctx.standbyBranch).toBe('bold-falcon/standby');
  });

  it('includes sourceControlProvider when provided, and omits it otherwise', () => {
    expect(buildWildcardContext(testAgent, '/project', 'github').sourceControlProvider).toBe('github');
    expect(buildWildcardContext(testAgent, '/project', 'azure-devops').sourceControlProvider).toBe('azure-devops');
    expect(buildWildcardContext(testAgent, '/project').sourceControlProvider).toBeUndefined();
  });

  it('includes command wildcards when provided, and omits them otherwise', () => {
    const ctx = buildWildcardContext(testAgent, '/project', undefined, {
      buildCommand: 'cargo build',
      testCommand: 'cargo test',
      lintCommand: 'cargo clippy',
    });
    expect(ctx).toMatchObject({ buildCommand: 'cargo build', testCommand: 'cargo test', lintCommand: 'cargo clippy' });
    const bare = buildWildcardContext(testAgent, '/project');
    expect(bare.buildCommand).toBeUndefined();
    expect(bare.testCommand).toBeUndefined();
    expect(bare.lintCommand).toBeUndefined();
  });

  it('has no mission or persona: managed delivery leaves @@Mission and @@Persona as written (D60)', () => {
    const ctx = buildWildcardContext(testAgent, '/project');
    expect(ctx).not.toHaveProperty('mission');
    expect(ctx).not.toHaveProperty('persona');
  });
});

describe('resolveSourceControlProvider', () => {
  it('returns the project-level setting when set', async () => {
    h.defaults = { sourceControlProvider: 'azure-devops' };
    expect(await resolveSourceControlProvider('/project')).toBe('azure-devops');
  });

  it('falls back to the app level (D61)', async () => {
    h.appScp = 'azure-devops';
    expect(await resolveSourceControlProvider('/project')).toBe('azure-devops');
    h.appScp = 'github';
    expect(await resolveSourceControlProvider('/project')).toBe('github');
  });

  it('treats a project set to GitHub as explicit, over an app level of Azure DevOps', async () => {
    h.defaults = { sourceControlProvider: 'github' };
    h.appScp = 'azure-devops';
    expect(await resolveSourceControlProvider('/project')).toBe('github');
  });

  it('honors a per-agent override over project and app settings', async () => {
    h.defaults = { sourceControlProvider: 'github' };
    expect(await resolveSourceControlProvider('/project', { ...testAgent, sourceControlProvider: 'azure-devops' })).toBe('azure-devops');
  });
});

describe('resolveAgentCommands', () => {
  it('uses per-agent overrides when set', () => {
    const agent = { ...testAgent, buildCommand: 'make build', testCommand: 'make test', lintCommand: 'make lint' };
    expect(resolveAgentCommands(agent, { buildCommand: 'npm run build' })).toEqual({
      buildCommand: 'make build', testCommand: 'make test', lintCommand: 'make lint',
    });
  });

  it('falls back to project defaults when agent override unset', () => {
    expect(resolveAgentCommands(testAgent, { buildCommand: 'npm run build', testCommand: 'npm test' })).toEqual({
      buildCommand: 'npm run build', testCommand: 'npm test', lintCommand: undefined,
    });
  });
});
