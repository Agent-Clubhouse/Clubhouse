import * as fsp from 'fs/promises';
import * as path from 'path';
import { pathExists } from './fs-utils';
import { AgentWildcardSettings, DurableAgentConfig, MaterializationPreview, ProjectAgentDefaults, SourceControlProvider } from '../../shared/types';
import { WildcardContext, replaceWildcards, unreplaceWildcards } from '../../shared/wildcard-replacer';
import { PatternSettings, stripPersonaFrontMatter } from '../../shared/persona-pattern';
import { OrchestratorProvider } from '../orchestrators/types';
import {
  readProjectAgentDefaults,
  writePermissions,
  listSourceSkills,
  listSourceAgentTemplates,
  writeProjectAgentDefaults,
  listSourceMissions,
  readSourceMissionContent,
  listSourcePersonaFiles,
  readSourcePersonaContent,
} from './agent-settings-service';
import { SettingsConventions } from './agent-settings-service';
import * as clubhouseModeSettings from './clubhouse-mode-settings';
import * as gitExcludeManager from './git-exclude-manager';
import { appLog } from './log-service';
import { jsonMcpToToml } from './toml-utils';
import { PERSONA_TEMPLATES, getPersonaTemplate } from '../../renderer/features/assistant/content/personas';

const EXCLUDE_TAG = 'clubhouse-mode';

// ── Skill content constants ──────────────────────────────────────────────

export const MISSION_SKILL_CONTENT = `---
name: mission
description: Perform a coding task — plan, implement, validate, and deliver via pull request
---

# Mission Skill

## Critical Rules
1. **Stay in your work tree** — your \`cwd\` is your root; do not read or modify files outside it
2. **Work in a branch** — naming convention: \`<agent-name>/<mission-name>\` (keep names short)
3. **Write new tests** — new functionality must include tests to prevent regressions

## Workflow

1. Create your working branch, based off origin/main
2. Ask clarifying questions of the user to ensure the outcome is fully captured
3. Create a test plan with test cases and acceptance criteria
4. Proceed to implement the work, committing regularly with descriptive messages
5. Validate your changes by invoking the \`/validate-changes\` skill
6. Fix any failures and re-validate; repeat until all checks pass
7. Commit any remaining work and push your branch to remote
8. Create a PR by invoking the \`/create-pr\` skill
9. Return to standby by invoking the \`/go-standby\` skill

**Clean State** — your standby state should be clean from untracked or uncommitted changes; if this is not the case let the user know before starting next work
`;

export const CREATE_PR_SKILL_CONTENT = `---
name: create-pr
description: Create a pull request for the current branch using the project's configured source control provider
---

# Create Pull Request

Create a pull request for the current branch targeting main. Include a rich description covering the changes, test cases, and any manual validation needed.

@@If(github)
## Creating a Pull Request (GitHub)

Use the GitHub CLI to create a PR:

\`\`\`bash
gh pr create --title "<title>" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points summarizing the change>

## Changes
<detailed list of changes>

## Test Plan
- [ ] <test cases and acceptance criteria>

## Manual Validation
<any manual steps needed to verify>
EOF
)"
\`\`\`
@@EndIf
@@If(azure-devops)
## Creating a Pull Request (Azure DevOps)

Use the Azure CLI to create a PR:

\`\`\`bash
az repos pr create \\
  --title "<title>" \\
  --description "## Summary
<1-3 bullet points summarizing the change>

## Changes
<detailed list of changes>

## Test Plan
- [ ] <test cases and acceptance criteria>

## Manual Validation
<any manual steps needed to verify>" \\
  --source-branch <current-branch> \\
  --target-branch main
\`\`\`
@@EndIf
`;

export const GO_STANDBY_SKILL_CONTENT = `---
name: go-standby
description: Return to the standby branch and prepare for the next task
---

# Go Standby

Return to your standby branch and prepare for the next task.

## Steps

1. Check for uncommitted changes — if any exist, warn the user before proceeding
2. Switch to your standby branch:
   \`\`\`bash
   git checkout @@StandbyBranch
   \`\`\`
3. Pull latest from main:
   \`\`\`bash
   git pull origin main
   \`\`\`
4. Verify your working tree is clean
5. Await further instructions
`;

