/**
 * MCP Config Injection — injects Clubhouse MCP server entry into
 * the agent's .mcp.json (or orchestrator-equivalent) config file.
 *
 * The agent's nonce is never written here (#2222). Any process that can read
 * an agent's worktree could otherwise call Clubhouse MCP tools as that agent.
 * Nor is its identity: quick agents share their parent's worktree, so a file
 * agent ID would be whichever agent wrote last. The nonce, agent ID and port
 * travel only in the spawned CLI's environment (CLUBHOUSE_BRIDGE_ENV_VARS),
 * and the bridge script reads them from the environment it inherits from the
 * CLI:
 *   - Claude Code (PTY, Agent SDK, stream-json) and Copilot CLI pass their
 *     whole environment to stdio MCP servers.
 *   - Codex starts stdio servers with a minimal environment, so the entry
 *     names the variables in `env_vars` and Codex forwards them.
 *   - ACP agents get exactly the env pairs in `session/new`; the ACP driver
 *     fills `env_vars` from the CLI's env and sends the values over the RPC
 *     pipe (see toAcpMcpServers), never in a config file or argv. The ACP
 *     client redacts those values from its request log.
 * The file holds only the port and agent ID under fallback names, used by
 * the bridge when its env has none.
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

/** Commands that should never be allowed as MCP server commands. */
const DANGEROUS_COMMANDS = new Set([
  'bash', 'sh', 'zsh', 'fish', 'csh', 'ksh', 'dash',
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh',
  'curl', 'wget', 'eval', 'exec',
]);

