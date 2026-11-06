import type { McpServerDef } from './types';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate desired configuration without probing a server or exposing its values. */
export function parseMcpJson(raw: string): Record<string, McpServerDef> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    throw new Error('Invalid MCP JSON. Repair and save the MCP configuration before starting.');
  }
  if (!record(parsed) || !record(parsed.mcpServers)) {
    throw new Error('MCP configuration must contain an mcpServers object (use {} for no servers).');
  }
  for (const [name, server] of Object.entries(parsed.mcpServers)) {
    const invalid = (reason: string): never => { throw new Error(`MCP server "${name}": ${reason}`); };
    if (!record(server)) invalid('expected a server object.');
    const def = server as Record<string, unknown>;
    const transport = def.type;
    if (transport !== undefined && !['stdio', 'http', 'sse', 'streamable-http'].includes(transport as string)) {
      invalid('unsupported transport. Use stdio, http, sse or streamable-http.');
    }
    const stdio = transport === 'stdio' || (transport === undefined && def.command !== undefined);
    if (stdio) {
      if (typeof def.command !== 'string' || !def.command.trim() || def.url !== undefined) invalid('stdio requires a command and no URL.');
    } else if (typeof def.url !== 'string' || !def.url.trim() || def.command !== undefined) {
      invalid('HTTP/SSE requires a URL and no command.');
    }
    for (const field of ['args', 'env_vars']) {
      if (def[field] !== undefined && (!Array.isArray(def[field]) || !(def[field] as unknown[]).every((v) => typeof v === 'string'))) invalid(`${field} must be a string array.`);
    }
    for (const field of ['env', 'headers']) {
      if (def[field] !== undefined && (!record(def[field]) || !Object.values(def[field] as object).every((v) => typeof v === 'string'))) invalid(`${field} must contain string values.`);
    }
  }
  return parsed.mcpServers as Record<string, McpServerDef>;
}
