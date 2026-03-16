import type { ProjectConfigBreakdown, ProvenancedConfigItem, ConfigProvenance } from '../../shared/types';
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
 * This powers the Clubhouse mode management UI.
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

async function removePluginInstructionBlock(projectPath: string, pluginId: string): Promise<boolean> {
  const defaults = await agentSettings.readProjectAgentDefaults(projectPath);
  if (!defaults.instructions) return false;

  const escaped = pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(
    `\\n?\\n?<!-- plugin:${escaped}:start -->[\\s\\S]*?<!-- plugin:${escaped}:end -->`,
  );
  const cleaned = defaults.instructions.replace(regex, '');
  if (cleaned === defaults.instructions) return false;

  defaults.instructions = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  await agentSettings.writeProjectAgentDefaults(projectPath, defaults);
  return true;
}

async function removePermissionRule(
  projectPath: string,
  kind: 'allow' | 'deny',
  ruleIndex: number,
): Promise<boolean> {
  const defaults = await agentSettings.readProjectAgentDefaults(projectPath);
  const rules = defaults.permissions?.[kind];
  if (!rules || ruleIndex < 0 || ruleIndex >= rules.length) return false;

  rules.splice(ruleIndex, 1);
  if (!defaults.permissions) defaults.permissions = {};
  defaults.permissions[kind] = rules;
  await agentSettings.writeProjectAgentDefaults(projectPath, defaults);
  return true;
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
  const defaults = await agentSettings.readProjectAgentDefaults(projectPath);
  if (!defaults.mcpJson) return false;

  try {
    const mcpConfig = JSON.parse(defaults.mcpJson) as Record<string, unknown>;
    const mcpServers = (mcpConfig.mcpServers as Record<string, unknown>) || {};
    if (!(serverName in mcpServers)) return false;

    delete mcpServers[serverName];
    defaults.mcpJson = JSON.stringify({ ...mcpConfig, mcpServers }, null, 2);
    await agentSettings.writeProjectAgentDefaults(projectPath, defaults);
    return true;
  } catch {
    return false;
  }
}
