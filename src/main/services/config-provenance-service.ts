import type { ProjectAgentDefaults, ProjectAgentDefaultsPatch, ProjectConfigBreakdown, ProvenancedConfigItem, ConfigProvenance } from '../../shared/types';
import * as agentSettings from './agent-settings-service';
import { listOrphanedPluginIds } from './plugin-discovery';

const PLUGIN_INSTRUCTION_REGEX = /<!-- plugin:([^:]+):start -->([\s\S]*?)<!-- plugin:\1:end -->/g;
const PLUGIN_PERM_REGEX = /\/\* plugin:([^ ]+) \*\//;
/** Default skill names shipped by Clubhouse */
const BUILT_IN_SKILL_NAMES = new Set([
  'mission', 'create-pr', 'go-standby', 'build', 'test', 'lint', 'validate-changes',
]);

/**
 * Parse plugin ID from a `plugin-{id}-{name}` prefixed string.
 * Returns the plugin ID or null if not plugin-prefixed.
 */
export function parsePluginPrefix(name: string): string | null {
  // Plugin prefixes are `plugin-{pluginId}-` where pluginId may itself contain hyphens.
  // We rely on the skill/template listing from plugin-discovery which uses a known prefix.
  // Simple heuristic: match `plugin-` then scan for known patterns.
  if (!name.startsWith('plugin-')) return null;

  // The name format is `plugin-{pluginId}-{itemName}`.
  // pluginId itself can contain hyphens (e.g., "buddy-system").
  // We can't perfectly parse this without knowing the pluginId, but we can use
  // a reasonable heuristic: split on `-` and try progressively longer plugin IDs.
  const rest = name.slice('plugin-'.length);
  const parts = rest.split('-');

  // Try from shortest to longest, the item name is at least 1 part
  for (let i = 1; i < parts.length; i++) {
    const candidateId = parts.slice(0, i).join('-');
    const itemName = parts.slice(i).join('-');
    if (itemName.length > 0) {
      return candidateId;
    }
  }
  return null;
}

/**
 * Build a structured provenance breakdown of all project agent default configs.
 * This powers the project's Default agent settings page.
 */
export async function getProjectConfigBreakdown(
  projectPath: string,
  knownPluginIds: string[],
): Promise<ProjectConfigBreakdown> {
  const defaults = await agentSettings.readProjectAgentDefaults(projectPath);
  const allSkills = await agentSettings.listSourceSkills(projectPath);
  const allTemplates = await agentSettings.listSourceAgentTemplates(projectPath);

  // ── Instructions ──────────────────────────────────────────────────────
  const pluginInstructionBlocks: ProvenancedConfigItem[] = [];
  let userInstructions = defaults.instructions || '';

  // Extract plugin instruction blocks
  const instructionMatches = [...(defaults.instructions || '').matchAll(PLUGIN_INSTRUCTION_REGEX)];
  for (const match of instructionMatches) {
    const pluginId = match[1];
    const content = match[2].trim();
    pluginInstructionBlocks.push({
      id: `instructions:plugin:${pluginId}`,
      label: `Instructions from ${pluginId}`,
      value: content,
      provenance: { source: 'plugin', pluginId },
    });
    // Remove the block from user instructions
    userInstructions = userInstructions.replace(match[0], '');
  }
  userInstructions = userInstructions.replace(/\n{3,}/g, '\n\n').trim();

  // ── Permissions ───────────────────────────────────────────────────────
  const allowRules = parsePermissionRules(defaults.permissions?.allow || [], 'allow');
  const denyRules = parsePermissionRules(defaults.permissions?.deny || [], 'deny');

  // ── Skills ────────────────────────────────────────────────────────────
  const skills: ProvenancedConfigItem[] = allSkills.map((skill) => {
    const pluginId = parsePluginPrefix(skill.name);
    let provenance: ConfigProvenance;
    if (pluginId) {
      provenance = { source: 'plugin', pluginId };
    } else if (BUILT_IN_SKILL_NAMES.has(skill.name)) {
      provenance = { source: 'built-in' };
    } else {
      provenance = { source: 'user' };
    }
    return {
      id: `skill:${skill.name}`,
      label: skill.name,
      value: skill.path,
      provenance,
    };
  });

  // ── Agent templates ───────────────────────────────────────────────────
  const agentTemplates: ProvenancedConfigItem[] = allTemplates.map((tpl) => {
    const pluginId = parsePluginPrefix(tpl.name);
    let provenance: ConfigProvenance;
    if (pluginId) {
      provenance = { source: 'plugin', pluginId };
    } else {
      provenance = { source: 'user' };
    }
    return {
      id: `agent-template:${tpl.name}`,
      label: tpl.name,
      value: tpl.path,
      provenance,
    };
  });

  // ── MCP servers ───────────────────────────────────────────────────────
  const mcpServers: ProvenancedConfigItem[] = [];
  if (defaults.mcpJson) {
    try {
      const parsed = JSON.parse(defaults.mcpJson);
      const servers = (parsed.mcpServers as Record<string, unknown>) || {};
      for (const [name, config] of Object.entries(servers)) {
        const pluginId = parsePluginPrefix(name);
        mcpServers.push({
          id: `mcp:${name}`,
          label: name,
          value: JSON.stringify(config, null, 2),
          provenance: pluginId
            ? { source: 'plugin', pluginId }
            : { source: 'user' },
        });
      }
    } catch { /* ignore invalid JSON */ }
  }

  // ── Orphans ───────────────────────────────────────────────────────────
  const orphanedPluginIds = await listOrphanedPluginIds(projectPath, knownPluginIds);

  return {
    userInstructions,
    pluginInstructionBlocks,
    allowRules,
    denyRules,
    skills,
    agentTemplates,
    mcpServers,
    orphanedPluginIds,
  };
}

