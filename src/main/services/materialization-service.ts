import { parseMcpJson } from '../../shared/mcp-config';
import * as fsp from 'fs/promises';
import type { McpServerDef } from '../../shared/types';
import * as path from 'path';
import { pathExists } from './fs-utils';
import { AgentWildcardSettings, DurableAgentConfig, MaterializationPreview, ProjectAgentDefaults, SourceControlProvider } from '../../shared/types';
import { WildcardContext, replaceWildcards } from '../../shared/wildcard-replacer';
import { OrchestratorProvider } from '../orchestrators/types';
import {
  readProjectAgentDefaults,
  readLocalMcpJson,
  writePermissions,
  assertPermissionRulesSupported,
  listSourceSkills,
  listSourceAgentTemplates,
  writeProjectAgentDefaults,
  listSourceMissions,
  readSourceMissionContent,
  getMcpShadowWarning,
} from './agent-settings-service';
import { SettingsConventions } from './agent-settings-service';
import * as clubhouseModeSettings from './clubhouse-mode-settings';
import { effectiveAppSourceControlProvider } from './source-control-settings';
import * as gitExcludeManager from './git-exclude-manager';
import { appLog } from './log-service';
import { jsonMcpToToml } from './toml-utils';
import { legacyPersonaBody, legacyPersonaId } from './managed-agents/legacy-migration';

const EXCLUDE_TAG = 'clubhouse-mode';

import {
  MISSION_SKILL_CONTENT,
  CREATE_PR_SKILL_CONTENT,
  GO_STANDBY_SKILL_CONTENT,
  BUILD_SKILL_CONTENT,
  TEST_SKILL_CONTENT,
  LINT_SKILL_CONTENT,
  VALIDATE_CHANGES_SKILL_CONTENT,
  CLUBHOUSE_MODE_README_CONTENT,
} from './materialization-service-content';

export {
  MISSION_SKILL_CONTENT,
  CREATE_PR_SKILL_CONTENT,
  GO_STANDBY_SKILL_CONTENT,
  BUILD_SKILL_CONTENT,
  TEST_SKILL_CONTENT,
  LINT_SKILL_CONTENT,
  VALIDATE_CHANGES_SKILL_CONTENT,
  CLUBHOUSE_MODE_README_CONTENT,
};

// ── Wildcard context ─────────────────────────────────────────────────────

export function buildWildcardContext(
  agent: DurableAgentConfig,
  projectPath: string,
  sourceControlProvider?: SourceControlProvider,
  commands?: { buildCommand?: string; testCommand?: string; lintCommand?: string },
  mission?: string,
  persona?: string,
): WildcardContext {
  const agentPath = agent.worktreePath
    ? path.relative(projectPath, agent.worktreePath).replace(/\\/g, '/') + '/'
    : `.clubhouse/agents/${agent.name}/`;
  return {
    agentName: agent.name,
    standbyBranch: agent.branch || `${agent.name}/standby`,
    agentPath,
    sourceControlProvider,
    buildCommand: commands?.buildCommand,
    testCommand: commands?.testCommand,
    lintCommand: commands?.lintCommand,
    mission,
    persona,
  };
}

/**
 * Resolve the effective mission ID for an agent.
 * Per-agent override (`agent.mission`) wins; otherwise falls back to project default
 * (`defaults.mission`). Returns undefined when neither is set.
 */
export function resolveMissionId(
  agent: DurableAgentConfig,
  defaults: ProjectAgentDefaults,
): string | undefined {
  return agent.mission ?? defaults.mission;
}

/**
 * Resolve the effective build/test/lint commands for an agent.
 * Per-agent override (`agent.*Command`) wins; otherwise falls back to project
 * defaults. Undefined fields are left undefined so the wildcard replacer can
 * apply its built-in fallbacks.
 */
export function resolveAgentCommands(
  agent: DurableAgentConfig,
  defaults: ProjectAgentDefaults,
): { buildCommand?: string; testCommand?: string; lintCommand?: string } {
  return {
    buildCommand: agent.buildCommand ?? defaults.buildCommand,
    testCommand: agent.testCommand ?? defaults.testCommand,
    lintCommand: agent.lintCommand ?? defaults.lintCommand,
  };
}

