import { PERMISSION_LEVELS, PERMISSION_LEVEL_LABELS, type PermissionLevel } from './chat/capabilities';
import type { FreeAgentPermissionMode } from './types';

/**
 * An agent's Access (#2761): the one level its CLI starts at, on the same
 * five-level ladder as the chat composer. It replaces Free Agent Mode and the
 * separate "free agent permission mode" setting.
 *
 * The legacy pair (`freeAgentMode` plus the app or project `permissionMode`)
 * is still read and written, derived from the level, so older phones and a
 * rollback keep working:
 *
 * | Legacy                         | Access     |
 * |--------------------------------|------------|
 * | `freeAgentMode` off            | Ask first  |
 * | on, `permissionMode: auto`     | Auto       |
 * | on, `permissionMode: skip-all` | Full access|
 *
 * Plan and Auto-accept edits have no legacy equivalent, so they write the
 * nearest lower legacy value: Free Agent Mode off.
 */
export type AccessLevel = PermissionLevel;

export const ACCESS_LEVELS: readonly AccessLevel[] = PERMISSION_LEVELS;

/** What a new agent starts at when the person never picked a Default access. */
export const DEFAULT_ACCESS: AccessLevel = 'ask';

export function isAccessLevel(value: unknown): value is AccessLevel {
  return typeof value === 'string' && (ACCESS_LEVELS as readonly string[]).includes(value);
}

export function accessLabel(level: AccessLevel): string {
  return PERMISSION_LEVEL_LABELS[level];
}

/** True for the levels that set the legacy `freeAgentMode`. */
export function isLegacyFreeAgent(level: AccessLevel): boolean {
  return level === 'auto' || level === 'full_access';
}

/** The level an agent saved before #2761 runs at. An unset mode with Free Agent Mode on reads as Auto, as the CLIs do. */
export function accessFromLegacy(freeAgentMode: boolean | undefined, permissionMode: FreeAgentPermissionMode | undefined): AccessLevel {
  if (!freeAgentMode) return 'ask';
  return permissionMode === 'skip-all' ? 'full_access' : 'auto';
}

/** The legacy `freeAgentMode` value written beside a level. */
export function legacyFreeAgentMode(level: AccessLevel): boolean {
  return isLegacyFreeAgent(level);
}

/**
 * The legacy launch pair a level starts with. `offMode` is the mode passed
 * when Free Agent Mode is off: callers pass the old app or project setting so
 * a CLI that reads it with Free Agent Mode off (Copilot's --allow-all-tools)
 * starts exactly as before.
 */
export function legacyLaunchFor(level: AccessLevel, offMode: FreeAgentPermissionMode = 'auto'): { freeAgentMode: boolean; permissionMode: FreeAgentPermissionMode } {
  switch (level) {
    case 'full_access': return { freeAgentMode: true, permissionMode: 'skip-all' };
    case 'auto': return { freeAgentMode: true, permissionMode: 'auto' };
    default: return { freeAgentMode: false, permissionMode: offMode };
  }
}

/**
 * The level a saved record stands for. `access` wins while it agrees with the
 * legacy `freeAgentMode` beside it. When they disagree, something that only
 * knows the legacy field (an older phone, or an older Clubhouse after a
 * rollback) changed it later, so the legacy field wins: on keeps a level that
 * was already on, or becomes the level the old mode gives; off keeps a level
 * that was already off, or becomes Ask first.
 */
export function savedAccess(
  record: { access?: unknown; freeAgentMode?: boolean } | undefined,
  legacyMode: FreeAgentPermissionMode | undefined,
): AccessLevel {
  const saved = isAccessLevel(record?.access) ? record.access : undefined;
  const on = record?.freeAgentMode === true;
  if (saved === undefined) return accessFromLegacy(on, legacyMode);
  if (isLegacyFreeAgent(saved) === on) return saved;
  return accessFromLegacy(on, legacyMode);
}

/**
 * The level a legacy on/off request asks for, from an agent now at `current`.
 * Turning on keeps a level that is already on; turning off keeps one that is
 * already off.
 */
export function accessForLegacyToggle(current: AccessLevel, on: boolean, legacyMode: FreeAgentPermissionMode | undefined): AccessLevel {
  if (isLegacyFreeAgent(current) === on) return current;
  return accessFromLegacy(on, legacyMode);
}

export type AccessRuntime = 'chat' | 'terminal';

/**
 * The levels each CLI can start at, per runtime. Chat follows each driver's
 * mapping. A terminal agent gets only the levels its CLI has a start flag
 * for: Claude Code has all five, Codex has no plan or accept-edits start mode,
 * and Copilot's free-agent flags (--yolo --autopilot) allow everything, so it
 * has no Auto either.
 */
const LEVELS: Record<string, Record<AccessRuntime, readonly AccessLevel[]>> = {
  'claude-code': { chat: ACCESS_LEVELS, terminal: ACCESS_LEVELS },
  'codex-cli': { chat: ACCESS_LEVELS, terminal: ['ask', 'auto', 'full_access'] },
  'copilot-cli': { chat: ['plan', 'ask', 'auto_edit', 'full_access'], terminal: ['ask', 'full_access'] },
};

