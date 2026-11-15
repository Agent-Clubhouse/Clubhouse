import * as fsp from 'fs/promises';
import * as path from 'path';
import type { SettingsConventions } from './agent-settings-service';
import { appLog } from './log-service';

/**
 * Remove stale JSON content from TOML config files. Before TOML-aware guards
 * were added, Clubhouse could write JSON to .codex/config.toml, which Codex
 * CLI's TOML parser rejects with "invalid key-value pair, expected key".
 * agent-system runs this before every start of a TOML CLI.
 */
export async function cleanupStaleJsonInTomlConfigs(
  worktreePath: string,
  conv: SettingsConventions,
): Promise<void> {
  const filesToCheck = [
    path.join(worktreePath, conv.mcpConfigFile),
    path.join(worktreePath, conv.configDir, conv.localSettingsFile),
  ];

  // mcpConfigFile and configDir/localSettingsFile may be the same file.
  const uniquePaths = [...new Set(filesToCheck.map((p) => path.resolve(p)))];

  for (const filePath of uniquePaths) {
    try {
      const content = await fsp.readFile(filePath, 'utf-8');
      // A JSON object: remove it so the CLI can start fresh. Not '[', since TOML section headers start with it.
      if (content.trimStart().startsWith('{')) {
        await fsp.unlink(filePath);
        appLog('core:materialization', 'info', 'Removed stale JSON content from TOML config file', {
          meta: { filePath },
        });
      }
    } catch {
      // telemetry-exempt: the file doesn't exist, so there is nothing to clean up
    }
  }
}

/**
 * Every `.codex/config.toml` Clubhouse wrote on its own: injectClubhouseMcp
 * into an empty file (mcpServerToToml's output plus a newline), in each
 * version of the bridge definition. Placeholders are the values that varied
 * per agent: the bridge path, the port, the agent id and the nonce.
 */
const PLACEHOLDERS: Record<string, string> = {
  PATH: String.raw`(?:[^"\\\n]|\\\\)*(?:/|\\\\)clubhouse-mcp-bridge\.js`,
  PORT: String.raw`\d{1,5}`,
  AGENT_ID: String.raw`[A-Za-z0-9_.:-]+`,
  NONCE: String.raw`[0-9A-Fa-f-]+`,
};
const BRIDGE_TEMPLATES: readonly string[] = [
  // March 2026 (#1028) to #2222: port, agent id and nonce in env.
  `[mcp_servers.clubhouse]
command = "node"
args = ["{PATH}"]

[mcp_servers.clubhouse.env]
CLUBHOUSE_MCP_PORT = "{PORT}"
CLUBHOUSE_AGENT_ID = "{AGENT_ID}"
CLUBHOUSE_HOOK_NONCE = "{NONCE}"`,
  // The same file after a snapshot restore scrubbed its nonce (#2222).
  `[mcp_servers.clubhouse]
command = "node"
args = ["{PATH}"]

[mcp_servers.clubhouse.env]
CLUBHOUSE_MCP_PORT = "{PORT}"
CLUBHOUSE_AGENT_ID = "{AGENT_ID}"`,
  // #2222 onward: fallback port and agent id in env, the rest forwarded by name.
  `[mcp_servers.clubhouse]
command = "node"
args = ["{PATH}"]
env_vars = ["CLUBHOUSE_AGENT_ID", "CLUBHOUSE_HOOK_NONCE", "CLUBHOUSE_MCP_PORT"]

[mcp_servers.clubhouse.env]
CLUBHOUSE_MCP_FALLBACK_PORT = "{PORT}"
CLUBHOUSE_MCP_FALLBACK_AGENT_ID = "{AGENT_ID}"`,
];
const BRIDGE_TEMPLATE_RES = BRIDGE_TEMPLATES.map((template) => new RegExp(`^${template
  .split(/(\{[A-Z_]+\})/)
  .map((part) => (/^\{[A-Z_]+\}$/.test(part) ? PLACEHOLDERS[part.slice(1, -1)] : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  .join('')}$`));

/** Whether a whole file is one Clubhouse wrote, line endings and trailing whitespace aside. */
export function isClubhouseBridgeOnlyToml(toml: string): boolean {
  const normalized = toml.replace(/\r\n/g, '\n').split('\n').map((line) => line.trimEnd()).join('\n').trimEnd();
  return BRIDGE_TEMPLATE_RES.some((template) => template.test(normalized));
}

/**
 * Delete a `.codex/config.toml` an older Clubhouse wrote holding only its
 * MCP bridge (#1728), and the folder when that leaves it empty. Codex takes
 * the bridge as launch flags, and the file only made a `.codex` folder Codex
 * asks the user to trust. Any other file, a bridge file someone edited
 * included, is left exactly as it is.
 */
export async function stripLegacyClubhouseBridgeToml(
  worktreePath: string,
  conv: SettingsConventions,
): Promise<boolean> {
  const filePath = path.join(worktreePath, conv.mcpConfigFile);
  let content: string;
  try {
    content = await fsp.readFile(filePath, 'utf-8');
  } catch {
    // telemetry-exempt: no file means nothing an older Clubhouse left behind
    return false;
  }
  if (!isClubhouseBridgeOnlyToml(content)) return false;
  await fsp.unlink(filePath);
  try {
    // rmdir only removes an empty folder, so other config files stay.
    await fsp.rmdir(path.dirname(filePath));
  } catch {
    // telemetry-exempt: the folder holds other files, which stay
  }
  appLog('core:materialization', 'info', 'Removed the Clubhouse MCP config an older version wrote', {
    meta: { filePath },
  });
  return true;
}