// ── Source control provider resolution ───────────────────────────────────

/**
 * Resolve the effective source control provider.
 * Priority: per-agent override → project-level agentDefaults → app-level
 * source control setting → app-level clubhouse mode settings (before D61) → 'github'.
 */
export async function resolveSourceControlProvider(
  projectPath: string,
  agent?: DurableAgentConfig,
): Promise<SourceControlProvider> {
  // 0. Per-agent override
  if (agent?.sourceControlProvider) return agent.sourceControlProvider;

  // 1. Project-level
  const defaults = await readProjectAgentDefaults(projectPath);
  if (defaults.sourceControlProvider) return defaults.sourceControlProvider;

  // 2. App level: its own setting (D61), then where Clubhouse Mode kept it before, then GitHub.
  return effectiveAppSourceControlProvider();
}

/**
 * Build the resolved per-agent wildcard actuals used to populate the simple
 * settings form when an agent is managed by Clubhouse Mode. Resolution mirrors
 * materialization exactly so the form shows what would actually be substituted.
 */
export async function getAgentWildcards(
  projectPath: string,
  agent: DurableAgentConfig,
): Promise<AgentWildcardSettings> {
  const defaults = await readProjectAgentDefaults(projectPath);
  const agentPath = agent.worktreePath
    ? path.relative(projectPath, agent.worktreePath).replace(/\\/g, '/') + '/'
    : `.clubhouse/agents/${agent.name}/`;

  const resolvedScp = await resolveSourceControlProvider(projectPath, agent);
  const commands = resolveAgentCommands(agent, defaults);

  const missionOverride = agent.mission ?? null;
  const missionDefault = defaults.mission ?? null;
  const missions = await listSourceMissions(projectPath);

  return {
    agentName: agent.name,
    standbyBranch: agent.branch || `${agent.name}/standby`,
    agentPath,
    sourceControlProvider: { override: agent.sourceControlProvider ?? null, resolved: resolvedScp },
    buildCommand: { override: agent.buildCommand ?? null, resolved: commands.buildCommand || 'npm run package' },
    testCommand: { override: agent.testCommand ?? null, resolved: commands.testCommand || 'npm test' },
    lintCommand: { override: agent.lintCommand ?? null, resolved: commands.lintCommand || 'npm run lint' },
    mission: { override: missionOverride, projectDefault: missionDefault, resolved: missionOverride ?? missionDefault },
    missions: missions.map((m) => ({ id: m.id })),
  };
}

// ── Materialization ──────────────────────────────────────────────────────

/**
 * Materialize project defaults into an agent's worktree with wildcard replacement.
 * Called on agent wake when clubhouse mode is enabled.
 */
