/**
 * MCP Config Injection — injects Clubhouse MCP server entry into
 * the agent's .mcp.json (or orchestrator-equivalent) config file.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { appLog } from '../log-service';
import { pathExists } from '../fs-utils';
import * as experimentalSettings from '../experimental-settings';
import type { McpServerDef } from '../../../shared/types';

interface SettingsConventions {
  configDir: string;
  mcpConfigFile: string;
}

const DEFAULT_CONVENTIONS: SettingsConventions = {
  configDir: '.claude',
  mcpConfigFile: '.mcp.json',
};

/**
 * Inject the Clubhouse MCP server entry into the agent's MCP config.
 * The bridge script path is resolved relative to the app bundle.
 */
export async function injectClubhouseMcp(
  cwd: string,
  agentId: string,
  mcpPort: number,
  nonce: string,
  conventions?: Partial<SettingsConventions>,
): Promise<void> {
  const expSettings = experimentalSettings.getSettings();
  if (!expSettings.clubhouseMcp) {
    return; // Feature not enabled
  }

  const conv = { ...DEFAULT_CONVENTIONS, ...conventions };

  // Determine the MCP config file path
  const mcpConfigPath = path.join(cwd, conv.mcpConfigFile);

  // Read existing config
  let config: Record<string, unknown> = {};
  try {
    const raw = await fsp.readFile(mcpConfigPath, 'utf-8');
    config = JSON.parse(raw);
  } catch {
    // File doesn't exist or invalid JSON — start fresh
  }

  // Ensure mcpServers object exists
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }

  const mcpServers = config.mcpServers as Record<string, McpServerDef>;

  // Resolve bridge script path
  const bridgeScriptPath = getBridgeScriptPath();

  // Add Clubhouse MCP entry
  mcpServers['clubhouse'] = {
    command: 'node',
    args: [bridgeScriptPath],
    env: {
      CLUBHOUSE_MCP_PORT: String(mcpPort),
      CLUBHOUSE_AGENT_ID: agentId,
      CLUBHOUSE_HOOK_NONCE: nonce,
    },
  };

  // Write config back
  const dir = path.dirname(mcpConfigPath);
  if (!(await pathExists(dir))) {
    await fsp.mkdir(dir, { recursive: true });
  }
  await fsp.writeFile(mcpConfigPath, JSON.stringify(config, null, 2), 'utf-8');

  appLog('core:mcp', 'info', 'Injected Clubhouse MCP into config', {
    meta: { agentId, configPath: mcpConfigPath },
  });
}

/**
 * Check if a parsed MCP config entry is the Clubhouse bridge.
 */
export function isClubhouseMcpEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const obj = entry as Record<string, unknown>;
  if (obj.command !== 'node') return false;
  const args = obj.args;
  if (!Array.isArray(args)) return false;
  return args.some((a: unknown) =>
    typeof a === 'string' && a.includes('clubhouse-mcp-bridge'),
  );
}

/**
 * Strip the Clubhouse MCP entry from a config object.
 */
export function stripClubhouseMcp(config: Record<string, unknown>): Record<string, unknown> {
  const servers = config.mcpServers;
  if (!servers || typeof servers !== 'object') return config;

  const cleaned: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
    if (!isClubhouseMcpEntry(entry)) {
      cleaned[name] = entry;
    }
  }

  return { ...config, mcpServers: cleaned };
}

/**
 * Resolve the bridge script path. The script lives alongside the compiled
 * main process code in production, or in the source tree during development.
 */
function getBridgeScriptPath(): string {
  // In production, __dirname is inside the asar archive or compiled output
  // The bridge script is copied to the same directory during build
  return path.join(__dirname, 'bridge', 'clubhouse-mcp-bridge.js');
}
