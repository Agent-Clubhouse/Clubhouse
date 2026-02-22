import * as fs from 'fs';
import * as path from 'path';
import { ConfigDiffItem, ConfigDiffResult, DurableAgentConfig } from '../../shared/types';
import { replaceWildcards, unreplaceWildcards } from '../../shared/wildcard-replacer';
import { OrchestratorProvider } from '../orchestrators/types';
import {
  readProjectAgentDefaults,
  readPermissions,
  readMcpRawJson,
  readSkillContent,
  listSkills,
  listAgentTemplates,
  readAgentTemplateContent,
  listSourceSkills,
  listSourceAgentTemplates,
  readSourceSkillContent,
  readSourceAgentTemplateContent,
  writeProjectAgentDefaults,
  writeSourceSkillContent,
  deleteSourceSkill,
  writeSourceAgentTemplateContent,
  deleteSourceAgentTemplate,
} from './agent-settings-service';
import { getDurableConfig } from './agent-config';
import { buildWildcardContext, resolveSourceControlProvider } from './materialization-service';
import { appLog } from './log-service';

/**
 * Compute config diffs between an agent's current worktree state
 * and the project-level defaults (what would be materialized on next wake).
 */
export function computeConfigDiff(params: {
  projectPath: string;
  agentId: string;
  provider: OrchestratorProvider;
}): ConfigDiffResult {
  const { projectPath, agentId, provider } = params;
  const agent = getDurableConfig(projectPath, agentId);
  if (!agent) {
    return { agentId, agentName: '', hasDiffs: false, items: [] };
  }

  // Skip if agent opted out of materialization
  if (agent.clubhouseModeOverride) {
    return { agentId, agentName: agent.name, hasDiffs: false, items: [] };
  }

  const worktreePath = agent.worktreePath;
  if (!worktreePath) {
    return { agentId, agentName: agent.name, hasDiffs: false, items: [] };
  }

  const defaults = readProjectAgentDefaults(projectPath);
  const scp = resolveSourceControlProvider(projectPath);
  const ctx = buildWildcardContext(agent, projectPath, scp);
  const conv = provider.conventions;

  const items: ConfigDiffItem[] = [];

  // 1. Instructions
  diffInstructions(items, defaults.instructions, worktreePath, provider, ctx);

  // 2. Permissions
  diffPermissions(items, defaults.permissions, worktreePath, conv, ctx);

  // 3. MCP
  diffMcp(items, defaults.mcpJson, worktreePath, conv, ctx);

  // 4. Skills
  diffSkills(items, projectPath, worktreePath, conv, ctx);

  // 5. Agent templates
  diffAgentTemplates(items, projectPath, worktreePath, conv, ctx);

  return {
    agentId,
    agentName: agent.name,
    hasDiffs: items.length > 0,
    items,
  };
}

/**
 * Propagate selected config changes back to project defaults.
 */
export function propagateChanges(params: {
  projectPath: string;
  agentId: string;
  selectedItemIds: string[];
  provider: OrchestratorProvider;
}): { ok: boolean; message: string; propagatedCount: number } {
  const { projectPath, agentId, selectedItemIds, provider } = params;
  const agent = getDurableConfig(projectPath, agentId);
  if (!agent) {
    return { ok: false, message: 'Agent not found', propagatedCount: 0 };
  }

  const worktreePath = agent.worktreePath;
  if (!worktreePath) {
    return { ok: false, message: 'Agent has no worktree', propagatedCount: 0 };
  }

  const scp = resolveSourceControlProvider(projectPath);
  const ctx = buildWildcardContext(agent, projectPath, scp);
  const conv = provider.conventions;

  // Re-compute the diff to get full item data
  const diffResult = computeConfigDiff({ projectPath, agentId, provider });
  const itemMap = new Map(diffResult.items.map((item) => [item.id, item]));

  const defaults = readProjectAgentDefaults(projectPath);
  let propagatedCount = 0;

  for (const itemId of selectedItemIds) {
    const item = itemMap.get(itemId);
    if (!item) continue;

    try {
      switch (item.category) {
        case 'permissions-allow':
          propagatePermission(defaults, 'allow', item);
          propagatedCount++;
          break;
        case 'permissions-deny':
          propagatePermission(defaults, 'deny', item);
          propagatedCount++;
          break;
        case 'instructions':
          if (item.action === 'modified' && item.agentValue != null) {
            defaults.instructions = unreplaceWildcards(item.agentValue, ctx);
            propagatedCount++;
          }
          break;
        case 'mcp':
          propagateMcp(defaults, item, worktreePath, conv, ctx);
          propagatedCount++;
          break;
        case 'skills':
          propagateSkill(projectPath, item, worktreePath, conv, ctx);
          propagatedCount++;
          break;
        case 'agent-templates':
          propagateAgentTemplate(projectPath, item, worktreePath, conv, ctx);
          propagatedCount++;
          break;
      }
    } catch (err) {
      appLog('core:config-diff', 'warn', `Failed to propagate item ${itemId}`, {
        meta: { error: String(err) },
      });
    }
  }

  writeProjectAgentDefaults(projectPath, defaults);

  return {
    ok: true,
    message: `Propagated ${propagatedCount} change(s) to project defaults`,
    propagatedCount,
  };
}