export async function materializeAgent(params: {
  projectPath: string;
  agent: DurableAgentConfig;
  provider: OrchestratorProvider;
}): Promise<void> {
  const { projectPath, agent, provider } = params;
  const worktreePath = agent.worktreePath;
  if (!worktreePath) return;

  // Refresh the self-edit guide on every materialize (deduped per session).
  // Runs before the early-out below so it fires even when an agent has no
  // other materialization work to do.
  await refreshClubhouseModeReadme(projectPath);

  const defaults = await readProjectAgentDefaults(projectPath);
  const missionId = resolveMissionId(agent, defaults);
  if (!defaults.instructions && !defaults.permissions && !defaults.mcpJson && !missionId) {
    // Also check source skills/templates
    const sourceSkills = await listSourceSkills(projectPath);
    const sourceTemplates = await listSourceAgentTemplates(projectPath);
    if (sourceSkills.length === 0 && sourceTemplates.length === 0) return;
  }

  const scp = await resolveSourceControlProvider(projectPath, agent);
  const commands = resolveAgentCommands(agent, defaults);
  const missionContent = missionId ? await readSourceMissionContent(projectPath, missionId) : undefined;
  // Personas were retired (#2901): @@Persona resolves empty and nothing is appended.
  const ctx = buildWildcardContext(agent, projectPath, scp, commands, missionContent);
  const conv = provider.conventions;
  if (defaults.permissions) assertPermissionRulesSupported(defaults.permissions, conv);
  if (defaults.mcpJson && !agent.clubhouseModeOverride && (!conv.settingsFormat || conv.settingsFormat === 'json')) {
    const local = await readLocalMcpJson(worktreePath, conv);
    if (local !== null) parseMcpJson(local);
  }
  if (defaults.mcpJson && !agent.clubhouseModeOverride) parseMcpJson(replaceWildcards(defaults.mcpJson, ctx));

  // 0. Clean up stale JSON content in TOML config files (legacy migration)
  if (conv.settingsFormat === 'toml') {
    await cleanupStaleJsonInTomlConfigs(worktreePath, conv);
  }

  // 1. Instructions (project defaults)
  const instructions = instructionsToWrite(defaults.instructions, undefined, ctx);
  if (instructions !== null) await provider.writeInstructions(worktreePath, instructions);

  // 3. Local overrides own their entire MCP map.
  if (defaults.mcpJson && !agent.clubhouseModeOverride) {
    try {
      const resolved = replaceWildcards(defaults.mcpJson, ctx);
      const mcpPath = path.join(worktreePath, conv.mcpConfigFile);
      const dir = path.dirname(mcpPath);
      const shadowWarning = await getMcpShadowWarning(worktreePath, conv);
      if (shadowWarning) {
        appLog('core:materialization', 'warn', shadowWarning, { meta: { agentName: agent.name, mcpConfigFile: conv.mcpConfigFile } });
      }
      await fsp.mkdir(dir, { recursive: true });

      if (conv.settingsFormat === 'toml') {
        // Convert JSON MCP config to TOML format for Codex CLI
        const tomlContent = jsonMcpToToml(resolved);
        if (tomlContent) {
          // Read existing TOML content and append MCP sections
          let existing = '';
          try {
            existing = await fsp.readFile(mcpPath, 'utf-8');
          } catch {
            // File doesn't exist — start fresh
          }
          // Strip any existing mcp_servers sections from the file,
          // then append the new ones to avoid duplicates
          const { stripMcpServerSection } = await import('./toml-utils');
          let cleaned = existing;
          // Parse the JSON to get server names so we can strip them
          const parsed = JSON.parse(resolved);
          const servers = parsed.mcpServers || parsed.mcp_servers || {};
          for (const name of Object.keys(servers)) {
            cleaned = stripMcpServerSection(cleaned, name);
          }
          cleaned = cleaned.trimEnd();
          const separator = cleaned.length > 0 ? '\n\n' : '';
          await fsp.writeFile(mcpPath, cleaned + separator + tomlContent, 'utf-8');
        }
      } else {
        // JSON format — validate and write directly
        JSON.parse(resolved); // Validate
        await fsp.writeFile(mcpPath, resolved, 'utf-8');
      }
    } catch {
      appLog('core:materialization', 'warn', 'Skipping invalid MCP config during materialization', {
        meta: { agentName: agent.name },
      });
    }
  }

  // 4. Source skills → copy to worktree with wildcard replacement
  await copySourceDir(projectPath, worktreePath, 'skills', conv, ctx);

  // 5. Source agent templates → copy to worktree with wildcard replacement
  await copySourceDir(projectPath, worktreePath, 'agentTemplates', conv, ctx);

  // 2. Permissions
  if (defaults.permissions) {
    const resolvedPerms = {
      allow: defaults.permissions.allow?.map((r) => replaceWildcards(r, ctx)),
      deny: defaults.permissions.deny?.map((r) => replaceWildcards(r, ctx)),
    };
    await writePermissions(worktreePath, resolvedPerms, conv);
  }

  appLog('core:materialization', 'info', `Materialized settings for agent ${agent.name}`, {
    meta: { agentName: agent.name, projectPath },
  });
}

/**
 * Step 1 of materializeAgent: the instructions file it writes, or null when it
 * writes none and leaves the file as it is. `persona` is a legacy persona's
 * text, which only the switch to managed passes (materializedInstructions): it
 * is added after the template unless the template places it with @@Persona.
 */
