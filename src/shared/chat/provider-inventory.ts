/**
 * What a provider itself reported a session offers the model (#2855): skill
 * names and model-visible MCP tool names. Names only: no paths, commands or
 * arguments. Clubhouse reads it for verified activation and never fills it
 * from files it wrote, a started process or an MCP handshake.
 */
import type { ChatDriverId } from './capabilities';
import type { ChatMcpServer } from './events';
import { reportedSkillNames } from './provider-skills';

export const MAX_REPORTED_TOOLS = 2048;
export const MAX_REPORTED_TOOL_NAME_LENGTH = 256;

export interface ChatProviderInventory {
  provider: 'claude-code' | 'copilot';
  driver: 'claude_agent_sdk' | 'claude_stream_json' | 'copilot_sdk';
  /** Claude's `system/init`, or Copilot's `session.skills_loaded`. */
  source: 'system/init' | 'session.skills_loaded';
  nativeSessionId: string;
  /** Skills the provider reports loaded and enabled. Absent: this report doesn't cover skills. null: malformed. */
  skills?: string[] | null;
  /** MCP tools offered to the model (`mcp__<server>__<tool>`). Absent: this report doesn't cover tools. null: malformed. */
  mcpTools?: string[] | null;
}

/** A running chat session's provider evidence: the inventory only when it is this session's own. */
export interface ProviderSessionReport {
  driver: ChatDriverId;
  nativeSessionId?: string;
  inventory?: ChatProviderInventory;
  /** MCP servers the CLI connected to, with status. A handshake, never proof the model sees a tool. */
  mcpHandshakes?: ChatMcpServer[];
}

/** What a chat driver's provider reports at all: Claude's init lists skills and tools; Copilot reports skills only. */
export function driverReports(driver: ChatDriverId): { skills: boolean; mcpTools: boolean } {
  if (driver === 'claude_agent_sdk' || driver === 'claude_stream_json') return { skills: true, mcpTools: true };
  if (driver === 'copilot_sdk') return { skills: true, mcpTools: false };
  return { skills: false, mcpTools: false };
}

/** The MCP tool names in a provider's tool list. Missing or malformed is unknown (null), never an empty list. */
export function reportedMcpToolNames(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_REPORTED_TOOLS) return null;
  for (const name of value) {
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_REPORTED_TOOL_NAME_LENGTH) return null;
    if ([...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  }
  return [...new Set((value as string[]).filter((name) => name.startsWith('mcp__')))];
}

/** Copilot's `session.skills_loaded` skills: only enabled ones count as loaded. */
export function reportedCopilotSkillNames(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const names: unknown[] = [];
  for (const skill of value) {
    if (!skill || typeof skill !== 'object') return null;
    const s = skill as { name?: unknown; enabled?: unknown };
    if (typeof s.enabled !== 'boolean') return null;
    if (s.enabled) names.push(s.name);
  }
  return reportedSkillNames(names);
}

/** Claude names an MCP tool `mcp__<server>__<tool>`, with characters outside [A-Za-z0-9_-] in the server name replaced. */
export function claudeMcpToolPrefix(serverKey: string): string {
  return `mcp__${serverKey.replace(/[^A-Za-z0-9_-]/g, '_')}__`;
}