// ── Diff helpers ──────────────────────────────────────────────────────────

function diffInstructions(
  items: ConfigDiffItem[],
  defaultInstructions: string | undefined,
  worktreePath: string,
  provider: OrchestratorProvider,
  ctx: ReturnType<typeof buildWildcardContext>,
): void {
  const resolvedDefault = defaultInstructions ? replaceWildcards(defaultInstructions, ctx) : '';
  const agentInstructions = provider.readInstructions(worktreePath);

  if (normalizeWhitespace(resolvedDefault) !== normalizeWhitespace(agentInstructions)) {
    if (agentInstructions || resolvedDefault) {
      items.push({
        id: 'instructions:modified',
        category: 'instructions',
        action: 'modified',
        label: 'Instructions (CLAUDE.md)',
        agentValue: agentInstructions,
        defaultValue: resolvedDefault,
      });
    }
  }
}

function diffPermissions(
  items: ConfigDiffItem[],
  defaultPermissions: { allow?: string[]; deny?: string[] } | undefined,
  worktreePath: string,
  conv: OrchestratorProvider['conventions'],
  ctx: ReturnType<typeof buildWildcardContext>,
): void {
  const resolvedAllow = new Set(
    (defaultPermissions?.allow || []).map((r) => replaceWildcards(r, ctx)),
  );
  const resolvedDeny = new Set(
    (defaultPermissions?.deny || []).map((r) => replaceWildcards(r, ctx)),
  );

  const agentPerms = readPermissions(worktreePath, conv);
  const agentAllow = new Set(agentPerms.allow || []);
  const agentDeny = new Set(agentPerms.deny || []);

  // Allow: added
  for (const rule of agentAllow) {
    if (!resolvedAllow.has(rule)) {
      items.push({
        id: `permissions-allow:added:${rule}`,
        category: 'permissions-allow',
        action: 'added',
        label: rule,
        agentValue: rule,
        rawAgentValue: unreplaceWildcards(rule, ctx),
      });
    }
  }

  // Allow: removed
  for (const rule of resolvedAllow) {
    if (!agentAllow.has(rule)) {
      items.push({
        id: `permissions-allow:removed:${rule}`,
        category: 'permissions-allow',
        action: 'removed',
        label: rule,
        defaultValue: rule,
        rawAgentValue: unreplaceWildcards(rule, ctx),
      });
    }
  }

  // Deny: added
  for (const rule of agentDeny) {
    if (!resolvedDeny.has(rule)) {
      items.push({
        id: `permissions-deny:added:${rule}`,
        category: 'permissions-deny',
        action: 'added',
        label: rule,
        agentValue: rule,
        rawAgentValue: unreplaceWildcards(rule, ctx),
      });
    }
  }

  // Deny: removed
  for (const rule of resolvedDeny) {
    if (!agentDeny.has(rule)) {
      items.push({
        id: `permissions-deny:removed:${rule}`,
        category: 'permissions-deny',
        action: 'removed',
        label: rule,
        defaultValue: rule,
        rawAgentValue: unreplaceWildcards(rule, ctx),
      });
    }
  }
}