function instructionsToWrite(
  template: string | undefined,
  persona: string | undefined,
  ctx: WildcardContext,
): string | null {
  const resolvedPersona = persona ? replaceWildcards(persona, ctx) : undefined;
  if (template) {
    const resolved = replaceWildcards(template, ctx);
    return resolvedPersona && !template.includes('@@Persona') ? `${resolved}\n\n${resolvedPersona}` : resolved;
  }
  return resolvedPersona ?? null;
}

/**
 * The instructions file Clubhouse Mode would write for this agent at its next
 * wake, wildcards and @@If blocks resolved, or null when it writes none (#2901).
 * Reads only. Switching a Clubhouse Mode agent to managed keeps this, so one
 * that never woke doesn't bring over the raw project template. An agent that
 * still has a legacy persona keeps that persona's text too, as Clubhouse Mode
 * wrote it before personas were retired (managed-agents/legacy-migration).
 */
export async function materializedInstructions(projectPath: string, agent: DurableAgentConfig): Promise<string | null> {
  const persona = agent.managed ? undefined : await legacyPersonaBody(projectPath, await legacyPersonaId(projectPath, agent));
  const { defaults, ctx } = await clubhouseModeResolution(projectPath, agent, persona);
  return instructionsToWrite(defaults.instructions, persona, ctx);
}

/** What Clubhouse Mode delivers besides the instructions file, as materializeAgent resolves it. */
export interface MaterializedDefaults {
  /** The project's source skill folders, which step 4 copies into the worktree, in name order. */
  skills: Array<{ name: string; path: string }>;
  /** The MCP config step 3 writes, wildcards resolved, or null when it writes none. Neither parsed nor checked. */
  mcpJson: string | null;
  /** The wildcard replacement step 4 applies to each text file it copies. */
  resolveText: (text: string) => string;
}

/**
 * The skills and MCP servers Clubhouse Mode would deliver to this agent at its
 * next wake. Reads only. Switching a Clubhouse Mode agent to managed brings
 * these over too, so one that never woke, or whose last materialization
 * failed, still gets the project's defaults.
 */
