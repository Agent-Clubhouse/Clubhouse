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

/** What an agent is told when the project MCP JSON isn't JSON (D10). */
export const PROJECT_MCP_JSON_INVALID_NOTICE = 'The project MCP configuration isn\'t valid JSON, so its servers were left out. Conditional wildcards (@@If) are no longer processed; edit the project MCP configuration to fix it.';

/**
 * Project defaults with agent wildcards. Project MCP JSON that isn't JSON, for
 * example one that still has @@If blocks now conditional wildcards are retired
 * (D10), gives no project servers, with a warning (a code only) and
 * `onNotice`, rather than failing the start. Valid JSON that isn't a valid MCP
 * configuration is still an explicit failure.
 */
export async function resolveProjectMcpServers(
  projectPath: string,
  agent?: DurableAgentConfig,
  onNotice?: (message: string) => void,
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
  try {
    JSON.parse(json);
  } catch {
    // telemetry-exempt: logged with a code; the agent starts without the project's servers and is told why.
    appLog('core:mcp', 'warn', 'Project MCP JSON is not valid JSON; no project MCP servers delivered', {
      meta: { code: /@@If\(/.test(json) ? 'conditional_wildcards' : 'invalid_json' },
    });
    onNotice?.(PROJECT_MCP_JSON_INVALID_NOTICE);
    return {};
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
  const fromProject = () => resolveProjectMcpServers(projectPath, agent, local.onNotice);
  // No TOML reader exists here. Preserve canonical delivery and make the limitation visible.
  if (local.conventions.settingsFormat === 'toml') {
    local.onNotice?.('Local TOML MCP configuration is not supported by chat preparation. Chat uses project MCP JSON defaults; local TOML servers are not delivered by this path. The local file is preserved.');
    return fromProject();
  }
  const raw = await readLocalMcpJson(local.cwd, local.conventions);
  const servers = raw === null ? undefined : parseMcpJson(raw);
  if (!servers) return fromProject();
  const { clubhouse: _clubhouse, ...rest } = servers;
  if (_clubhouse) {
    const message = 'Configured clubhouse entry is reserved; only the separately controlled live bridge is delivered.';
    appLog('core:mcp', 'warn', message);
    local.onNotice?.(message);
  }
  return rest;
}
