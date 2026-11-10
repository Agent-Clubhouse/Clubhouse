/**
 * The project's legacy agent defaults (#3245): instructions, permissions, MCP
 * JSON and build/test/lint commands saved under `agentDefaults` before
 * Clubhouse-managed agents. They're read-only now. Each can be imported as
 * parts or copied into a plain agent, always previewed first, and stay saved
 * so nothing is lost while they're retired.
 */

/** A plugin's share of a legacy value, which stays the plugin's. */
export interface LegacyPluginItem {
  pluginId: string;
  /** The instruction text, permission rule or MCP server key. */
  label: string;
}

export interface LegacyDefaultsSummary {
  /** True when any legacy value is saved. */
  hasValues: boolean;
  /** The instructions a person wrote, without plugin blocks. */
  instructions: string;
  pluginInstructions: LegacyPluginItem[];
  /** Rules as saved, plugin rules included (they carry the plugin's tag). */
  permissions: { allow: string[]; deny: string[] };
  /** MCP server keys, plugin servers marked. Empty when the JSON doesn't parse. */
  mcpServers: Array<{ key: string; pluginId?: string }>;
  /** False when the saved MCP JSON isn't valid JSON (it's still shown as text). */
  mcpJsonValid: boolean;
  mcpJson: string;
  commands: { buildCommand?: string; testCommand?: string; lintCommand?: string };
  /**
   * Where the values still apply while they're retired: the plain agents that
   * get the project's MCP servers at start (no MCP file of their own, or a CLI
   * that takes them as launch flags). Names, by agent id.
   */
  inheritingMcp: Array<{ id: string; name: string }>;
  /** Plain agents with their own folder, which a copy can go into. */
  plainAgents: Array<{ id: string; name: string; cli: string }>;
}

/** What a copy does to one file or field. */
export type LegacyChangeAction = 'write' | 'append' | 'merge' | 'set' | 'unchanged' | 'skip';

export interface LegacyChange {
  /** What is copied: instructions, permissions, MCP servers or a command. */
  item: 'instructions' | 'permissions' | 'mcp' | 'buildCommand' | 'testCommand' | 'lintCommand';
  /** The file in the agent's folder, or the agent setting. */
  target: string;
  action: LegacyChangeAction;
  /** One plain sentence: what's added, or why it's skipped. */
  detail: string;
}

export interface LegacyCopyPreview {
  agentName: string;
  cli: string;
  changes: LegacyChange[];
  /** Why nothing can be copied into this agent, or null. */
  blocked: string | null;
}

export interface LegacyImportPreview {
  parts: Array<{ kind: 'block' | 'mcp'; name: string; status: 'new' | 'in_library' }>;
  /** What isn't imported, and why. */
  notes: string[];
}

export interface LegacyImportResult {
  created: Array<{ id: string; kind: 'block' | 'mcp'; name: string }>;
  /** Parts already in the library with the same content, which weren't made again. */
  existing: Array<{ id: string; kind: 'block' | 'mcp'; name: string }>;
  notes: string[];
}