export async function materializedDefaults(projectPath: string, agent: DurableAgentConfig): Promise<MaterializedDefaults> {
  const persona = agent.managed ? undefined : await legacyPersonaBody(projectPath, await legacyPersonaId(projectPath, agent));
  const { defaults, ctx } = await clubhouseModeResolution(projectPath, agent, persona);
  const skills = (await listSourceSkills(projectPath))
    .map((s) => ({ name: s.name, path: s.path }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const mcpJson = defaults.mcpJson && !agent.clubhouseModeOverride ? replaceWildcards(defaults.mcpJson, ctx) : null;
  return { skills, mcpJson, resolveText: (text) => replaceWildcards(text, ctx) };
}

/** The project defaults and wildcard context materializeAgent resolves for an agent, with a legacy persona's text for @@Persona. */
async function clubhouseModeResolution(projectPath: string, agent: DurableAgentConfig, persona?: string) {
  const defaults = await readProjectAgentDefaults(projectPath);
  const missionId = resolveMissionId(agent, defaults);
  const scp = await resolveSourceControlProvider(projectPath, agent);
  const commands = resolveAgentCommands(agent, defaults);
  const missionContent = missionId ? await readSourceMissionContent(projectPath, missionId) : undefined;
  const ctx = buildWildcardContext(agent, projectPath, scp, commands, missionContent, persona);
  return { defaults, ctx };
}

/**
 * Remove stale JSON content from TOML config files.
 * Before TOML-aware guards were added, Clubhouse could write JSON to
 * .codex/config.toml. Codex CLI's TOML parser rejects this with
 * "invalid key-value pair, expected key". This cleanup runs during
 * materialization to fix pre-existing corrupted files.
 */
export async function cleanupStaleJsonInTomlConfigs(
  worktreePath: string,
  conv: SettingsConventions,
): Promise<void> {
  const filesToCheck = [
    path.join(worktreePath, conv.mcpConfigFile),
    path.join(worktreePath, conv.configDir, conv.localSettingsFile),
  ];

  // Deduplicate — mcpConfigFile and configDir/localSettingsFile may resolve to the same path
  const uniquePaths = [...new Set(filesToCheck.map((p) => path.resolve(p)))];

  for (const filePath of uniquePaths) {
    try {
      const content = await fsp.readFile(filePath, 'utf-8');
      const trimmed = content.trimStart();
      if (trimmed.startsWith('{')) {
        // File contains JSON object — remove it so the CLI can start fresh
        // Note: we don't check for '[' because TOML section headers also start with '['
        await fsp.unlink(filePath);
        appLog('core:materialization', 'info', 'Removed stale JSON content from TOML config file', {
          meta: { filePath },
        });
      }
    } catch {
      // File doesn't exist — nothing to clean up
    }
  }
}

/** Project defaults with agent wildcards. Invalid desired config is an explicit failure. */
export async function resolveProjectMcpServers(
  projectPath: string,
  agent?: DurableAgentConfig,
): Promise<Record<string, McpServerDef>> {
  // Managed agents (#2896) get exactly their MCP server parts, never project defaults.
  if (agent?.managed) {
    const { managedMcpServersFor } = await import('./managed-agents');
    return managedMcpServersFor(agent);
  }
  const defaults = await readProjectAgentDefaults(projectPath);
  if (!defaults.mcpJson) return {};
  let json = defaults.mcpJson;
  if (agent) {
    const scp = await resolveSourceControlProvider(projectPath, agent);
    json = replaceWildcards(json, buildWildcardContext(agent, projectPath, scp, resolveAgentCommands(agent, defaults)));
  }
  const { clubhouse: _clubhouse, ...rest } = parseMcpJson(json);
  return rest;
}

/**
 * Local overrides/unmanaged: the whole local map wins, including an empty map.
 * Missing local file inherits project defaults. Managed agents use defaults.
 * Read before injecting the live bridge: injection can create an otherwise missing file.
 */
export async function resolveAgentMcpServers(
  projectPath: string,
  agent: DurableAgentConfig | undefined,
  local: { cwd: string; conventions: SettingsConventions; onNotice?: (message: string) => void },
): Promise<Record<string, McpServerDef>> {
  if (agent?.managed) return resolveProjectMcpServers(projectPath, agent);
  const managed = clubhouseModeSettings.isClubhouseModeEnabled(projectPath) && !!agent && !agent.clubhouseModeOverride;
  // No TOML reader exists here. Preserve canonical delivery and make the limitation visible.
  if (local.conventions.settingsFormat === 'toml') {
    local.onNotice?.('Local TOML MCP configuration is not supported by chat preparation. Chat uses project MCP JSON defaults; local TOML servers are not delivered by this path. The local file is preserved.');
    return resolveProjectMcpServers(projectPath, agent);
  }
  const raw = await readLocalMcpJson(local.cwd, local.conventions);
  const servers = raw === null ? undefined : parseMcpJson(raw);
  if (managed || !servers) return resolveProjectMcpServers(projectPath, agent);
  const { clubhouse: _clubhouse, ...rest } = servers;
  if (_clubhouse) {
    const message = 'Configured clubhouse entry is reserved; only the separately controlled live bridge is delivered.';
    appLog('core:mcp', 'warn', message);
    local.onNotice?.(message);
  }
  return rest;
}

export async function previewMaterialization(params: {
  projectPath: string;
  agent: DurableAgentConfig;
  provider: OrchestratorProvider;
}): Promise<MaterializationPreview> {
  const { projectPath, agent, provider } = params;
  const defaults = await readProjectAgentDefaults(projectPath);
  const scp = await resolveSourceControlProvider(projectPath, agent);
  const commands = resolveAgentCommands(agent, defaults);
  const missionId = resolveMissionId(agent, defaults);
  const missionContent = missionId ? await readSourceMissionContent(projectPath, missionId) : undefined;
  const ctx = buildWildcardContext(agent, projectPath, scp, commands, missionContent);
  const _conv = provider.conventions;

  const instructions = defaults.instructions
    ? replaceWildcards(defaults.instructions, ctx)
    : '';

  const permissions = defaults.permissions
    ? {
        allow: defaults.permissions.allow?.map((r) => replaceWildcards(r, ctx)),
        deny: defaults.permissions.deny?.map((r) => replaceWildcards(r, ctx)),
      }
    : {};

  let mcpJson: string | null = null;
  if (defaults.mcpJson) {
    try {
      const resolved = replaceWildcards(defaults.mcpJson, ctx);
      JSON.parse(resolved);
      mcpJson = resolved;
    } catch {
      mcpJson = null;
    }
  }

  const sourceSkills = await listSourceSkills(projectPath);
  const sourceTemplates = await listSourceAgentTemplates(projectPath);

  return {
    instructions,
    permissions,
    mcpJson,
    skills: sourceSkills.map((s) => s.name),
    agentTemplates: sourceTemplates.map((t) => t.name),
  };
}

// ── Source dir copy ──────────────────────────────────────────────────────

/**
 * Copy source skills or agent templates from .clubhouse to worktree,
 * applying wildcard replacement to file contents.
 * Also prunes worktree items that no longer exist in source to prevent
 * ghost items from persisting across wake/sleep cycles.
 */
async function copySourceDir(
  projectPath: string,
  worktreePath: string,
  kind: 'skills' | 'agentTemplates',
  conv: SettingsConventions,
  ctx: WildcardContext,
): Promise<void> {
  const sources = kind === 'skills'
    ? await listSourceSkills(projectPath)
    : await listSourceAgentTemplates(projectPath);

  const targetSubdir = kind === 'skills' ? conv.skillsDir : conv.agentTemplatesDir;
  const targetBaseDir = path.join(worktreePath, conv.configDir, targetSubdir);

  // Copy source items to worktree
  for (const source of sources) {
    const targetDir = path.join(targetBaseDir, source.name);
    await fsp.mkdir(targetDir, { recursive: true });
    await copyDirRecursive(source.path, targetDir, ctx);
  }

  // Prune worktree items that no longer exist in source.
  // This prevents ghost items (e.g. skills removed from source) from
  // persisting in agent worktrees and triggering repeated config-diff prompts.
  await pruneStaleItems(targetBaseDir, new Set(sources.map((s) => s.name)), kind);
}

async function copyDirRecursive(src: string, dest: string, ctx: WildcardContext): Promise<void> {
  try {
    const entries = await fsp.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        await fsp.mkdir(destPath, { recursive: true });
        await copyDirRecursive(srcPath, destPath, ctx);
      } else {
        // Apply wildcard replacement to text files
        try {
          const content = await fsp.readFile(srcPath, 'utf-8');
          await fsp.writeFile(destPath, replaceWildcards(content, ctx), 'utf-8');
        } catch {
          // Binary file or read error — copy as-is
          await fsp.copyFile(srcPath, destPath);
        }
      }
    }
  } catch {
    // Source dir may not exist
  }
}