/**
 * Remove a single plugin-injected item from the project config.
 * Returns true if the item was found and removed.
 */
export async function removePluginInjectionItem(
  projectPath: string,
  itemId: string,
): Promise<boolean> {
  const [category, ...rest] = itemId.split(':');

  if (category === 'instructions' && rest[0] === 'plugin') {
    const pluginId = rest.slice(1).join(':');
    return removePluginInstructionBlock(projectPath, pluginId);
  }

  if (category === 'allow-rule' || category === 'deny-rule') {
    const ruleIndex = parseInt(rest[0], 10);
    const kind = category === 'allow-rule' ? 'allow' : 'deny';
    return removePermissionRule(projectPath, kind, ruleIndex);
  }

  if (category === 'skill') {
    const skillName = rest.join(':');
    return removeSkill(projectPath, skillName);
  }

  if (category === 'agent-template') {
    const templateName = rest.join(':');
    return removeAgentTemplate(projectPath, templateName);
  }

  if (category === 'mcp') {
    const serverName = rest.join(':');
    return removeMcpServer(projectPath, serverName);
  }

  return false;
}

/**
 * Save the Default agent settings page (#3244). Only the fields in `patch` change.
 * Its instructions, permissions and mcpJson hold the user's part only: whatever
 * plugins put there is kept from the settings as they are now, exactly once, and
 * plugin-tagged values in the user's part are dropped.
 */
export async function saveProjectUserDefaults(
  projectPath: string,
  patch: ProjectAgentDefaultsPatch,
): Promise<void> {
  assertUserDefaultsPatch(patch);
  await agentSettings.updateProjectAgentDefaults(projectPath, (current) => {
    const next: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(patch) as [keyof ProjectAgentDefaults, unknown][]) {
      let merged: unknown;
      if (key === 'instructions') merged = mergeUserInstructions(value as string | null, current.instructions);
      else if (key === 'permissions') merged = mergeUserPermissions(value as ProjectAgentDefaults['permissions'] | null, current.permissions);
      else if (key === 'mcpJson') merged = mergeUserMcpJson(value as string | null, current.mcpJson);
      else merged = value;
      if (merged === null || merged === undefined || merged === '') delete next[key];
      else next[key] = merged;
    }
    return next as ProjectAgentDefaults;
  });
}

const USER_TEXT_KEYS = new Set(['instructions', 'mcpJson', 'buildCommand', 'testCommand', 'lintCommand', 'commandPrefix']);
const SOURCE_CONTROL_PROVIDERS = new Set(['github', 'azure-devops']);

/**
 * The keys the page edits, with values of the right shape (#3262). Anything
 * else from the renderer is refused rather than copied into the defaults.
 */
function assertUserDefaultsPatch(patch: unknown): asserts patch is ProjectAgentDefaultsPatch {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Default agent settings must be an object.');
  for (const [key, value] of Object.entries(patch)) {
    const ok = USER_TEXT_KEYS.has(key) ? value === null || typeof value === 'string'
      : key === 'permissions' ? value === null || isUserPermissions(value)
        : key === 'helperAuto' ? value === null || value === 'off'
          : key === 'sourceControlProvider' ? value === null || SOURCE_CONTROL_PROVIDERS.has(value as string)
            // Retired (#2761): it can only be cleared.
            : key === 'freeAgentMode' ? value === null
              : undefined;
    if (ok === undefined) throw new Error(`Unknown default agent setting: ${key}`);
    if (!ok) throw new Error(`Invalid value for the default agent setting ${key}.`);
  }
}

function isUserPermissions(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([kind, rules]) =>
    (kind === 'allow' || kind === 'deny') && Array.isArray(rules) && rules.every((r) => typeof r === 'string'));
}

function mergeUserInstructions(user: string | null, current: string | undefined): string | undefined {
  const userPart = (user ?? '').replace(PLUGIN_INSTRUCTION_REGEX, '').replace(/\n{3,}/g, '\n\n').trim();
  const pluginBlocks = [...(current ?? '').matchAll(PLUGIN_INSTRUCTION_REGEX)].map((m) => m[0]);
  const merged = [userPart, ...pluginBlocks].filter(Boolean).join('\n\n');
  return merged || undefined;
}

