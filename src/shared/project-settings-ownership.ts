/**
 * Who owns each project setting (#3245). A project holds only its
 * environment: what every agent in it runs under. What an agent does
 * (instructions, skills, MCP servers, access, model and so on) belongs to its
 * template and parts, or to a plain agent's own files. The project's old agent
 * defaults are legacy: read-only, copied or imported only when someone asks.
 *
 * The settings UI, `read_settings` and docs/project-settings.md follow this.
 */
import type { ProjectAgentDefaults } from './types';

export type ProjectSettingOwner =
  /** Project environment: editable in the project's settings, read live by every agent. */
  | 'environment'
  /** Legacy agent default: read-only, applied only where docs/project-settings.md says, until retired. */
  | 'legacy'
  /** Retired: no longer shown or applied; only a one-time migration may read it. */
  | 'retired';

/**
 * Every `agentDefaults` key. A key missing here doesn't compile, so a new one
 * is a decision about who owns it.
 */
export const AGENT_DEFAULTS_OWNERSHIP: Readonly<Record<keyof Required<ProjectAgentDefaults>, ProjectSettingOwner>> = {
  sourceControlProvider: 'environment',
  commandPrefix: 'environment',
  helperAuto: 'environment',
  instructions: 'legacy',
  permissions: 'legacy',
  mcpJson: 'legacy',
  buildCommand: 'legacy',
  testCommand: 'legacy',
  lintCommand: 'legacy',
  freeAgentMode: 'retired',
  profileId: 'retired',
  persona: 'retired',
  mission: 'retired',
};

/** The legacy keys, in the order the settings page shows them. */
export const LEGACY_AGENT_DEFAULT_KEYS = ['instructions', 'permissions', 'mcpJson', 'buildCommand', 'testCommand', 'lintCommand'] as const;

export type LegacyAgentDefaultKey = (typeof LEGACY_AGENT_DEFAULT_KEYS)[number];

/** The keys a project's settings page edits. */
export function isEnvironmentKey(key: keyof ProjectAgentDefaults): boolean {
  return AGENT_DEFAULTS_OWNERSHIP[key] === 'environment';
}

/** True when the project still has a legacy value saved. Blank text and empty lists count as none. */
export function hasLegacyAgentDefaults(defaults: ProjectAgentDefaults): boolean {
  return !!(defaults.instructions?.trim()
    || defaults.permissions?.allow?.length
    || defaults.permissions?.deny?.length
    || defaults.mcpJson?.trim()
    || defaults.buildCommand?.trim()
    || defaults.testCommand?.trim()
    || defaults.lintCommand?.trim());
}
