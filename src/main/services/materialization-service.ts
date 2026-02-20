import * as fs from 'fs';
import * as path from 'path';
import { DurableAgentConfig, MaterializationPreview, ProjectAgentDefaults } from '../../shared/types';
import { WildcardContext, replaceWildcards } from '../../shared/wildcard-replacer';
import { OrchestratorProvider } from '../orchestrators/types';
import {
  readProjectAgentDefaults,
  writePermissions,
  listSourceSkills,
  listSourceAgentTemplates,
  writeProjectAgentDefaults,
} from './agent-settings-service';
import { SettingsConventions } from './agent-settings-service';
import * as gitExcludeManager from './git-exclude-manager';
import { appLog } from './log-service';

const EXCLUDE_TAG = 'clubhouse-mode';

export function buildWildcardContext(agent: DurableAgentConfig, projectPath: string): WildcardContext {
  const agentPath = agent.worktreePath
    ? path.relative(projectPath, agent.worktreePath).replace(/\\/g, '/') + '/'
    : `.clubhouse/agents/${agent.name}/`;
  return {
    agentName: agent.name,
    standbyBranch: agent.branch || `${agent.name}/standby`,
    agentPath,
  };
}

/**
 * Materialize project defaults into an agent's worktree with wildcard replacement.
 * Called on agent wake when clubhouse mode is enabled.
 */
export function materializeAgent(params: {
  projectPath: string;
  agent: DurableAgentConfig;
  provider: OrchestratorProvider;
}): void {
  const { projectPath, agent, provider } = params;
  const worktreePath = agent.worktreePath;
  if (!worktreePath) return;

  const defaults = readProjectAgentDefaults(projectPath);
  if (!defaults.instructions && !defaults.permissions && !defaults.mcpJson) {
    // Also check source skills/templates
    const sourceSkills = listSourceSkills(projectPath);
    const sourceTemplates = listSourceAgentTemplates(projectPath);
    if (sourceSkills.length === 0 && sourceTemplates.length === 0) return;
  }

  const ctx = buildWildcardContext(agent, projectPath);
  const conv = provider.conventions;

  // 1. Instructions
  if (defaults.instructions) {
    const resolved = replaceWildcards(defaults.instructions, ctx);
    provider.writeInstructions(worktreePath, resolved);
  }

  // 2. Permissions
  if (defaults.permissions) {
    const resolvedPerms = {
      allow: defaults.permissions.allow?.map((r) => replaceWildcards(r, ctx)),
      deny: defaults.permissions.deny?.map((r) => replaceWildcards(r, ctx)),
    };
    writePermissions(worktreePath, resolvedPerms, conv);
  }

  // 3. MCP JSON
  if (defaults.mcpJson) {
    try {
      const resolved = replaceWildcards(defaults.mcpJson, ctx);
      JSON.parse(resolved); // Validate
      const mcpPath = path.join(worktreePath, conv.mcpConfigFile);
      const dir = path.dirname(mcpPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(mcpPath, resolved, 'utf-8');
    } catch {
      appLog('core:materialization', 'warn', 'Skipping invalid MCP JSON during materialization', {
        meta: { agentName: agent.name },
      });
    }
  }

  // 4. Source skills → copy to worktree with wildcard replacement
  copySourceDir(projectPath, worktreePath, 'skills', conv, ctx);

  // 5. Source agent templates → copy to worktree with wildcard replacement
  copySourceDir(projectPath, worktreePath, 'agentTemplates', conv, ctx);

  appLog('core:materialization', 'info', `Materialized settings for agent ${agent.name}`, {
    meta: { agentName: agent.name, projectPath },
  });
}

/**
 * Preview materialization results without writing files.
 */
export function previewMaterialization(params: {
  projectPath: string;
  agent: DurableAgentConfig;
  provider: OrchestratorProvider;
}): MaterializationPreview {
  const { projectPath, agent, provider } = params;
  const defaults = readProjectAgentDefaults(projectPath);
  const ctx = buildWildcardContext(agent, projectPath);
  const conv = provider.conventions;

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

  const sourceSkills = listSourceSkills(projectPath);
  const sourceTemplates = listSourceAgentTemplates(projectPath);

  return {
    instructions,
    permissions,
    mcpJson,
    skills: sourceSkills.map((s) => s.name),
    agentTemplates: sourceTemplates.map((t) => t.name),
  };
}

/**
 * Copy source skills or agent templates from .clubhouse to worktree,
 * applying wildcard replacement to file contents.
 */
function copySourceDir(
  projectPath: string,
  worktreePath: string,
  kind: 'skills' | 'agentTemplates',
  conv: SettingsConventions,
  ctx: WildcardContext,
): void {
  const sources = kind === 'skills'
    ? listSourceSkills(projectPath)
    : listSourceAgentTemplates(projectPath);

  if (sources.length === 0) return;

  const targetSubdir = kind === 'skills' ? conv.skillsDir : conv.agentTemplatesDir;
  const targetBaseDir = path.join(worktreePath, conv.configDir, targetSubdir);

  for (const source of sources) {
    const targetDir = path.join(targetBaseDir, source.name);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    copyDirRecursive(source.path, targetDir, ctx);
  }
}

function copyDirRecursive(src: string, dest: string, ctx: WildcardContext): void {
  try {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
        copyDirRecursive(srcPath, destPath, ctx);
      } else {
        // Apply wildcard replacement to text files
        try {
          const content = fs.readFileSync(srcPath, 'utf-8');
          fs.writeFileSync(destPath, replaceWildcards(content, ctx), 'utf-8');
        } catch {
          // Binary file or read error — copy as-is
          fs.copyFileSync(srcPath, destPath);
        }
      }
    }
  } catch {
    // Source dir may not exist
  }
}

