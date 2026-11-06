/** Limits apply to passive display metadata, never filesystem paths or commands. */
export const MAX_REPORTED_SKILLS = 512;
export const MAX_REPORTED_SKILL_NAME_LENGTH = 256;

/** Claude's system/init names have no per-skill scope, path, or execution status. */
export interface ChatProviderSkills {
  provider: 'claude-code';
  driver: 'claude_agent_sdk' | 'claude_stream_json';
  source: 'system/init';
  nativeSessionId: string;
  /** null: missing, malformed, or over the display limits; []: explicitly none. */
  names: string[] | null;
}

export function reportedSkillNames(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_REPORTED_SKILLS) return null;
  for (const name of value) {
    if (typeof name !== 'string' || name.length > MAX_REPORTED_SKILL_NAME_LENGTH || name.trim().length === 0) return null;
    if ([...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  }
  return [...new Set(value as string[])];
}

/** Also used at transcript replay's untrusted data boundary. Never filters an invalid list to []. */
export function readProviderSkills(value: unknown): ChatProviderSkills | null {
  if (!value || typeof value !== 'object') return null;
  const report = value as Record<string, unknown>;
  if (report.provider !== 'claude-code' || report.source !== 'system/init'
    || (report.driver !== 'claude_agent_sdk' && report.driver !== 'claude_stream_json')
    || typeof report.nativeSessionId !== 'string' || !report.nativeSessionId
    || report.nativeSessionId.length > 512) return null;
  return {
    provider: report.provider, driver: report.driver, source: report.source,
    nativeSessionId: report.nativeSessionId, names: reportedSkillNames(report.names),
  };
}