/**
 * Remove items from the worktree target directory that no longer exist in source.
 * Only removes directories (skills) or .md files (agent templates) to avoid
 * deleting unrelated files.
 */
async function pruneStaleItems(
  targetBaseDir: string,
  sourceNames: Set<string>,
  kind: 'skills' | 'agentTemplates',
): Promise<void> {
  try {
    const entries = await fsp.readdir(targetBaseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!sourceNames.has(entry.name)) {
        const targetPath = path.join(targetBaseDir, entry.name);
        if (kind === 'skills' && entry.isDirectory()) {
          await fsp.rm(targetPath, { recursive: true, force: true });
          appLog('core:materialization', 'info', `Pruned stale skill "${entry.name}" from worktree`);
        } else if (kind === 'agentTemplates') {
          if (entry.isDirectory()) {
            await fsp.rm(targetPath, { recursive: true, force: true });
            appLog('core:materialization', 'info', `Pruned stale agent template dir "${entry.name}" from worktree`);
          } else if (entry.name.endsWith('.md') && !sourceNames.has(entry.name.replace(/\.md$/, ''))) {
            await fsp.unlink(targetPath);
            appLog('core:materialization', 'info', `Pruned stale agent template file "${entry.name}" from worktree`);
          }
        }
      }
    }
  } catch {
    // Target dir may not exist yet — nothing to prune
  }
}

// ── Default templates & skills ───────────────────────────────────────────

/**
 * Build the default agent templates (instructions + permissions).
 */
