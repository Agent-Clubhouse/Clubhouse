export const GROUP_PROJECT_CORE_TOOL_SUFFIXES = [
  'list_members',
  'post_bulletin',
  'read_bulletin',
  'read_topic',
  'read_message',
  'get_project_info',
  'subscribe_topic',
] as const;

export const GROUP_PROJECT_PRIVILEGED_TOOL_SUFFIXES = [
  'wake_agent',
  'sleep_agent',
  'clear_agent',
  'compact_agent',
  'clear_topic',
  'delete_messages',
  'set_project_info',
] as const;

export const GROUP_PROJECT_TOOL_SUFFIXES = [
  ...GROUP_PROJECT_CORE_TOOL_SUFFIXES,
  ...GROUP_PROJECT_PRIVILEGED_TOOL_SUFFIXES,
] as const;

export const DEFAULT_GROUP_PROJECT_DISABLED_TOOLS = [...GROUP_PROJECT_PRIVILEGED_TOOL_SUFFIXES];
export const GROUP_PROJECT_DEFAULT_DISABLED_TOOLS_VERSION = 2;
export const LEGACY_DEFAULT_DISABLED_TOOL_ADDITIONS = ['sleep_agent'] as const;

export function getDefaultGroupProjectDisabledTools(defaults?: string[], version?: number): string[] {
  if (!defaults) return [...DEFAULT_GROUP_PROJECT_DISABLED_TOOLS];
  if (version === GROUP_PROJECT_DEFAULT_DISABLED_TOOLS_VERSION) return knownGroupProjectTools(defaults);
  return knownGroupProjectTools(Array.from(new Set([...defaults, ...LEGACY_DEFAULT_DISABLED_TOOL_ADDITIONS])));
}

export function getDefaultGroupProjectDisabledToolsFromMetadata(metadata?: Record<string, unknown>): string[] {
  const defaults = metadata?.defaultDisabledTools as string[] | undefined;
  const version = metadata?.defaultDisabledToolsVersion as number | undefined;
  return getDefaultGroupProjectDisabledTools(defaults, version);
}

/** Old saved switches keep loading; tools no longer offered have no switch. */
export function knownGroupProjectTools(tools: string[]): string[] {
  const known = new Set<string>(GROUP_PROJECT_TOOL_SUFFIXES);
  return tools.filter((tool) => known.has(tool));
}