/** Shell metacharacters that should not appear in MCP server args. */
const SHELL_META_RE = /[`$|;&<>(){}!\n\r]/;

/**
 * The variable carrying an agent's MCP/hook nonce. Set only in the spawned
 * CLI's environment; config files name it, never hold its value.
 */
export const CLUBHOUSE_NONCE_ENV = 'CLUBHOUSE_HOOK_NONCE';

/**
 * What the bridge needs from the agent CLI's environment. Clubhouse sets all
 * three on every agent's spawn env; Codex forwards them by name (env_vars).
 */
export const CLUBHOUSE_BRIDGE_ENV_VARS: readonly string[] = ['CLUBHOUSE_AGENT_ID', CLUBHOUSE_NONCE_ENV, 'CLUBHOUSE_MCP_PORT'];

/**
 * Fallback names written into the bridge entry, read by the bridge only when
 * the env has no CLUBHOUSE_AGENT_ID / CLUBHOUSE_MCP_PORT. They use their own
 * names because a config `env` value overrides the inherited one, which would
 * let the last agent to write a shared worktree's file speak for all of them.
 */
export const CLUBHOUSE_FALLBACK_AGENT_ID_ENV = 'CLUBHOUSE_MCP_FALLBACK_AGENT_ID';
export const CLUBHOUSE_FALLBACK_PORT_ENV = 'CLUBHOUSE_MCP_FALLBACK_PORT';

/** `${VAR}`, `$VAR` or `%VAR%`: a reference to a variable, not a stored value. */
export function isEnvReference(value: unknown): boolean {
  return typeof value === 'string' && /^(?:\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*|%[^%]+%)$/.test(value);
}

/** The bridge entry: no nonce, and identity only as a fallback (see top). */
function bridgeServerDef(mcpPort: number, agentId: string): McpServerDef {
  return {
    command: 'node',
    args: [getBridgeScriptPath()],
    env: {
      [CLUBHOUSE_FALLBACK_PORT_ENV]: String(mcpPort),
      [CLUBHOUSE_FALLBACK_AGENT_ID_ENV]: agentId,
    },
    env_vars: [...CLUBHOUSE_BRIDGE_ENV_VARS],
  };
}

/** Allowed top-level keys for an MCP server definition. */
const ALLOWED_MCP_KEYS = new Set(['command', 'args', 'env', 'type', 'url']);

/**
 * Validate an MCP server definition from a plugin template.
 * Throws if the definition is malformed or contains potentially malicious content.
 */
export function validateMcpServerDef(name: string, def: unknown): asserts def is McpServerDef {
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    throw new Error(`MCP server "${name}": definition must be a non-null object`);
  }
  const obj = def as Record<string, unknown>;

  // Reject unknown keys
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_MCP_KEYS.has(key)) {
      throw new Error(`MCP server "${name}": unknown property "${key}"`);
    }
  }

  // Validate command
  if (obj.command !== undefined) {
    if (typeof obj.command !== 'string' || obj.command.length === 0) {
      throw new Error(`MCP server "${name}": command must be a non-empty string`);
    }
    const cmdBase = path.basename(obj.command).toLowerCase();
    if (DANGEROUS_COMMANDS.has(cmdBase)) {
      throw new Error(`MCP server "${name}": command "${obj.command}" is not allowed`);
    }
    if (SHELL_META_RE.test(obj.command)) {
      throw new Error(`MCP server "${name}": command contains shell metacharacters`);
    }
  }

  // Validate args
  if (obj.args !== undefined) {
    if (!Array.isArray(obj.args)) {
      throw new Error(`MCP server "${name}": args must be an array`);
    }
    for (let i = 0; i < obj.args.length; i++) {
      const arg = obj.args[i];
      if (typeof arg !== 'string') {
        throw new Error(`MCP server "${name}": args[${i}] must be a string`);
      }
      if (SHELL_META_RE.test(arg)) {
        throw new Error(`MCP server "${name}": args[${i}] contains shell metacharacters`);
      }
    }
  }

  // Validate env
  if (obj.env !== undefined) {
    if (!obj.env || typeof obj.env !== 'object' || Array.isArray(obj.env)) {
      throw new Error(`MCP server "${name}": env must be an object`);
    }
    for (const [k, v] of Object.entries(obj.env as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        throw new Error(`MCP server "${name}": env["${k}"] must be a string`);
      }
    }
  }

  // Validate type
  if (obj.type !== undefined && typeof obj.type !== 'string') {
    throw new Error(`MCP server "${name}": type must be a string`);
  }

  // Validate url
  if (obj.url !== undefined && typeof obj.url !== 'string') {
    throw new Error(`MCP server "${name}": url must be a string`);
  }
}

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

/**
 * Async mutex for serializing concurrent config writes.
 * Each caller appends to the tail of a single promise chain,
 * ensuring strictly sequential execution even if multiple calls
 * arrive in the same microtask.
 */
let lockTail: Promise<void> = Promise.resolve();

function withInjectionLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = lockTail;
  let resolve: () => void;
  lockTail = new Promise<void>((r) => { resolve = r; });
  return prev.then(async () => {
    try { return await fn(); }
    finally { resolve!(); }
  });
}

/**
 * Inject the Clubhouse MCP server entry into the agent's MCP config.
 * The bridge script path is resolved relative to the app bundle.
 */
export function injectClubhouseMcp(
  cwd: string,
  agentId: string,
  mcpPort: number,
  conventions?: Partial<SettingsConventions>,
): Promise<void> {
  return withInjectionLock(() =>
    injectClubhouseMcpImpl(cwd, agentId, mcpPort, conventions),
  );
}

async function injectClubhouseMcpImpl(
  cwd: string,
  agentId: string,
  mcpPort: number,
  conventions?: Partial<SettingsConventions>,
): Promise<void> {
  if (!isMcpEnabled()) {
    return; // Feature not enabled
  }

  validateBridgeScript();

  const conv = { ...DEFAULT_CONVENTIONS, ...conventions };

  // No nonce, and no identity a sibling's would be shadowed by (see top).
  const serverDef = bridgeServerDef(mcpPort, agentId);

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

  // Inject the clubhouse MCP server section (replacing any older one, nonce
  // included), and drop nonces an older Clubhouse left elsewhere in the file.
  const updated = injectMcpServerSection(scrubClubhouseNonceToml(existing), 'clubhouse', serverDef);

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

  // Migration (#2222): an older Clubhouse stored the nonce and agent ID in
  // this file. The clubhouse entry is replaced below; scrub any other copy.
  scrubClubhouseNonce(config);
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
 * Inject arbitrary MCP server entries into an agent's .mcp.json.
 * Used to wire plugin-template-contributed MCP servers during agent creation.
 * Merges the provided servers into the existing config without overwriting
 * other entries (except entries with the same name, which are replaced).
 */
export function injectTemplateMcpServers(
  cwd: string,
  servers: Record<string, unknown>,
  conventions?: Partial<SettingsConventions>,
): Promise<void> {
  return withInjectionLock(async () => {
    const conv = { ...DEFAULT_CONVENTIONS, ...conventions };
    const mcpConfigPath = path.join(cwd, conv.mcpConfigFile);

    // Read existing config
    let config: Record<string, unknown> = {};
    try {
      const raw = await fsp.readFile(mcpConfigPath, 'utf-8');
      config = JSON.parse(raw);
    } catch {
      // File doesn't exist or invalid JSON — start fresh
    }

    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      config.mcpServers = {};
    }
    const existing = config.mcpServers as Record<string, unknown>;
    for (const [name, def] of Object.entries(servers)) {
      validateMcpServerDef(name, def);
      existing[name] = def;
    }

    // Write atomically
    const dir = path.dirname(mcpConfigPath);
    if (!(await pathExists(dir))) {
      await fsp.mkdir(dir, { recursive: true });
    }
    const tmpPath = mcpConfigPath + '.tmp.' + randomUUID().slice(0, 8);
    await fsp.writeFile(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
    await fsp.rename(tmpPath, mcpConfigPath);

    appLog('core:mcp', 'info', 'Injected template MCP servers into config', {
      meta: { cwd, serverNames: Object.keys(servers), configPath: mcpConfigPath },
    });
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
 * Remove stored Clubhouse credentials from a parsed MCP config (`mcpServers`
 * or Codex-style `mcp_servers`), as Clubhouse versions before #2222 wrote
 * them:
 *   - a literal CLUBHOUSE_HOOK_NONCE in any server's `env`;
 *   - a literal CLUBHOUSE_AGENT_ID / CLUBHOUSE_MCP_PORT in a bridge entry's
 *     `env`, which would override the agent's own inherited values.
 * References (`${VAR}`, `$VAR`, `%VAR%`) are the user's and are kept.
 * Mutates and returns the config.
 */
export function scrubClubhouseNonce<T extends Record<string, unknown>>(config: T): T {
  for (const key of ['mcpServers', 'mcp_servers']) {
    const servers = config[key];
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) continue;
    for (const entry of Object.values(servers as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue;
      const env = (entry as Record<string, unknown>).env;
      if (!env || typeof env !== 'object' || Array.isArray(env)) continue;
      const names = isClubhouseMcpEntry(entry) ? CLUBHOUSE_BRIDGE_ENV_VARS : [CLUBHOUSE_NONCE_ENV];
      const vars = env as Record<string, unknown>;
      for (const name of names) {
        if (name in vars && !isEnvReference(vars[name])) delete vars[name];
      }
    }
  }
  return config;
}

/** `CLUBHOUSE_HOOK_NONCE = "…"` as a whole line, under any table or dotted key. */
const TOML_NONCE_LINE_RE = /^[ \t]*(?:[\w.-]+\.)?["']?CLUBHOUSE_HOOK_NONCE["']?[ \t]*=[ \t]*(["'])(.*?)\1[ \t]*(?:#.*)?$/;
/** The same pair inside an inline table, with the comma on either side. */
const TOML_NONCE_PAIR_RE = /(,[ \t]*)?["']?CLUBHOUSE_HOOK_NONCE["']?[ \t]*=[ \t]*(["'])(.*?)\2([ \t]*,[ \t]*)?/g;

/**
 * The TOML counterpart of scrubClubhouseNonce: drops literal nonce
 * assignments, as lines or inline-table pairs. References are kept.
 */
export function scrubClubhouseNonceToml(toml: string): string {
  const out: string[] = [];
  for (const line of toml.split('\n')) {
    const whole = line.match(TOML_NONCE_LINE_RE);
    if (whole) {
      if (!isEnvReference(whole[2])) continue;
      out.push(line);
      continue;
    }
    out.push(line.includes('{')
      ? line.replace(TOML_NONCE_PAIR_RE, (pair, before: string | undefined, _q, value: string, after: string | undefined) =>
        isEnvReference(value) ? pair : (before && after ? ', ' : ''))
      : line);
  }
  return out.join('\n');
}

/**
 * Build the Clubhouse MCP server definition for use in CLI args or a chat
 * driver's session config. It carries no nonce: the bridge reads
 * CLUBHOUSE_HOOK_NONCE, CLUBHOUSE_AGENT_ID and CLUBHOUSE_MCP_PORT from the
 * environment it inherits from the CLI, which the caller must set on the
 * CLI's spawn env (#2222). Keeping it out of the
 * definition also keeps it out of argv (`--mcp-config`, Codex `-c`, Copilot
 * `--additional-mcp-config`) and the spawn log.
 */
export function buildClubhouseMcpDef(mcpPort: number, agentId: string): McpServerDef {
  validateBridgeScript();
  return { type: 'stdio', ...bridgeServerDef(mcpPort, agentId) };
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