function mergeUserPermissions(
  user: ProjectAgentDefaults['permissions'] | null,
  current: ProjectAgentDefaults['permissions'],
): ProjectAgentDefaults['permissions'] {
  const merged: NonNullable<ProjectAgentDefaults['permissions']> = { ...current };
  for (const kind of ['allow', 'deny'] as const) {
    const rules = [
      ...(user?.[kind] ?? []).filter((r) => !PLUGIN_PERM_REGEX.test(r)),
      ...(current?.[kind] ?? []).filter((r) => PLUGIN_PERM_REGEX.test(r)),
    ];
    if (rules.length > 0) merged[kind] = rules;
    else delete merged[kind];
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeUserMcpJson(user: string | null, current: string | undefined): string | undefined {
  let currentServers: Record<string, unknown> = {};
  try {
    currentServers = (JSON.parse(current ?? '{}').mcpServers as Record<string, unknown>) ?? {};
  } catch { /* nothing to keep from invalid JSON */ }
  const pluginServers = Object.fromEntries(
    Object.entries(currentServers).filter(([name]) => parsePluginPrefix(name)),
  );
  const userText = (user ?? '').trim();
  const hasPluginServers = Object.keys(pluginServers).length > 0;
  if (!userText) {
    return hasPluginServers ? JSON.stringify({ mcpServers: pluginServers }, null, 2) : undefined;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(userText);
  } catch (err) {
    throw new Error(`Default .mcp.json isn't valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Default .mcp.json must be a JSON object.');
  }
  const userServers = Object.fromEntries(
    Object.entries((parsed.mcpServers as Record<string, unknown>) ?? {}).filter(([name]) => !parsePluginPrefix(name)),
  );
  const userHadPluginServers = Object.keys((parsed.mcpServers as Record<string, unknown>) ?? {}).length !== Object.keys(userServers).length;
  // Keep the user's own formatting when there's nothing to merge.
  if (!hasPluginServers && !userHadPluginServers) return userText;
  return JSON.stringify({ ...parsed, mcpServers: { ...userServers, ...pluginServers } }, null, 2);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function parsePermissionRules(
  rules: string[],
  kind: 'allow' | 'deny',
): ProvenancedConfigItem[] {
  return rules.map((rule, index) => {
    const pluginMatch = rule.match(PLUGIN_PERM_REGEX);
    const provenance: ConfigProvenance = pluginMatch
      ? { source: 'plugin', pluginId: pluginMatch[1] }
      : { source: 'user' };
    // Strip the plugin tag from the display label
    const label = pluginMatch
      ? rule.replace(PLUGIN_PERM_REGEX, '').trim()
      : rule;
    return {
      id: `${kind}-rule:${index}`,
      label,
      value: rule,
      provenance,
    };
  });
}

// Each removal changes the defaults as they are when its turn comes (#3262).

async function removePluginInstructionBlock(projectPath: string, pluginId: string): Promise<boolean> {
  const escaped = pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(
    `\\n?\\n?<!-- plugin:${escaped}:start -->[\\s\\S]*?<!-- plugin:${escaped}:end -->`,
  );
  const next = await agentSettings.updateProjectAgentDefaults(projectPath, (defaults) => {
    if (!defaults.instructions) return null;
    const cleaned = defaults.instructions.replace(regex, '');
    if (cleaned === defaults.instructions) return null;
    return { ...defaults, instructions: cleaned.replace(/\n{3,}/g, '\n\n').trim() };
  });
  return next !== null;
}

async function removePermissionRule(
  projectPath: string,
  kind: 'allow' | 'deny',
  ruleIndex: number,
): Promise<boolean> {
  const next = await agentSettings.updateProjectAgentDefaults(projectPath, (defaults) => {
    const rules = defaults.permissions?.[kind];
    if (!rules || ruleIndex < 0 || ruleIndex >= rules.length) return null;
    return { ...defaults, permissions: { ...defaults.permissions, [kind]: rules.filter((_, i) => i !== ruleIndex) } };
  });
  return next !== null;
}

async function removeSkill(projectPath: string, skillName: string): Promise<boolean> {
  try {
    await agentSettings.deleteSourceSkill(projectPath, skillName);
    return true;
  } catch {
    return false;
  }
}

async function removeAgentTemplate(projectPath: string, templateName: string): Promise<boolean> {
  try {
    await agentSettings.deleteSourceAgentTemplate(projectPath, templateName);
    return true;
  } catch {
    return false;
  }
}

async function removeMcpServer(projectPath: string, serverName: string): Promise<boolean> {
  const next = await agentSettings.updateProjectAgentDefaults(projectPath, (defaults) => {
    if (!defaults.mcpJson) return null;
    try {
      const mcpConfig = JSON.parse(defaults.mcpJson) as Record<string, unknown>;
      const mcpServers = { ...((mcpConfig.mcpServers as Record<string, unknown>) || {}) };
      if (!(serverName in mcpServers)) return null;
      delete mcpServers[serverName];
      return { ...defaults, mcpJson: JSON.stringify({ ...mcpConfig, mcpServers }, null, 2) };
    } catch {
      return null;
    }
  });
  return next !== null;
}