export const BUILD_SKILL_CONTENT = `---
name: build
description: Build the project using the configured build command
---

# Build

Run the project build:

\`\`\`bash
@@BuildCommand
\`\`\`

If the build fails, analyze the error output and attempt to fix the issue. Re-run until the build succeeds.
`;

export const TEST_SKILL_CONTENT = `---
name: test
description: Run the project test suite using the configured test command
---

# Test

Run the project tests:

\`\`\`bash
@@TestCommand
\`\`\`

If tests fail, analyze the failures and fix the underlying issues. Re-run until all tests pass.
`;

export const LINT_SKILL_CONTENT = `---
name: lint
description: Run the project linter using the configured lint command
---

# Lint

Run the project linter:

\`\`\`bash
@@LintCommand
\`\`\`

If there are lint errors, fix them. Re-run until the linter passes cleanly.
`;

export const VALIDATE_CHANGES_SKILL_CONTENT = `---
name: validate-changes
description: Run full validation — build, test, and lint — to verify changes before pushing
---

# Validate Changes

Run the full validation pipeline to ensure your changes are ready to push.

## Steps

1. **Build** the project:
   \`\`\`bash
   @@BuildCommand
   \`\`\`
2. **Run tests**:
   \`\`\`bash
   @@TestCommand
   \`\`\`
3. **Run linter**:
   \`\`\`bash
   @@LintCommand
   \`\`\`

If any step fails, fix the issues and re-run the full pipeline. Do not proceed until all steps pass.
`;

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
 * Resolve the effective persona ID for an agent.
 * Per-agent override (`agent.persona`) wins; otherwise falls back to project default
 * (`defaults.persona`). Returns undefined when neither is set.
 */
export function resolvePersonaId(
  agent: DurableAgentConfig,
  defaults: ProjectAgentDefaults,
): string | undefined {
  return agent.persona ?? defaults.persona;
}

/**
 * Resolve the effective persona content for a persona ID, layered by scope.
 * Precedence: project (.clubhouse/personas/<id>.md) → user
 * (~/.clubhouse/personas/<id>.md) → built-in persona template. Returns undefined
 * when none exists.
 */
export async function resolvePersonaContent(
  projectPath: string,
  personaId: string | undefined,
): Promise<string | undefined> {
  const raw = await readLayeredPersonaRaw(projectPath, personaId);
  // Strip any pattern front-matter so only the markdown body is substituted.
  return raw === undefined ? undefined : stripPersonaFrontMatter(raw);
}

/**
 * Read the raw persona file content (front-matter included) layered by scope:
 * project (.clubhouse/personas) → user (~/.clubhouse/personas) → built-in.
 * Returns undefined when none exists.
 */
export async function readLayeredPersonaRaw(
  projectPath: string,
  personaId: string | undefined,
): Promise<string | undefined> {
  if (!personaId) return undefined;
  const project = await readSourcePersonaContent(projectPath, personaId, 'project');
  if (project) return project;
  const user = await readSourcePersonaContent(projectPath, personaId, 'user');
  if (user) return user;
  return getPersonaTemplate(personaId)?.content;
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
 * clubhouse mode settings → 'github'.
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

  // 2. App-level clubhouse mode settings
  const appSettings = clubhouseModeSettings.getSettings();
  if (appSettings.sourceControlProvider) return appSettings.sourceControlProvider;

  // 3. Default
  return 'github';
}

/**
 * List persona options available to an agent: the built-in templates plus any
 * user-authored on-disk personas. When a disk persona shares an ID with a
 * built-in, the disk version wins (source reported as 'disk').
 */
