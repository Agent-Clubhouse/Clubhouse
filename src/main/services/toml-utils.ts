/**
 * Lightweight TOML helpers for MCP server config.
 *
 * Codex CLI stores MCP servers in `.codex/config.toml` using this format:
 *
 *   [mcp_servers.my-server]
 *   command = "node"
 *   args = ["/path/to/script.js"]
 *
 *   [mcp_servers.my-server.env]
 *   KEY = "VALUE"
 *
 * These helpers serialize/deserialize that specific structure without
 * requiring a full TOML parser library.
 */

import type { McpServerDef } from '../../shared/types';

// ── TOML value serialization ────────────────────────────────────────────────

/** Escape a TOML string value (basic strings only). */
function tomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/** Serialize a string array to TOML inline array format. */
function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

// ── MCP server serialization ────────────────────────────────────────────────

/**
 * Serialize a single MCP server definition to TOML lines.
 * Returns lines WITHOUT a trailing newline so callers can join as needed.
 */
export function mcpServerToToml(name: string, def: McpServerDef): string {
  const lines: string[] = [];
  lines.push(`[mcp_servers.${name}]`);

  if (def.type) {
    lines.push(`type = ${tomlString(def.type)}`);
  }
  if (def.command) {
    lines.push(`command = ${tomlString(def.command)}`);
  }
  if (def.args && def.args.length > 0) {
    lines.push(`args = ${tomlStringArray(def.args)}`);
  }
  if (def.url) {
    lines.push(`url = ${tomlString(def.url)}`);
  }

  if (def.env && Object.keys(def.env).length > 0) {
    lines.push('');
    lines.push(`[mcp_servers.${name}.env]`);
    for (const [key, value] of Object.entries(def.env)) {
      lines.push(`${key} = ${tomlString(value)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Convert a JSON MCP config string to TOML format.
 * Expects the standard `{ "mcpServers": { ... } }` shape.
 * Returns the TOML string, or null if the input is invalid.
 */
export function jsonMcpToToml(jsonStr: string): string | null {
  try {
    const parsed = JSON.parse(jsonStr);
    const servers: Record<string, McpServerDef> = parsed.mcpServers || parsed.mcp_servers || {};
    if (Object.keys(servers).length === 0) return null;

    const sections = Object.entries(servers).map(([name, def]) =>
      mcpServerToToml(name, def),
    );
    return sections.join('\n\n') + '\n';
  } catch {
    return null;
  }
}

// ── TOML section management ─────────────────────────────────────────────────

/**
 * Pattern that matches a `[mcp_servers.<name>]` section header and all
 * subsequent lines up to the next top-level section header or EOF.
 * Also matches sub-sections like `[mcp_servers.<name>.env]`.
 */
function mcpServerSectionPattern(name: string): RegExp {
  // Escape dots and other regex-special chars in the name
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match [mcp_servers.<name>] or [mcp_servers.<name>.<sub>] headers
  // and all lines until the next top-level section (not a sub-section of this server)
  return new RegExp(
    `(?:^|\\n)(\\[mcp_servers\\.${escaped}(?:\\.[^\\]]*)?\\](?:[^\\[]|\\[(?!(?:[a-z_]|mcp_servers\\.(?!${escaped}(?:\\.|\\])))))*?)(?=\\n\\[(?!mcp_servers\\.${escaped})|$)`,
    'g',
  );
}

/**
 * Remove all `[mcp_servers.<name>]` sections (and sub-sections) from a TOML string.
 */
export function stripMcpServerSection(toml: string, serverName: string): string {
  // Split into lines and rebuild, skipping lines that belong to the target server
  const lines = toml.split('\n');
  const result: string[] = [];
  let skipping = false;
  const headerRe = /^\[([^\]]+)\]/;
  const targetPrefix = `mcp_servers.${serverName}`;

  for (const line of lines) {
    const match = line.match(headerRe);
    if (match) {
      const sectionKey = match[1];
      if (sectionKey === targetPrefix || sectionKey.startsWith(targetPrefix + '.')) {
        skipping = true;
        continue;
      } else {
        skipping = false;
      }
    }
    if (!skipping) {
      result.push(line);
    }
  }

  // Clean up trailing blank lines from removal
  let text = result.join('\n');
  // Collapse runs of 3+ newlines to 2
  text = text.replace(/\n{3,}/g, '\n\n');
  return text;
}

/**
 * Inject an MCP server section into a TOML string, replacing any existing
 * section with the same name.
 */
export function injectMcpServerSection(toml: string, name: string, def: McpServerDef): string {
  // First strip any existing section for this server
  let cleaned = stripMcpServerSection(toml, name);

  // Ensure the content ends with exactly one newline before appending
  cleaned = cleaned.trimEnd();
  if (cleaned.length > 0) {
    cleaned += '\n\n';
  }

  cleaned += mcpServerToToml(name, def) + '\n';
  return cleaned;
}
