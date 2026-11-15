import * as fsp from 'fs/promises';
import * as path from 'path';
import type { SettingsConventions } from './agent-settings-service';
import { appLog } from './log-service';
import { stripClubhouseMcpToml } from './clubhouse-mcp/injection';

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

/** The bridge script every injected Clubhouse MCP entry runs, wherever the app is installed. */
const BRIDGE_SCRIPT_MARKER = 'clubhouse-mcp-bridge.js';

/**
 * Remove the `[mcp_servers.clubhouse]` section an older Clubhouse injected
 * into a TOML CLI's MCP config (#1728). Codex takes the bridge as launch
 * flags, and the file only made a `.codex` folder Codex asks the user to
 * trust. Only a section that runs the bridge script is removed, so a user's
 * own server named `clubhouse` stays. The file is deleted only when nothing
 * else is left, and its folder only when that leaves it empty. A file that
 * can't be read is left alone.
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
  if (!hasInjectedBridgeSection(content)) return false;

  const stripped = stripClubhouseMcpToml(content);
  if (stripped.trim() === '') {
    await fsp.unlink(filePath);
    try {
      // rmdir only removes an empty folder, so other config files stay.
      await fsp.rmdir(path.dirname(filePath));
    } catch {
      // telemetry-exempt: the folder holds other files, which stay
    }
  } else {
    await fsp.writeFile(filePath, stripped.replace(/\n*$/, '\n'), 'utf-8');
  }
  appLog('core:materialization', 'info', 'Removed the Clubhouse MCP entry an older version wrote to a TOML config', {
    meta: { filePath, deleted: stripped.trim() === '' },
  });
  return true;
}

/** Whether the `[mcp_servers.clubhouse]` section (and its subtables) runs the bridge script. */
function hasInjectedBridgeSection(toml: string): boolean {
  let inSection = false;
  let found = false;
  for (const line of toml.split('\n')) {
    const header = line.match(/^\[([^\]]+)\]/);
    if (header) {
      inSection = header[1] === 'mcp_servers.clubhouse' || header[1].startsWith('mcp_servers.clubhouse.');
      continue;
    }
    if (inSection && line.includes(BRIDGE_SCRIPT_MARKER)) found = true;
  }
  return found;
}
