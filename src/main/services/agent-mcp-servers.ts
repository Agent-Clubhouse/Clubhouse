/**
 * The MCP servers an agent gets besides the Clubhouse bridge, as the launch
 * code takes them: launch flags in the terminal (agent-system), SDK options in
 * chat (chat-spawn). A managed agent gets exactly its MCP parts (#2896).
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import { parseMcpJson } from '../../shared/mcp-config';
import type { DurableAgentConfig, McpServerDef } from '../../shared/types';
import { replaceWildcards } from '../../shared/wildcard-replacer';
import { readLocalMcpJson, readProjectAgentDefaults, type SettingsConventions } from './agent-settings-service';
import { buildWildcardContext, resolveAgentCommands, resolveSourceControlProvider } from './agent-wildcards';
import { appLog } from './log-service';
import { isClubhouseMcpEntry } from './clubhouse-mcp/injection';

/**
 * What an unmanaged Codex agent is told when its own .codex/config.toml lists
 * MCP servers Clubhouse doesn't pass (#2849). Clubhouse has no TOML reader.
 * Codex itself loads them from the project config layer, but only for a
 * folder its user config trusts (probed on Codex 0.163 with config/read).
 */
export function localTomlMcpNotice(names: readonly string[]): string {
  const listed = names.length > 0 ? `: ${names.join(', ')}` : '';
  return `This agent's .codex/config.toml lists MCP servers that Clubhouse doesn't pass to Codex${listed}. Codex loads them itself only if it trusts this folder. The file is left as it is.`;
}

const TOML_KEY = String.raw`(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))`;
const MCP_SERVERS = String.raw`["']?mcp_servers["']?`;
/** `[mcp_servers.<name>...]` table headers. */
const SERVER_TABLE = new RegExp(String.raw`^[ \t]*\[[ \t]*${MCP_SERVERS}[ \t]*\.[ \t]*${TOML_KEY}`, 'gm');
/** Top-level dotted keys, `mcp_servers.<name>.command = ...`. */
const SERVER_KEY = new RegExp(String.raw`^[ \t]*${MCP_SERVERS}[ \t]*\.[ \t]*${TOML_KEY}[^=\n]*=`, 'gm');
/** A whole `[mcp_servers]` table or an inline `mcp_servers = { ... }`, whose names this doesn't read. */
const WHOLE_TABLE = new RegExp(String.raw`^[ \t]*(?:\[[ \t]*${MCP_SERVERS}[ \t]*\]|${MCP_SERVERS}[ \t]*=)`, 'm');

/**
 * The MCP server names a Codex TOML file lists. Not a TOML parser. `unknown`
 * is true when it lists servers in a form whose names this doesn't read.
 */
export function tomlMcpServerNames(toml: string): { names: string[]; unknown: boolean } {
  const text = toml.replace(/^\uFEFF/, '');
  const names = new Set<string>();
  for (const re of [SERVER_TABLE, SERVER_KEY]) {
    for (const m of text.matchAll(re)) names.add(m[1] ?? m[2] ?? m[3]);
  }
  return { names: [...names], unknown: WHOLE_TABLE.test(text) };
}

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
  // No TOML reader exists here: project defaults are delivered. The notice
  // names only local servers they don't cover: Clubhouse writes the project
  // defaults into a Codex worktree's file itself, and older versions wrote the
  // bridge there (#2849).
  if (local.conventions.settingsFormat === 'toml') {
    const servers = await fromProject();
    let toml = '';
    try {
      toml = await fsp.readFile(path.join(local.cwd, local.conventions.mcpConfigFile), 'utf-8');
    } catch {
      // telemetry-exempt: no readable local file means no local servers to mention
    }
    const listed = tomlMcpServerNames(toml);
    const extra = listed.names.filter((name) => name !== 'clubhouse' && !(name in servers));
    if (extra.length > 0 || listed.unknown) local.onNotice?.(localTomlMcpNotice(extra));
    return servers;
  }
  const raw = await readLocalMcpJson(local.cwd, local.conventions);
  const servers = raw === null ? undefined : parseMcpJson(raw);
  if (!servers) return fromProject();
  const { clubhouse: _clubhouse, ...rest } = servers;
  if (_clubhouse && !isClubhouseMcpEntry(_clubhouse)) {
    const message = 'Configured clubhouse entry is reserved; only the separately controlled live bridge is delivered.';
    appLog('core:mcp', 'warn', message);
    local.onNotice?.(message);
  }
  return rest;
}