export function getDefaultAgentTemplates(): ProjectAgentDefaults {
  const defaultInstructions = `You are an agent named *@@AgentName*. Your standby branch is @@StandbyBranch.
Avoid pushing to remote from your standby branch.

You are working in a Git Worktree at \`@@Path\`. You have a full copy of the
source code in this worktree. **Scope all reading and writing to \`@@Path\`**.
Do not modify files outside your worktree or in the project root.

When given a mission:
1. Create a branch \`@@AgentName/<mission-name>\` based off origin/main
2. Create test plans and test cases for the work
3. Implement the work, committing frequently with descriptive messages
4. Validate changes using \`/validate-changes\` (build, test, lint)
5. Push changes and open a PR to main with descriptive details
6. Return to your standby branch and pull latest from main`;

  const defaultPermissions = {
    allow: [
      'Read(@@Path**)',
      'Edit(@@Path**)',
      'Write(@@Path**)',
      'Bash(cd @@Path**)',
      'Bash(git:*)',
      'Bash(gh pr:*)',
      'Bash(gh issue:*)',
      'Bash(az repos:*)',
      'Bash(az devops:*)',
      'Bash(npm:*)',
      'Bash(npx:*)',
      'Bash(yarn:*)',
      'Bash(pnpm:*)',
      'Bash(cargo:*)',
      'Bash(make:*)',
      'Bash(go:*)',
      'Bash(pip:*)',
      'Bash(python:*)',
      'Bash(mvn:*)',
      'Bash(gradle:*)',
      'Bash(dotnet:*)',
      'Bash(grep:*)',
      'Bash(find:*)',
      'Bash(head:*)',
      'Bash(tail:*)',
      'WebSearch',
    ],
    deny: [
      'Read(../**)',
      'Edit(../**)',
      'Write(../**)',
    ],
  };

  return {
    instructions: defaultInstructions,
    permissions: defaultPermissions,
  };
}

/**
 * Create default template content when clubhouse mode is first enabled
 * and no agentDefaults exist yet.
 */
export async function ensureDefaultTemplates(projectPath: string): Promise<void> {
  const existing = await readProjectAgentDefaults(projectPath);
  const hasDefaults = !!(existing.instructions || existing.permissions || existing.mcpJson);

  if (!hasDefaults) {
    await writeProjectAgentDefaults(projectPath, getDefaultAgentTemplates());
  }

  // Always ensure default skills exist (even when defaults already exist)
  await ensureDefaultSkills(projectPath);

  // Refresh the self-edit guide (once per project per session).
  await refreshClubhouseModeReadme(projectPath);
}

/**
 * Reset project agent defaults to the built-in templates, overwriting any
 * existing customizations. Also resets all default skills to their built-in
 * content (overwriting stale customizations).
 */
export async function resetProjectAgentDefaults(projectPath: string): Promise<void> {
  await writeProjectAgentDefaults(projectPath, getDefaultAgentTemplates());
  await resetDefaultSkills(projectPath);
}

/** All default skill definitions. */
const DEFAULT_SKILLS: Array<{ name: string; content: string }> = [
  { name: 'mission', content: MISSION_SKILL_CONTENT },
  { name: 'create-pr', content: CREATE_PR_SKILL_CONTENT },
  { name: 'go-standby', content: GO_STANDBY_SKILL_CONTENT },
  { name: 'build', content: BUILD_SKILL_CONTENT },
  { name: 'test', content: TEST_SKILL_CONTENT },
  { name: 'lint', content: LINT_SKILL_CONTENT },
  { name: 'validate-changes', content: VALIDATE_CHANGES_SKILL_CONTENT },
];

/**
 * Ensure all default skills exist in the project's source skills directory.
 * Creates any missing skill files without overwriting existing ones.
 */
export async function ensureDefaultSkills(projectPath: string): Promise<void> {
  await writeDefaultSkills(projectPath, false);
}

/**
 * Reset all default skills to their built-in content, overwriting any
 * existing customizations.
 */
export async function resetDefaultSkills(projectPath: string): Promise<void> {
  await writeDefaultSkills(projectPath, true);
}