function diffMcp(
  items: ConfigDiffItem[],
  defaultMcpJson: string | undefined,
  worktreePath: string,
  conv: OrchestratorProvider['conventions'],
  ctx: ReturnType<typeof buildWildcardContext>,
): void {
  let defaultServers: Record<string, unknown> = {};
  if (defaultMcpJson) {
    try {
      const resolved = replaceWildcards(defaultMcpJson, ctx);
      const parsed = JSON.parse(resolved);
      defaultServers = parsed.mcpServers || {};
    } catch { /* ignore invalid JSON */ }
  }

  let agentServers: Record<string, unknown> = {};
  try {
    const rawJson = readMcpRawJson(worktreePath, conv);
    const parsed = JSON.parse(rawJson);
    agentServers = parsed.mcpServers || {};
  } catch { /* ignore */ }

  const defaultNames = new Set(Object.keys(defaultServers));
  const agentNames = new Set(Object.keys(agentServers));

  // Added servers
  for (const name of agentNames) {
    if (!defaultNames.has(name)) {
      items.push({
        id: `mcp:added:${name}`,
        category: 'mcp',
        action: 'added',
        label: `MCP server: ${name}`,
        agentValue: JSON.stringify(agentServers[name], null, 2),
      });
    }
  }

  // Removed servers
  for (const name of defaultNames) {
    if (!agentNames.has(name)) {
      items.push({
        id: `mcp:removed:${name}`,
        category: 'mcp',
        action: 'removed',
        label: `MCP server: ${name}`,
        defaultValue: JSON.stringify(defaultServers[name], null, 2),
      });
    }
  }

  // Modified servers
  for (const name of agentNames) {
    if (defaultNames.has(name)) {
      const agentStr = JSON.stringify(agentServers[name]);
      const defaultStr = JSON.stringify(defaultServers[name]);
      if (agentStr !== defaultStr) {
        items.push({
          id: `mcp:modified:${name}`,
          category: 'mcp',
          action: 'modified',
          label: `MCP server: ${name}`,
          agentValue: JSON.stringify(agentServers[name], null, 2),
          defaultValue: JSON.stringify(defaultServers[name], null, 2),
        });
      }
    }
  }
}

function diffSkills(
  items: ConfigDiffItem[],
  projectPath: string,
  worktreePath: string,
  conv: OrchestratorProvider['conventions'],
  ctx: ReturnType<typeof buildWildcardContext>,
): void {
  const sourceSkills = listSourceSkills(projectPath);
  const agentSkills = listSkills(worktreePath, conv);

  const sourceNames = new Set(sourceSkills.map((s) => s.name));
  const agentNames = new Set(agentSkills.map((s) => s.name));

  // Added in agent
  for (const name of agentNames) {
    if (!sourceNames.has(name)) {
      items.push({
        id: `skills:added:${name}`,
        category: 'skills',
        action: 'added',
        label: `Skill: ${name}`,
        agentValue: readSkillContent(worktreePath, name, conv),
      });
    }
  }

  // Removed from agent
  for (const name of sourceNames) {
    if (!agentNames.has(name)) {
      const sourceContent = readSourceSkillContent(projectPath, name);
      items.push({
        id: `skills:removed:${name}`,
        category: 'skills',
        action: 'removed',
        label: `Skill: ${name}`,
        defaultValue: replaceWildcards(sourceContent, ctx),
      });
    }
  }

  // Modified
  for (const name of agentNames) {
    if (sourceNames.has(name)) {
      const agentContent = readSkillContent(worktreePath, name, conv);
      const sourceContent = readSourceSkillContent(projectPath, name);
      const resolvedSource = replaceWildcards(sourceContent, ctx);
      if (normalizeWhitespace(agentContent) !== normalizeWhitespace(resolvedSource)) {
        items.push({
          id: `skills:modified:${name}`,
          category: 'skills',
          action: 'modified',
          label: `Skill: ${name}`,
          agentValue: agentContent,
          defaultValue: resolvedSource,
        });
      }
    }
  }
}

function diffAgentTemplates(
  items: ConfigDiffItem[],
  projectPath: string,
  worktreePath: string,
  conv: OrchestratorProvider['conventions'],
  ctx: ReturnType<typeof buildWildcardContext>,
): void {
  const sourceTemplates = listSourceAgentTemplates(projectPath);
  const agentTemplates = listAgentTemplates(worktreePath, conv);

  const sourceNames = new Set(sourceTemplates.map((t) => t.name));
  const agentNames = new Set(agentTemplates.map((t) => t.name));

  // Added in agent
  for (const name of agentNames) {
    if (!sourceNames.has(name)) {
      items.push({
        id: `agent-templates:added:${name}`,
        category: 'agent-templates',
        action: 'added',
        label: `Agent template: ${name}`,
        agentValue: readAgentTemplateContent(worktreePath, name, conv),
      });
    }
  }

  // Removed from agent
  for (const name of sourceNames) {
    if (!agentNames.has(name)) {
      const sourceContent = readSourceAgentTemplateContent(projectPath, name);
      items.push({
        id: `agent-templates:removed:${name}`,
        category: 'agent-templates',
        action: 'removed',
        label: `Agent template: ${name}`,
        defaultValue: replaceWildcards(sourceContent, ctx),
      });
    }
  }

  // Modified
  for (const name of agentNames) {
    if (sourceNames.has(name)) {
      const agentContent = readAgentTemplateContent(worktreePath, name, conv);
      const sourceContent = readSourceAgentTemplateContent(projectPath, name);
      const resolvedSource = replaceWildcards(sourceContent, ctx);
      if (normalizeWhitespace(agentContent) !== normalizeWhitespace(resolvedSource)) {
        items.push({
          id: `agent-templates:modified:${name}`,
          category: 'agent-templates',
          action: 'modified',
          label: `Agent template: ${name}`,
          agentValue: agentContent,
          defaultValue: resolvedSource,
        });
      }
    }
  }
}

