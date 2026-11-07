/**
 * The MCP servers an agent gets besides the Clubhouse bridge, as the launch
 * code takes them: launch flags in the terminal (agent-system), SDK options in
 * chat (chat-spawn). A managed agent gets exactly its MCP parts (#2896).
 */
import { parseMcpJson } from '../../shared/mcp-config';
import type { DurableAgentConfig, McpServerDef } from '../../shared/types';
import { replaceWildcards } from '../../shared/wildcard-replacer';
import { readLocalMcpJson, readProjectAgentDefaults, type SettingsConventions } from './agent-settings-service';
import { buildWildcardContext, resolveAgentCommands, resolveSourceControlProvider } from './agent-wildcards';
import { appLog } from './log-service';

/** Project defaults with agent wildcards. Invalid desired config is an explicit failure. */
export async function resolveProjectMcpServers(
  projectPath: string,
  agent?: DurableAgentConfig,
): Promise<Record<string, McpServerDef>> {
  // Managed agents (#2896) get exactly their MCP server parts, never project defaults.
  if (agent?.managed) {
    const { managedMcpServersFor } = await import('./managed-agents');
    return managedMcpServersFor(agent);
  }
  const defaults = await readProjectAgentDefaults(projectPath);
  if (!defaults.mcpJson) return {};
  let json = defaults.mcpJson;
  if (agent) {
    const scp = await resolveSourceControlProvider(projectPath, agent);
    json = replaceWildcards(json, buildWildcardContext(agent, projectPath, scp, resolveAgentCommands(agent, defaults)));
  }
  const { clubhouse: _clubhouse, ...rest } = parseMcpJson(json);
  return rest;
}

/**
 * An unmanaged agent's own MCP file wins whole, an empty map included. With no
 * file it inherits the project defaults. Managed agents use their parts.
 * Read before injecting the live bridge: injection can create an otherwise missing file.
 */
export async function resolveAgentMcpServers(
  projectPath: string,
  agent: DurableAgentConfig | undefined,
  local: { cwd: string; conventions: SettingsConventions; onNotice?: (message: string) => void },
): Promise<Record<string, McpServerDef>> {
  if (agent?.managed) return resolveProjectMcpServers(projectPath, agent);
  // No TOML reader exists here. Preserve canonical delivery and make the limitation visible.
  if (local.conventions.settingsFormat === 'toml') {
    local.onNotice?.('Local TOML MCP configuration is not supported by chat preparation. Chat uses project MCP JSON defaults; local TOML servers are not delivered by this path. The local file is preserved.');
    return resolveProjectMcpServers(projectPath, agent);
  }
  const raw = await readLocalMcpJson(local.cwd, local.conventions);
  const servers = raw === null ? undefined : parseMcpJson(raw);
  if (!servers) return resolveProjectMcpServers(projectPath, agent);
  const { clubhouse: _clubhouse, ...rest } = servers;
  if (_clubhouse) {
    const message = 'Configured clubhouse entry is reserved; only the separately controlled live bridge is delivered.';
    appLog('core:mcp', 'warn', message);
    local.onNotice?.(message);
  }
  return rest;
}