async function writeDefaultSkills(projectPath: string, force: boolean): Promise<void> {
  const clubhouseDir = path.join(projectPath, '.clubhouse');
  const skillsDir = path.join(clubhouseDir, 'skills');

  for (const skill of DEFAULT_SKILLS) {
    await writeSkillFile(skillsDir, skill.name, skill.content, force);
  }

  // Ensure the source skills path is set in project settings
  const settingsPath = path.join(clubhouseDir, 'settings.json');
  try {
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(await fsp.readFile(settingsPath, 'utf-8'));
    } catch {
      // File doesn't exist
    }
    if (!settings.defaultSkillsPath) {
      settings.defaultSkillsPath = 'skills';
      await fsp.mkdir(clubhouseDir, { recursive: true });
      await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    }
  } catch {
    // Best effort
  }
}

/**
 * Self-edit guide written to .clubhouse/clubhouse-mode.md on enable.
 * Documents where every Clubhouse-mode setting lives on disk so an agent
 * (or the user) can edit configuration without needing the UI.
 */
/**
 * Per-process set of project paths whose readme has already been refreshed
 * during this app session. Used to dedupe rewrites across concurrent agent
 * wakes and repeated LIST_DURABLE calls — refresh runs at most once per
 * project per session.
 */
const READMES_REFRESHED_THIS_SESSION = new Set<string>();

/**
 * Write the Clubhouse Mode self-edit guide unconditionally.
 * The file is treated as Clubhouse-owned — any existing content is replaced
 * so updates ship as the constant evolves.
 */
export async function writeClubhouseModeReadme(projectPath: string): Promise<void> {
  const clubhouseDir = path.join(projectPath, '.clubhouse');
  const readmePath = path.join(clubhouseDir, 'clubhouse-mode.md');
  await fsp.mkdir(clubhouseDir, { recursive: true });
  await fsp.writeFile(readmePath, CLUBHOUSE_MODE_README_CONTENT, 'utf-8');
}

/**
 * Refresh the readme at most once per project per app session.
 * Safe to call from hot paths (every agent wake, every LIST_DURABLE) — work
 * happens only on the first call per project, then becomes a Set lookup.
 */
export async function refreshClubhouseModeReadme(projectPath: string): Promise<void> {
  if (READMES_REFRESHED_THIS_SESSION.has(projectPath)) return;
  READMES_REFRESHED_THIS_SESSION.add(projectPath);
  await writeClubhouseModeReadme(projectPath);
}

/** Test-only: clear the session-refresh tracking so each test starts fresh. */
export function _resetReadmeRefreshTracking(): void {
  READMES_REFRESHED_THIS_SESSION.clear();
}

/**
 * Write a single skill file. When force is false, skip if the file already exists.
 */
async function writeSkillFile(skillsDir: string, name: string, content: string, force: boolean): Promise<void> {
  const dir = path.join(skillsDir, name);
  const filePath = path.join(dir, 'SKILL.md');

  if (!force && await pathExists(filePath)) return;

  await fsp.mkdir(dir, { recursive: true });

  await fsp.writeFile(filePath, content, 'utf-8');
}

// ── Git exclusions ───────────────────────────────────────────────────────

/**
 * Enable git exclude entries for clubhouse-mode-managed files.
 * Uses .git/info/exclude so entries are shared across worktrees instantly.
 */
export async function enableExclusions(projectPath: string, provider: OrchestratorProvider): Promise<void> {
  const conv = provider.conventions;
  const patterns = [
    conv.legacyInstructionsFile,                                    // e.g. CLAUDE.md
    `${conv.configDir}/${conv.localSettingsFile}`,                  // e.g. .claude/settings.local.json
    conv.mcpConfigFile,                                             // e.g. .mcp.json
    `${conv.configDir}/${conv.skillsDir}/`,                         // e.g. .claude/skills/
    `${conv.configDir}/${conv.agentTemplatesDir}/`,                 // e.g. .claude/agents/
  ];
  await gitExcludeManager.addExclusions(projectPath, EXCLUDE_TAG, patterns);
}

/**
 * Remove clubhouse-mode git exclude entries.
 */
export async function disableExclusions(projectPath: string): Promise<void> {
  await gitExcludeManager.removeExclusions(projectPath, EXCLUDE_TAG);
}