// ── Propagation helpers ──────────────────────────────────────────────────

function propagatePermission(
  defaults: ReturnType<typeof readProjectAgentDefaults>,
  kind: 'allow' | 'deny',
  item: ConfigDiffItem,
): void {
  if (!defaults.permissions) defaults.permissions = {};
  if (!defaults.permissions[kind]) defaults.permissions[kind] = [];

  if (item.action === 'added' && item.rawAgentValue) {
    if (!defaults.permissions[kind]!.includes(item.rawAgentValue)) {
      defaults.permissions[kind]!.push(item.rawAgentValue);
    }
  } else if (item.action === 'removed' && item.rawAgentValue) {
    defaults.permissions[kind] = defaults.permissions[kind]!.filter(
      (r) => r !== item.rawAgentValue,
    );
  }
}

function propagateMcp(
  defaults: ReturnType<typeof readProjectAgentDefaults>,
  item: ConfigDiffItem,
  worktreePath: string,
  conv: OrchestratorProvider['conventions'],
  ctx: ReturnType<typeof buildWildcardContext>,
): void {
  let mcpObj: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
  if (defaults.mcpJson) {
    try {
      mcpObj = JSON.parse(defaults.mcpJson);
      if (!mcpObj.mcpServers) mcpObj.mcpServers = {};
    } catch { /* start fresh */ }
  }

  const serverName = item.id.split(':').slice(2).join(':');

  if (item.action === 'removed') {
    delete mcpObj.mcpServers[serverName];
  } else {
    // added or modified — read current agent value and unreplace
    try {
      const rawJson = readMcpRawJson(worktreePath, conv);
      const agentMcp = JSON.parse(rawJson);
      const serverConfig = agentMcp.mcpServers?.[serverName];
      if (serverConfig) {
        const unreplaced = JSON.parse(
          unreplaceWildcards(JSON.stringify(serverConfig), ctx),
        );
        mcpObj.mcpServers[serverName] = unreplaced;
      }
    } catch { /* skip */ }
  }

  defaults.mcpJson = JSON.stringify(mcpObj, null, 2);
}

function propagateSkill(
  projectPath: string,
  item: ConfigDiffItem,
  worktreePath: string,
  conv: OrchestratorProvider['conventions'],
  ctx: ReturnType<typeof buildWildcardContext>,
): void {
  const skillName = item.id.split(':').slice(2).join(':');

  if (item.action === 'removed') {
    deleteSourceSkill(projectPath, skillName);
  } else {
    // added or modified
    const agentContent = readSkillContent(worktreePath, skillName, conv);
    const unreplaced = unreplaceWildcards(agentContent, ctx);
    writeSourceSkillContent(projectPath, skillName, unreplaced);
  }
}

function propagateAgentTemplate(
  projectPath: string,
  item: ConfigDiffItem,
  worktreePath: string,
  conv: OrchestratorProvider['conventions'],
  ctx: ReturnType<typeof buildWildcardContext>,
): void {
  const templateName = item.id.split(':').slice(2).join(':');

  if (item.action === 'removed') {
    deleteSourceAgentTemplate(projectPath, templateName);
  } else {
    // added or modified
    const agentContent = readAgentTemplateContent(worktreePath, templateName, conv);
    const unreplaced = unreplaceWildcards(agentContent, ctx);
    writeSourceAgentTemplateContent(projectPath, templateName, unreplaced);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────

function normalizeWhitespace(s: string): string {
  return s.trim().replace(/\r\n/g, '\n');
}