/**
 * The levels a picker offers for this CLI. With no runtime, the levels either
 * runtime has, since the agent's runtime isn't known yet; it starts at the
 * nearest lower level its runtime has (`startableAccess`). An unknown CLI,
 * or one that sets access itself, offers only Ask first.
 */
export function accessLevelsFor(providerId: string | undefined, runtime?: AccessRuntime): readonly AccessLevel[] {
  const row = providerId ? LEVELS[providerId] : undefined;
  if (!row) return ['ask'];
  if (runtime) return row[runtime];
  return ACCESS_LEVELS.filter((l) => row.chat.includes(l) || row.terminal.includes(l));
}

/**
 * The level an agent actually starts at: its saved level when the runtime has
 * it, else the nearest lower level that it has, else Ask first.
 */
export function startableAccess(level: AccessLevel, providerId: string | undefined, runtime: AccessRuntime): AccessLevel {
  const levels = accessLevelsFor(providerId, runtime);
  if (levels.includes(level)) return level;
  for (let i = ACCESS_LEVELS.indexOf(level) - 1; i >= 0; i--) {
    if (levels.includes(ACCESS_LEVELS[i])) return ACCESS_LEVELS[i];
  }
  return 'ask';
}

/** One plain sentence per level, for pickers and help. Auto is described as a check that can be wrong. */
export const ACCESS_DESCRIPTIONS: Readonly<Record<AccessLevel, string>> = {
  plan: 'Reads and plans. Makes no changes.',
  ask: 'Asks before edits and commands.',
  auto_edit: 'Makes file edits without asking. Asks before commands.',
  auto: 'A check decides what needs your approval. It can be wrong.',
  full_access: 'Runs everything without asking.',
};

/**
 * Settings a caller sends (an MCP tool, a form): a level it names wins over a
 * legacy flag beside it, which is only the level's derived echo when the
 * caller read the settings back and changed the level (#2997). Without a
 * level, a legacy on/off keeps the level `from` already has when it is on
 * that side, as the Free Agent Mode toggle does (`accessForLegacyToggle`);
 * with no `from` (a new template), it maps as a legacy record does. Anything
 * else (an unknown level, a flag that isn't a boolean) comes back as sent,
 * for the caller's checks to refuse.
 */
export function callerAccess<T extends { access?: AccessLevel; freeAgentMode?: boolean }>(
  settings: T,
  from: AccessLevel | undefined,
  legacyMode: FreeAgentPermissionMode | undefined,
): T {
  if (settings.access !== undefined) {
    return isAccessLevel(settings.access) ? { ...settings, access: settings.access, freeAgentMode: legacyFreeAgentMode(settings.access) } : settings;
  }
  if (typeof settings.freeAgentMode !== 'boolean') return settings;
  const access = from ? accessForLegacyToggle(from, settings.freeAgentMode, legacyMode) : accessFromLegacy(settings.freeAgentMode, legacyMode);
  return { ...settings, access, freeAgentMode: legacyFreeAgentMode(access) };
}

/**
 * Settings that carry an access level (a template's, a builder draft's) with
 * the level filled in from a legacy `freeAgentMode` and the legacy flag
 * derived from the level, so both always agree. A legacy flag that
 * disagrees with the level was written later and wins, as in `savedAccess`. Settings that set neither
 * stay without either.
 */
export function withAccess<T extends { access?: AccessLevel; freeAgentMode?: boolean }>(settings: T, legacyMode: FreeAgentPermissionMode | undefined): T {
  if (settings.access === undefined && settings.freeAgentMode === undefined) return settings;
  // Unlike an agent record, settings without the legacy flag haven't said off: a level alone stands.
  const access = settings.freeAgentMode === undefined && isAccessLevel(settings.access) ? settings.access : savedAccess(settings, legacyMode);
  return { ...settings, access, freeAgentMode: legacyFreeAgentMode(access) };
}

/** A CLI tool rule that runs commands: Claude's `Bash(...)`, Copilot's and Codex's `shell(...)`. */
function isCommandTool(tool: string): boolean {
  return /^(Bash|shell)(\(|$)/.test(tool);
}

/** A CLI tool rule that changes files: Claude's `Write` and `Edit`, Copilot's `edit`, Codex's `apply_patch`. */
function isEditTool(tool: string): boolean {
  return /^(Write|Edit|MultiEdit|NotebookEdit|edit|write|apply_patch)$/.test(tool);
}

/**
 * The default tools a quick agent gets pre-allowed, at its Access level
 * (#3007). Below Auto-accept edits only tools that read are pre-allowed, so
 * the CLI asks before anything changes; at Auto-accept edits, edits too but
 * not commands; at Auto and Full access the provider's whole default list.
 * Only the defaults: tools a person or plugin passes explicitly stay as given.
 */
export function quickToolsForAccess(tools: readonly string[], level: AccessLevel): string[] {
  if (level === 'auto' || level === 'full_access') return [...tools];
  if (level === 'auto_edit') return tools.filter((t) => !isCommandTool(t));
  return tools.filter((t) => !isCommandTool(t) && !isEditTool(t));
}
