/**
 * MCP Config Injection — injects Clubhouse MCP server entry into
 * the agent's .mcp.json (or orchestrator-equivalent) config file.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { appLog } from '../log-service';
import { pathExists } from '../fs-utils';
import { isMcpEnabled } from '../mcp-settings';
import { injectMcpServerSection, stripMcpServerSection } from '../toml-utils';
import type { McpServerDef } from '../../../shared/types';

interface SettingsConventions {
  configDir: string;
  mcpConfigFile: string;
  settingsFormat?: 'json' | 'toml';
}

const DEFAULT_CONVENTIONS: SettingsConventions = {
  configDir: '.claude',
  mcpConfigFile: '.mcp.json',
};

let bridgeScriptValidated = false;

function validateBridgeScript(): void {
  if (bridgeScriptValidated) return;
  const scriptPath = getBridgeScriptPath();
  if (!existsSync(scriptPath)) {
    appLog('core:mcp', 'error', 'Bridge script not found', { meta: { path: scriptPath } });
    throw new Error(`MCP bridge script not found at ${scriptPath}`);
  }
  bridgeScriptValidated = true;
}

/** Serialize concurrent config writes to prevent read-modify-write races. */
let injectionLock: Promise<void> = Promise.resolve();

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
  // Queue behind any in-flight injection
  const previousLock = injectionLock;
  let releaseLock: () => void;
  injectionLock = new Promise((resolve) => { releaseLock = resolve; });
  await previousLock;
  try {
    await injectClubhouseMcpImpl(cwd, agentId, mcpPort, nonce, conventions);
  } finally {
    releaseLock!();
  }
}

async function injectClubhouseMcpImpl(
  cwd: string,
  agentId: string,
  mcpPort: number,
  nonce: string,
  conventions?: Partial<SettingsConventions>,
): Promise<void> {
  if (!isMcpEnabled()) {
    return; // Feature not enabled
  }

  validateBridgeScript();

  const conv = { ...DEFAULT_CONVENTIONS, ...conventions };

  // Resolve bridge script path
  const bridgeScriptPath = getBridgeScriptPath();

  const serverDef: McpServerDef = {
    command: 'node',
    args: [bridgeScriptPath],
    env: {
      CLUBHOUSE_MCP_PORT: String(mcpPort),
      CLUBHOUSE_AGENT_ID: agentId,
      CLUBHOUSE_HOOK_NONCE: nonce,
    },
  };

  // Determine the MCP config file path
  const mcpConfigPath = path.join(cwd, conv.mcpConfigFile);

  if (conv.settingsFormat === 'toml') {
    await injectTomlMcp(mcpConfigPath, agentId, serverDef);
  } else {
    await injectJsonMcp(mcpConfigPath, agentId, serverDef);
  }
}

async function injectTomlMcp(
  mcpConfigPath: string,
  agentId: string,
  serverDef: McpServerDef,
): Promise<void> {
  // Read existing TOML content (if any)
  let existing = '';
  try {
    existing = await fsp.readFile(mcpConfigPath, 'utf-8');
  } catch {
    // File doesn't exist — start fresh
  }

  // Inject the clubhouse MCP server section
  const updated = injectMcpServerSection(existing, 'clubhouse', serverDef);

  // Write atomically
  const dir = path.dirname(mcpConfigPath);
  if (!(await pathExists(dir))) {
    await fsp.mkdir(dir, { recursive: true });
  }
  const tmpPath = mcpConfigPath + '.tmp.' + randomUUID().slice(0, 8);
  await fsp.writeFile(tmpPath, updated, 'utf-8');
  await fsp.rename(tmpPath, mcpConfigPath);

  appLog('core:mcp', 'info', 'Injected Clubhouse MCP into TOML config', {
    meta: { agentId, configPath: mcpConfigPath },
  });
}

async function injectJsonMcp(
  mcpConfigPath: string,
  agentId: string,
  serverDef: McpServerDef,
): Promise<void> {
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
  mcpServers['clubhouse'] = serverDef;

  // Write config atomically (write to temp, then rename)
  const dir = path.dirname(mcpConfigPath);
  if (!(await pathExists(dir))) {
    await fsp.mkdir(dir, { recursive: true });
  }
  const tmpPath = mcpConfigPath + '.tmp.' + randomUUID().slice(0, 8);
  await fsp.writeFile(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
  await fsp.rename(tmpPath, mcpConfigPath);

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
 * Strip the Clubhouse MCP entry from a TOML config string.
 * Removes [mcp_servers.clubhouse] and its sub-sections.
 */
export function stripClubhouseMcpToml(toml: string): string {
  return stripMcpServerSection(toml, 'clubhouse');
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
 * Build the Clubhouse MCP server definition for use in CLI args or config files.
 */
export function buildClubhouseMcpDef(mcpPort: number, agentId: string, nonce: string): McpServerDef {
  validateBridgeScript();
  return {
    type: 'stdio',
    command: 'node',
    args: [getBridgeScriptPath()],
    env: {
      CLUBHOUSE_MCP_PORT: String(mcpPort),
      CLUBHOUSE_AGENT_ID: agentId,
      CLUBHOUSE_HOOK_NONCE: nonce,
    },
  };
}

/**
 * Resolve the bridge script path. The script is copied to the webpack output
 * during build. In production it is unpacked from the asar archive so that
 * it can be spawned as a child process by `node`.
 */
export function getBridgeScriptPath(): string {
  // __dirname points inside the asar in production (e.g. .../app.asar/.webpack/main).
  // The bridge script is asar-unpacked so it can be executed by node as a child process.
  // Replace 'app.asar' with 'app.asar.unpacked' to get the real filesystem path.
  const asarPath = path.join(__dirname, 'bridge', 'clubhouse-mcp-bridge.js');
  return asarPath.replace('app.asar', 'app.asar.unpacked');
}
