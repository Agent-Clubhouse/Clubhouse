import type { ProjectAgentDefaults } from './types';

/**
 * What a plugin puts in a project's agent defaults (#3262), sent as a patch:
 * a key that's missing leaves that part alone, `null` removes it, and a value
 * replaces everything that plugin had there.
 */
export interface PluginAgentDefaultsParts {
  /** The content of the plugin's instruction block. */
  instructions?: string | null;
  /** The plugin's allow rules, untagged. */
  allow?: string[] | null;
  /** The plugin's deny rules, untagged. */
  deny?: string[] | null;
  /** The plugin's MCP servers under their own names, unprefixed. */
  mcpServers?: Record<string, unknown> | null;
}

/** Every part a plugin can have, all removed: what uninstalling it clears. */
export const ALL_PLUGIN_PARTS_REMOVED: PluginAgentDefaultsParts = { instructions: null, allow: null, deny: null, mcpServers: null };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function pluginPermissionTag(pluginId: string): string {
  return `/* plugin:${pluginId} */`;
}

export function pluginMcpPrefix(pluginId: string): string {
  return `plugin-${pluginId}-`;
}

/**
 * `current` with this plugin's parts replaced, or null when nothing changes.
 * Everything that isn't this plugin's is kept as it is.
 */
export function withPluginParts(
  current: ProjectAgentDefaults,
  pluginId: string,
  parts: PluginAgentDefaultsParts,
): ProjectAgentDefaults | null {
  const next: ProjectAgentDefaults = { ...current };
  let changed = false;

  if (parts.instructions !== undefined) {
    const id = escapeRegExp(pluginId);
    const existing = current.instructions || '';
    const cleaned = existing.replace(new RegExp(`\\n?\\n?<!-- plugin:${id}:start -->[\\s\\S]*?<!-- plugin:${id}:end -->`), '');
    const updated = parts.instructions === null
      ? cleaned
      : `${cleaned}\n\n<!-- plugin:${pluginId}:start -->\n${parts.instructions}\n<!-- plugin:${pluginId}:end -->`;
    if (updated !== existing) {
      next.instructions = updated;
      changed = true;
    }
  }

  const tag = pluginPermissionTag(pluginId);
  for (const kind of ['allow', 'deny'] as const) {
    const rules = parts[kind];
    if (rules === undefined) continue;
    const existing = current.permissions?.[kind] || [];
    const updated = [...existing.filter((r) => !r.includes(tag)), ...(rules ?? []).map((r) => `${r} ${tag}`)];
    if (JSON.stringify(updated) !== JSON.stringify(existing)) {
      next.permissions = { ...next.permissions, [kind]: updated };
      changed = true;
    }
  }

  if (parts.mcpServers !== undefined) {
    const prefix = pluginMcpPrefix(pluginId);
    let mcpConfig: Record<string, unknown> = {};
    if (current.mcpJson) {
      try { mcpConfig = JSON.parse(current.mcpJson); } catch { /* replaced, as before #3262 */ }
    }
    const servers = (mcpConfig.mcpServers as Record<string, unknown>) || {};
    const kept = Object.entries(servers).filter(([name]) => !name.startsWith(prefix));
    const added = Object.entries(parts.mcpServers ?? {}).map(([name, config]): [string, unknown] => [`${prefix}${name}`, config]);
    const before = Object.entries(servers).filter(([name]) => name.startsWith(prefix));
    if (JSON.stringify(before) !== JSON.stringify(added)) {
      next.mcpJson = JSON.stringify({ ...mcpConfig, mcpServers: Object.fromEntries([...kept, ...added]) }, null, 2);
      changed = true;
    }
  }

  return changed ? next : null;
}

/** Throws unless `value` is a well-formed PluginAgentDefaultsParts, from across IPC. */
export function assertPluginAgentDefaultsParts(value: unknown): asserts value is PluginAgentDefaultsParts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Plugin agent defaults must be an object.');
  for (const [key, part] of Object.entries(value)) {
    if (part === null || part === undefined) {
      if (!['instructions', 'allow', 'deny', 'mcpServers'].includes(key)) throw new Error(`Unknown plugin agent default: ${key}`);
      continue;
    }
    if (key === 'instructions') {
      if (typeof part !== 'string') throw new Error('Plugin instructions must be text.');
    } else if (key === 'allow' || key === 'deny') {
      if (!Array.isArray(part) || part.some((r) => typeof r !== 'string')) throw new Error(`Plugin ${key} rules must be a list of text.`);
    } else if (key === 'mcpServers') {
      if (typeof part !== 'object' || Array.isArray(part)) throw new Error('Plugin MCP servers must be an object.');
    } else {
      throw new Error(`Unknown plugin agent default: ${key}`);
    }
  }
}
