/**
 * What an agent's `@@` wildcards resolve to (`shared/wildcard-replacer`):
 * its name, standby branch, folder, source control provider and build, test
 * and lint commands. Managed delivery, quick-agent templates and Preview use
 * these, and so does the switch to managed (managed-agents/legacy-migration).
 */
import * as path from 'path';
import type { DurableAgentConfig, ProjectAgentDefaults, SourceControlProvider } from '../../shared/types';
import type { WildcardContext } from '../../shared/wildcard-replacer';
import { readProjectAgentDefaults } from './agent-settings-service';
import { effectiveAppSourceControlProvider } from './source-control-settings';

export function buildWildcardContext(
  agent: DurableAgentConfig,
  projectPath: string,
  sourceControlProvider?: SourceControlProvider,
  commands?: { buildCommand?: string; testCommand?: string; lintCommand?: string },
): WildcardContext {
  const agentPath = agent.worktreePath
    ? path.relative(projectPath, agent.worktreePath).replace(/\\/g, '/') + '/'
    : `.clubhouse/agents/${agent.name}/`;
  return {
    agentName: agent.name,
    standbyBranch: agent.branch || `${agent.name}/standby`,
    agentPath,
    sourceControlProvider,
    buildCommand: commands?.buildCommand,
    testCommand: commands?.testCommand,
    lintCommand: commands?.lintCommand,
  };
}

/**
 * The effective build, test and lint commands for an agent. Its own override
 * wins, then the project defaults. Unset fields stay undefined so the wildcard
 * replacer applies its built-in fallbacks.
 */
export function resolveAgentCommands(
  agent: DurableAgentConfig,
  defaults: ProjectAgentDefaults,
): { buildCommand?: string; testCommand?: string; lintCommand?: string } {
  return {
    buildCommand: agent.buildCommand ?? defaults.buildCommand,
    testCommand: agent.testCommand ?? defaults.testCommand,
    lintCommand: agent.lintCommand ?? defaults.lintCommand,
  };
}

/**
 * The effective source control provider: the agent's own, then the project's,
 * then the app level (its own setting, D61, then the value Clubhouse Mode kept
 * before the startup pass copied it, then GitHub).
 */
export async function resolveSourceControlProvider(
  projectPath: string,
  agent?: DurableAgentConfig,
): Promise<SourceControlProvider> {
  if (agent?.sourceControlProvider) return agent.sourceControlProvider;
  const defaults = await readProjectAgentDefaults(projectPath);
  if (defaults.sourceControlProvider) return defaults.sourceControlProvider;
  return effectiveAppSourceControlProvider();
}