/**
 * Create default template content when clubhouse mode is first enabled
 * and no agentDefaults exist yet.
 */
export function ensureDefaultTemplates(projectPath: string): void {
  const existing = readProjectAgentDefaults(projectPath);
  if (existing.instructions || existing.permissions || existing.mcpJson) return;

  const defaultInstructions = `You are an agent named *@@AgentName*. Your standby branch is @@StandbyBranch.
Avoid pushing to remote from your standby branch.

You are working in a Git Worktree at \`@@Path\`. You have a full copy of the
source code in this worktree. **Scope all reading and writing to \`@@Path\`**.
Do not modify files outside your worktree or in the project root.

When given a mission:
1. Create a branch \`@@AgentName/<mission-name>\` based off origin/main
2. Create test plans and test cases for the work
3. Implement the work, committing frequently with descriptive messages
4. Run full validation (build, test, lint) to verify changes
5. Push changes and open a PR to main with descriptive details
6. Return to your standby branch and pull latest from main`;

  const defaultPermissions = {
    allow: [
      'Read(@@Path**)',
      'Edit(@@Path**)',
      'Write(@@Path**)',
      'Bash(cd @@Path**)',
    ],
    deny: [
      'Read(../**)',
      'Edit(../**)',
      'Write(../**)',
    ],
  };

  const defaults: ProjectAgentDefaults = {
    instructions: defaultInstructions,
    permissions: defaultPermissions,
  };

  writeProjectAgentDefaults(projectPath, defaults);

  // Also create the default mission skill as a source skill
  ensureDefaultMissionSkill(projectPath);
}

/**
 * Create the default mission skill in the project's source skills directory.
 */
function ensureDefaultMissionSkill(projectPath: string): void {
  const clubhouseDir = path.join(projectPath, '.clubhouse');
  const skillsDir = path.join(clubhouseDir, 'skills');
  const missionDir = path.join(skillsDir, 'mission');

  if (fs.existsSync(path.join(missionDir, 'SKILL.md'))) return;

  if (!fs.existsSync(missionDir)) {
    fs.mkdirSync(missionDir, { recursive: true });
  }

  const missionSkillContent = `---
name: mission
description: Perform a coding task such as implementing a feature or fixing a bug following a defined series of steps and best practices
---

# Mission Skill

## Critical Rules
1. **Stay in your work tree** - you can look at your \`cwd\` to know your current root; you should not need to read or modify files outside your current root
2. **Work in a branch** - you should perform your work in a branch. The correct naming convention is <agent-name>/<mission-name>. You should create a short name for your mission
3. **Write new tests** - if you implement new functionality you must write tests to prevent future regressions

## Workflow
The mission begins when a prompt provides detail on what needs to be accomplished.

1. Create your working branch, based off origin/main
2. Ask clarifying questions of the user to ensure the outcome is fully captured
3. Create a test plan with test cases and acceptance criteria
4. Proceed to implement the work, committing regularly with descriptive messages
5. Validate your work by running \`npm run validate\` to perform full E2E tests on the product
6. Fix any test failures and run again; repeat until all tests pass
7. Commit any remaining work and push your branch to remote
8. Create a PR using the gh CLI; provide rich description about the changes made and test cases as well as any manual validation needed for this work.
9. Once the PR is created, return to your standby branch and pull the latest from origin/main; await further instructions

**Clean State** - your standby state should be clean from untracked or uncommitted changes; if this is not the case let the user know before starting next work
`;

  fs.writeFileSync(path.join(missionDir, 'SKILL.md'), missionSkillContent, 'utf-8');

  // Ensure the source skills path is set in project settings
  const settingsPath = path.join(clubhouseDir, 'settings.json');
  try {
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      // File doesn't exist
    }
    if (!settings.defaultSkillsPath) {
      settings.defaultSkillsPath = 'skills';
      if (!fs.existsSync(clubhouseDir)) fs.mkdirSync(clubhouseDir, { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    }
  } catch {
    // Best effort
  }
}

/**
 * Enable git exclude entries for clubhouse-mode-managed files.
 * Uses .git/info/exclude so entries are shared across worktrees instantly.
 */
export function enableExclusions(projectPath: string, provider: OrchestratorProvider): void {
  const conv = provider.conventions;
  const patterns = [
    conv.legacyInstructionsFile,                                    // e.g. CLAUDE.md
    `${conv.configDir}/${conv.localSettingsFile}`,                  // e.g. .claude/settings.local.json
    conv.mcpConfigFile,                                             // e.g. .mcp.json
    `${conv.configDir}/${conv.skillsDir}/`,                         // e.g. .claude/skills/
    `${conv.configDir}/${conv.agentTemplatesDir}/`,                 // e.g. .claude/agents/
  ];
  gitExcludeManager.addExclusions(projectPath, EXCLUDE_TAG, patterns);
}

/**
 * Remove clubhouse-mode git exclude entries.
 */
export function disableExclusions(projectPath: string): void {
  gitExcludeManager.removeExclusions(projectPath, EXCLUDE_TAG);
}
