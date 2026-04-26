export const GROUP_PROJECT_CORE_TOOL_SUFFIXES = [
  'list_members',
  'post_bulletin',
  'read_bulletin',
  'read_topic',
  'read_message',
  'get_project_info',
] as const;

export const GROUP_PROJECT_PRIVILEGED_TOOL_SUFFIXES = [
  'shoulder_tap',
  'broadcast',
  'wake_agent',
  'sleep_agent',
  'start_polling',
  'stop_polling',
  'clear_agent',
  'compact_agent',
  'clear_topic',
  'delete_messages',
] as const;

export const GROUP_PROJECT_TOOL_SUFFIXES = [
  ...GROUP_PROJECT_CORE_TOOL_SUFFIXES,
  ...GROUP_PROJECT_PRIVILEGED_TOOL_SUFFIXES,
] as const;

export const DEFAULT_GROUP_PROJECT_DISABLED_TOOLS = [...GROUP_PROJECT_PRIVILEGED_TOOL_SUFFIXES];

export function getDefaultGroupProjectDisabledTools(defaults?: string[]): string[] {
  return defaults ? [...defaults] : [...DEFAULT_GROUP_PROJECT_DISABLED_TOOLS];
}