export async function listAvailablePersonas(
  projectPath: string,
): Promise<Array<{ id: string; name: string; source: 'builtin' | 'user' | 'project' }>> {
  const [projectFiles, userFiles] = await Promise.all([
    listSourcePersonaFiles(projectPath, 'project'),
    listSourcePersonaFiles(projectPath, 'user'),
  ]);

  // Merge layered by precedence: project > user > built-in. The effective source
  // tag is the highest-precedence layer that defines the id.
  const byId = new Map<string, { id: string; name: string; source: 'builtin' | 'user' | 'project' }>();
  for (const p of PERSONA_TEMPLATES) {
    byId.set(p.id, { id: p.id, name: p.name, source: 'builtin' });
  }
  for (const f of userFiles) {
    byId.set(f.id, { id: f.id, name: getPersonaTemplate(f.id)?.name ?? f.id, source: 'user' });
  }
  for (const f of projectFiles) {
    byId.set(f.id, { id: f.id, name: getPersonaTemplate(f.id)?.name ?? f.id, source: 'project' });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Read persona content for editing in the UI: the effective layered RAW content
 * (project → user → built-in), front-matter included so pattern settings
 * round-trip through the editor. Returns empty string when none exists.
 */
export async function readPersonaForEdit(projectPath: string, personaId: string): Promise<string> {
  const raw = await readLayeredPersonaRaw(projectPath, personaId);
  return raw ?? '';
}

// ── Apply / extract persona patterns ─────────────────────────────────────

/** Pick the pattern-settings subset from an agent's durable config. */
function pickPatternSettings(agent: DurableAgentConfig): PatternSettings {
  const s: PatternSettings = {};
  if (agent.model) s.model = agent.model;
  if (agent.orchestrator) s.orchestrator = agent.orchestrator;
  if (agent.mcpIds && agent.mcpIds.length > 0) s.mcpIds = agent.mcpIds;
  if (agent.mcpConfigs && Object.keys(agent.mcpConfigs).length > 0) s.mcpConfigs = agent.mcpConfigs;
  if (agent.freeAgentMode) s.freeAgentMode = true;
  if (agent.structuredMode) s.structuredMode = true;
  if (agent.mission) s.mission = agent.mission;
  if (agent.buildCommand) s.buildCommand = agent.buildCommand;
  if (agent.testCommand) s.testCommand = agent.testCommand;
  if (agent.lintCommand) s.lintCommand = agent.lintCommand;
  if (agent.sourceControlProvider) s.sourceControlProvider = agent.sourceControlProvider;
  return s;
}

/**
 * Extract a reusable pattern from an agent: its instruction content (with this
 * agent's resolved values turned back into @@wildcards so the pattern is
 * portable) plus the pattern-settings subset of its config. The persona/mission
 * content is intentionally NOT folded into the wildcard context here — the
 * instructions themselves become the persona body.
 */
export async function extractAgentPattern(params: {
  projectPath: string;
  agent: DurableAgentConfig;
  provider: OrchestratorProvider;
}): Promise<{ content: string; settings: PatternSettings }> {
  const { projectPath, agent, provider } = params;
  const defaults = await readProjectAgentDefaults(projectPath);
  const scp = await resolveSourceControlProvider(projectPath, agent);
  const commands = resolveAgentCommands(agent, defaults);
  // No mission/persona content in the context: we re-genericize only identity,
  // commands, and provider so the body isn't accidentally collapsed to a token.
  const ctx = buildWildcardContext(agent, projectPath, scp, commands);

  let instructions = '';
  if (agent.worktreePath) {
    try {
      instructions = await provider.readInstructions(agent.worktreePath);
    } catch {
      instructions = '';
    }
  }
  const content = instructions ? unreplaceWildcards(instructions, ctx) : '';
  return { content, settings: pickPatternSettings(agent) };
}

/**
 * Write the agent's resolved persona body to its instructions (overwrite).
 * Used when applying a persona outside Clubhouse mode, where materialization
 * does not run on wake. Mirrors the persona-only branch of materializeAgent.
 */
export async function writeResolvedPersonaInstructions(params: {
  projectPath: string;
  agent: DurableAgentConfig;
  provider: OrchestratorProvider;
}): Promise<void> {
  const { projectPath, agent, provider } = params;
  if (!agent.worktreePath) return;
  const defaults = await readProjectAgentDefaults(projectPath);
  const personaId = resolvePersonaId(agent, defaults);
  const personaContent = await resolvePersonaContent(projectPath, personaId);
  if (!personaContent) return;
  const scp = await resolveSourceControlProvider(projectPath, agent);
  const commands = resolveAgentCommands(agent, defaults);
  const missionId = resolveMissionId(agent, defaults);
  const missionContent = missionId ? await readSourceMissionContent(projectPath, missionId) : undefined;
  const ctx = buildWildcardContext(agent, projectPath, scp, commands, missionContent, personaContent);
  await provider.writeInstructions(agent.worktreePath, replaceWildcards(personaContent, ctx));
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
  const personaOverride = agent.persona ?? null;
  const personaDefault = defaults.persona ?? null;

  const [missions, personas] = await Promise.all([
    listSourceMissions(projectPath),
    listAvailablePersonas(projectPath),
  ]);

  return {
    agentName: agent.name,
    standbyBranch: agent.branch || `${agent.name}/standby`,
    agentPath,
    sourceControlProvider: { override: agent.sourceControlProvider ?? null, resolved: resolvedScp },
    buildCommand: { override: agent.buildCommand ?? null, resolved: commands.buildCommand || 'npm run build' },
    testCommand: { override: agent.testCommand ?? null, resolved: commands.testCommand || 'npm test' },
    lintCommand: { override: agent.lintCommand ?? null, resolved: commands.lintCommand || 'npm run lint' },
    mission: { override: missionOverride, projectDefault: missionDefault, resolved: missionOverride ?? missionDefault },
    persona: { override: personaOverride, projectDefault: personaDefault, resolved: personaOverride ?? personaDefault },
    missions: missions.map((m) => ({ id: m.id })),
    personas,
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
  const personaId = resolvePersonaId(agent, defaults);
  if (!defaults.instructions && !defaults.permissions && !defaults.mcpJson && !personaId && !missionId) {
    // Also check source skills/templates
    const sourceSkills = await listSourceSkills(projectPath);
    const sourceTemplates = await listSourceAgentTemplates(projectPath);
    if (sourceSkills.length === 0 && sourceTemplates.length === 0) return;
  }

  const scp = await resolveSourceControlProvider(projectPath, agent);
  const commands = resolveAgentCommands(agent, defaults);
  const missionContent = missionId ? await readSourceMissionContent(projectPath, missionId) : undefined;
  const personaContent = await resolvePersonaContent(projectPath, personaId);
  const ctx = buildWildcardContext(agent, projectPath, scp, commands, missionContent, personaContent);
  const conv = provider.conventions;

  // 0. Clean up stale JSON content in TOML config files (legacy migration)
  if (conv.settingsFormat === 'toml') {
    await cleanupStaleJsonInTomlConfigs(worktreePath, conv);
  }

  // 1. Instructions (project defaults + persona layer)
  if (defaults.instructions) {
    const resolved = replaceWildcards(defaults.instructions, ctx);
    // Auto-append persona only when the template doesn't already use @@Persona,
    // so users who opt into the wildcard don't get the persona injected twice.
    const templateUsesPersonaToken = defaults.instructions.includes('@@Persona');
    if (personaContent && !templateUsesPersonaToken) {
      await provider.writeInstructions(worktreePath, `${resolved}\n\n${personaContent}`);
    } else {
      await provider.writeInstructions(worktreePath, resolved);
    }
  } else if (personaContent) {
    // No project defaults but agent has a persona — write persona instructions alone
    await provider.writeInstructions(worktreePath, personaContent);
  }

  // 2. Permissions
  if (defaults.permissions) {
    const resolvedPerms = {
      allow: defaults.permissions.allow?.map((r) => replaceWildcards(r, ctx)),
      deny: defaults.permissions.deny?.map((r) => replaceWildcards(r, ctx)),
    };
    await writePermissions(worktreePath, resolvedPerms, conv);
  }

  // 3. MCP config — write to the orchestrator's config file format
  if (defaults.mcpJson) {
    try {
      const resolved = replaceWildcards(defaults.mcpJson, ctx);
      const mcpPath = path.join(worktreePath, conv.mcpConfigFile);
      const dir = path.dirname(mcpPath);
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

  appLog('core:materialization', 'info', `Materialized settings for agent ${agent.name}`, {
    meta: { agentName: agent.name, projectPath },
  });
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

/**
 * Preview materialization results without writing files.
 */
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
  const personaId = resolvePersonaId(agent, defaults);
  const missionContent = missionId ? await readSourceMissionContent(projectPath, missionId) : undefined;
  const personaContent = await resolvePersonaContent(projectPath, personaId);
  const ctx = buildWildcardContext(agent, projectPath, scp, commands, missionContent, personaContent);
  const _conv = provider.conventions;

  let instructions = defaults.instructions
    ? replaceWildcards(defaults.instructions, ctx)
    : '';

  // Auto-append persona only when the template doesn't already use @@Persona.
  const templateUsesPersonaToken = defaults.instructions?.includes('@@Persona') ?? false;
  if (personaContent && !templateUsesPersonaToken) {
    instructions = instructions
      ? `${instructions}\n\n${personaContent}`
      : personaContent;
  }

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
export const CLUBHOUSE_MODE_README_CONTENT = `# Clubhouse Mode — Self-Edit Guide

This file is generated by Clubhouse. It documents where settings live on
disk and how to change them without using the UI.

> **Note:** This file is regenerated whenever Clubhouse refreshes it (on
> agent wake and on project open during a session). Local edits will be
> overwritten — treat \`.clubhouse/settings.json\`, \`.clubhouse/agents.json\`,
> \`.clubhouse/skills/\`, \`.clubhouse/missions/\`, and \`.clubhouse/personas/\` as
> the editable surfaces.

---

## Settings layers

Three layers, all editable from disk:

| Layer            | File                                                  | Scope                          |
|------------------|-------------------------------------------------------|--------------------------------|
| App-wide         | \`<userData>/clubhouse-mode-settings.json\`             | enabled flag, project overrides|
| Project          | \`.clubhouse/settings.json\`                            | defaults applied to all agents |
| Per-agent        | \`.clubhouse/agents.json\`                              | overrides for a single agent   |

\`<userData>\` is Electron's per-user app data dir:
- macOS: \`~/Library/Application Support/Clubhouse/\`
- Linux: \`~/.config/Clubhouse/\`
- Windows: \`%APPDATA%\\Clubhouse\\\`

**Precedence** (highest first): per-agent → project override → app-wide.

### Toggle Clubhouse Mode for this project (override)

Edit \`<userData>/clubhouse-mode-settings.json\`:

\`\`\`json
{
  "enabled": true,
  "projectOverrides": {
    "/absolute/path/to/this/project": true
  }
}
\`\`\`

Set the override to \`false\` to disable just this project while keeping the
app-wide setting unchanged. Delete the key to clear the override.

### Toggle per-agent override

Find the agent in \`.clubhouse/agents.json\` and add:

\`\`\`json
{ "clubhouseModeOverride": true }
\`\`\`

Setting it to \`false\` opts that agent out of materialization on wake.

---

## Project defaults (\`.clubhouse/settings.json\`)

The \`agentDefaults\` object is what gets materialized into each agent worktree
when Clubhouse Mode runs:

\`\`\`json
{
  "agentDefaults": {
    "instructions": "...CLAUDE.md template with @@wildcards...",
    "permissions": { "allow": ["Read(@@Path**)"], "deny": ["Read(../**)"] },
    "mcpJson": "{ \\"mcpServers\\": { ... } }",
    "freeAgentMode": false,
    "sourceControlProvider": "github",
    "buildCommand": "npm run build",
    "testCommand": "npm test",
    "lintCommand": "npm run lint",
    "mission": "implement-and-ship"
  }
}
\`\`\`

Any agent without an explicit override inherits these.

---

## Per-agent overrides (\`.clubhouse/agents.json\`)

Each entry in the \`agents\` array supports per-agent overrides:

\`\`\`json
{
  "id": "durable_...",
  "name": "bold-falcon",
  "branch": "bold-falcon/standby",
  "persona": "qa",
  "mission": "investigate-and-report",
  "buildCommand": "npm run build",
  "testCommand": "npm test",
  "lintCommand": "npm run lint",
  "sourceControlProvider": "github",
  "clubhouseModeOverride": true,
  "mcpIds": ["github"],
  "model": "claude-opus-4-7"
}
\`\`\`

Editable fields: \`persona\`, \`mission\`, \`buildCommand\`, \`testCommand\`,
\`lintCommand\`, \`sourceControlProvider\`, \`clubhouseModeOverride\`,
\`freeAgentMode\`, \`model\`, \`orchestrator\`, \`structuredMode\`, \`mcpIds\`,
\`mcpConfigs\`, \`mcpOverride\`.

Each of \`buildCommand\`, \`testCommand\`, \`lintCommand\`, and
\`sourceControlProvider\` is a per-agent override of the matching wildcard; when
unset the agent inherits the project default from \`agentDefaults\`. These same
overrides are what the per-agent **Wildcards** settings form writes when an
agent is managed by Clubhouse Mode (override disabled).

Edits take effect on the next agent wake (which re-materializes the worktree).

---

## Preserved skills (\`.clubhouse/skills/\`)

Skills live in \`.clubhouse/skills/<skill-name>/SKILL.md\`. On materialization
they are copied to each agent worktree at \`.claude/skills/<skill-name>/\`
with \`@@\` wildcards substituted.

- **Edit** an existing skill: change \`.clubhouse/skills/<name>/SKILL.md\`.
- **Add** a new skill: create \`.clubhouse/skills/<new-name>/SKILL.md\` with a
  YAML frontmatter \`name:\` and \`description:\`, then a markdown body.
- **Delete**: remove the directory. On next wake, the skill is pruned from
  every agent worktree automatically.

Default skills (\`mission\`, \`test\`, \`build\`, \`lint\`, \`validate-changes\`,
\`create-pr\`, \`go-standby\`) are written on enable but never overwritten —
edit them freely.

---

## Missions (\`.clubhouse/missions/\`)

A **mission** is a reusable end-to-end task flow (e.g. \`look at spec → fix →
add tests → run until green → open PR → return to standby\`). Missions are
flat markdown files under \`.clubhouse/missions/\`; the filename (minus
\`.md\`) is the mission ID.

\`\`\`
.clubhouse/missions/
  implement-and-ship.md
  investigate-and-report.md
  quick-bugfix.md
\`\`\`

At materialization, the content of the active mission file is substituted
for the \`@@Mission\` wildcard everywhere it appears (default CLAUDE.md
template, skills, permissions, etc.).

**Selecting a mission**:
- Set \`agentDefaults.mission\` in \`.clubhouse/settings.json\` for the
  project-wide default.
- Set \`mission\` on an agent in \`.clubhouse/agents.json\` to override per-agent.
- Per-agent wins. Either value is the mission ID (filename without \`.md\`).

If the mission file does not exist, \`@@Mission\` resolves to an empty string —
the rest of materialization still succeeds.

---

## Personas (\`.clubhouse/personas/\`)

A **persona** layers a role (e.g. \`qa\`, \`researcher\`, \`judge\`) onto an
agent. The content is substituted for the \`@@Persona\` wildcard, or appended to
the instructions when the template doesn't reference the token.

Clubhouse ships a built-in persona library. To customize, author an on-disk
persona file — a flat markdown file where the filename (minus \`.md\`) is the
persona ID. There are two on-disk scopes:

\`\`\`
.clubhouse/personas/        # project-scoped — this project only
  qa.md                     # overrides the built-in "qa" persona here
  my-reviewer.md            # a project-specific persona

~/.clubhouse/personas/      # user-global — reusable across ALL your projects
  my-reviewer.md            # author once, use in any project
\`\`\`

At materialization, persona content resolves by precedence: **project →
user-global → built-in**. A \`.clubhouse/personas/<id>.md\` wins; otherwise a
\`~/.clubhouse/personas/<id>.md\` is used; otherwise the built-in template of the
same ID. Built-ins are never written to disk automatically — they remain
available until you shadow one with a file of the same name. Put personas you
want everywhere in \`~/.clubhouse/personas/\`; use \`.clubhouse/personas/\` to
tweak one only for this project.

**Selecting a persona** works exactly like missions:
- Set \`agentDefaults.persona\` in \`.clubhouse/settings.json\` for the
  project-wide default.
- Set \`persona\` on an agent in \`.clubhouse/agents.json\` to override per-agent.
- Per-agent wins. Either value is the persona ID.

---

## Wildcards available to all templates

| Token                       | Resolves to                                          |
|-----------------------------|------------------------------------------------------|
| \`@@AgentName\`               | e.g. \`bold-falcon\`                                   |
| \`@@StandbyBranch\`           | e.g. \`bold-falcon/standby\`                           |
| \`@@Path\`                    | e.g. \`.clubhouse/agents/bold-falcon/\`                |
| \`@@SourceControlProvider\`   | \`github\` or \`azure-devops\`                           |
| \`@@BuildCommand\`            | from project defaults                                |
| \`@@TestCommand\`             | from project defaults                                |
| \`@@LintCommand\`             | from project defaults                                |
| \`@@Mission\`                 | full markdown content of the active mission file     |
| \`@@Persona\`                 | full markdown content of the active persona template |
| \`@@If(github)…@@EndIf\`      | conditional block, kept only when provider matches   |

Neither \`@@Mission\` nor \`@@Persona\` appear in the built-in default template — add them to your customized \`agentDefaults.instructions\` if you want the content inlined at a specific position. \`@@Persona\` also acts as an "opt out" of the default auto-append behavior: when your template contains the token, the persona content is substituted in place and not appended again at the bottom.

---

## Common edits

| Goal                                       | Edit                                                       |
|--------------------------------------------|------------------------------------------------------------|
| Change project default mission             | \`agentDefaults.mission\` in \`.clubhouse/settings.json\`     |
| Give one agent a different mission         | \`mission\` in that agent's entry in \`.clubhouse/agents.json\`|
| Change project default persona             | \`agentDefaults.persona\` in \`.clubhouse/settings.json\`     |
| Give one agent a different persona         | \`persona\` in that agent's entry in \`.clubhouse/agents.json\`|
| Customize a persona's content              | Author \`.clubhouse/personas/<id>.md\` (overrides built-in)  |
| Override a command for one agent           | \`buildCommand\`/\`testCommand\`/\`lintCommand\` in \`.clubhouse/agents.json\` |
| Tweak a skill body                         | Edit the file under \`.clubhouse/skills/<name>/SKILL.md\`    |
| Add a new wildcard target                  | (Code change — see \`src/shared/wildcard-replacer.ts\`)      |
| Disable Clubhouse Mode for this project    | \`projectOverrides[<path>] = false\` in user settings        |
| Opt one agent out of materialization       | \`clubhouseModeOverride: false\` in that agent's entry       |

---

## What gets pruned vs preserved

On every wake, materialization:

- **Overwrites** the agent's \`CLAUDE.md\`, \`.claude/settings.local.json\` permissions block, and \`.mcp.json\` from the project defaults.
- **Copies** every \`.clubhouse/skills/*\` and \`.clubhouse/agent-templates/*\` into the worktree with wildcards resolved.
- **Prunes** worktree skills/templates that no longer exist in source.
- **Never touches** any other file in the worktree, including agent-local edits to skills that don't exist in source.
`;

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
