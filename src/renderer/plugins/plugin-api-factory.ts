import type {
  PluginContext,
  PluginAPI,
  PluginRenderMode,
  PluginManifest,
  PluginContextInfo,
} from '../../shared/plugin-types';
import { gated, hasPermission } from './plugin-api-shared';
import { createStorageAPI } from './plugin-api-storage';
import { createProjectAPI, createProjectsAPI, createGitAPI } from './plugin-api-project';
import { createUIAPI, createCommandsAPI, createEventsAPI, createHubAPI, createNavigationAPI, createWidgetsAPI } from './plugin-api-ui';
import { createSettingsAPI } from './plugin-api-settings';
import { createAgentsAPI } from './plugin-api-agents';
import { createFilesAPI } from './plugin-api-files';
import { createWorkspaceAPI } from './plugin-api-workspace';
import { createBadgesAPI } from './plugin-api-badges';
import { createAgentConfigAPI } from './plugin-api-agent-config';
import { createTerminalAPI } from './plugin-api-terminal';
import { createLoggingAPI } from './plugin-api-logging';
import { createProcessAPI } from './plugin-api-process';
import { createSoundsAPI } from './plugin-api-sounds';
import { createThemeAPI } from './plugin-api-theme';
import { createCanvasAPI } from './plugin-api-canvas';
import { createWindowAPI } from './plugin-api-window';

// Re-export test helpers and utilities used by external consumers
export { _resetEnforcedViolations } from './plugin-api-shared';
export { computeDataDir, computeWorkspaceRoot } from './plugin-api-files';
export { _resetBadgeStoreCache } from './plugin-api-badges';

export function createPluginAPI(ctx: PluginContext, mode?: PluginRenderMode, manifest?: PluginManifest): PluginAPI {
  const effectiveMode = mode || (ctx.scope === 'app' ? 'app' : 'project');
  const isDual = ctx.scope === 'dual';

  // For dual-scope plugins, project API is available only in project mode
  const projectAvailable = ctx.scope === 'project' || (isDual && effectiveMode === 'project');
  // For dual-scope plugins, projects API is always available; for single scope it depends.
  // v0.8+: project-scoped plugins can also access projects API (lifted scope restriction).
  const apiVersion = manifest?.engine?.api ?? 0;
  const projectsAvailable = ctx.scope === 'app' || isDual || (ctx.scope === 'project' && apiVersion >= 0.8);
  const scopeLabel = effectiveMode === 'app' ? 'app' : ctx.scope;

  const contextInfo: PluginContextInfo = {
    mode: effectiveMode,
    projectId: ctx.projectId,
    projectPath: ctx.projectPath,
  };

  const api: PluginAPI = {
    project: gated(
      projectAvailable && !!ctx.projectPath && !!ctx.projectId, scopeLabel, 'project', 'files',
      ctx.pluginId, manifest, () => createProjectAPI(ctx),
    ),
    projects: gated(
      projectsAvailable, 'project', 'projects', 'projects',
      ctx.pluginId, manifest, () => createProjectsAPI(),
    ),
    git: gated(
      projectAvailable && !!ctx.projectPath, scopeLabel, 'git', 'git',
      ctx.pluginId, manifest, () => createGitAPI(ctx),
    ),
    storage: gated(
      true, scopeLabel, 'storage', 'storage',
      ctx.pluginId, manifest, () => createStorageAPI(ctx),
    ),
    ui: gated(
      true, scopeLabel, 'ui', 'notifications',
      ctx.pluginId, manifest, () => createUIAPI(ctx),
    ),
    commands: gated(
      true, scopeLabel, 'commands', 'commands',
      ctx.pluginId, manifest, () => createCommandsAPI(ctx),
    ),
    events: gated(
      true, scopeLabel, 'events', 'events',
      ctx.pluginId, manifest, () => createEventsAPI(),
    ),
    settings: createSettingsAPI(ctx), // always available
    agents: gated(
      true, scopeLabel, 'agents', 'agents',
      ctx.pluginId, manifest, () => createAgentsAPI(ctx, manifest),
    ),
    hub: createHubAPI(), // always available
    navigation: gated(
      true, scopeLabel, 'navigation', 'navigation',
      ctx.pluginId, manifest, () => createNavigationAPI(),
    ),
    widgets: gated(
      true, scopeLabel, 'widgets', 'widgets',
      ctx.pluginId, manifest, () => createWidgetsAPI(),
    ),
    terminal: gated(
      true, scopeLabel, 'terminal', 'terminal',
      ctx.pluginId, manifest, () => createTerminalAPI(ctx),
    ),
    logging: gated(
      true, scopeLabel, 'logging', 'logging',
      ctx.pluginId, manifest, () => createLoggingAPI(ctx),
    ),
    files: gated(
      projectAvailable && !!ctx.projectPath, scopeLabel, 'files', 'files',
      ctx.pluginId, manifest, () => createFilesAPI(ctx, manifest),
    ),
    process: gated(
      (projectAvailable && !!ctx.projectPath) || hasPermission(manifest, 'process'),
      scopeLabel, 'process', 'process',
      ctx.pluginId, manifest, () => createProcessAPI(ctx, manifest),
    ),
    badges: gated(
      true, scopeLabel, 'badges', 'badges',
      ctx.pluginId, manifest, () => createBadgesAPI(ctx),
    ),
    agentConfig: gated(
      // Available in project mode (as before), OR in app/dual-app mode when plugin has cross-project permission
      (projectAvailable && !!ctx.projectPath) || hasPermission(manifest, 'agent-config.cross-project'),
      scopeLabel, 'agentConfig', 'agent-config',
      ctx.pluginId, manifest, () => createAgentConfigAPI(ctx, manifest),
    ),
    sounds: gated(
      true, scopeLabel, 'sounds', 'sounds',
      ctx.pluginId, manifest, () => createSoundsAPI(ctx),
    ),
    theme: gated(
      true, scopeLabel, 'theme', 'theme',
      ctx.pluginId, manifest, () => createThemeAPI(ctx),
    ),
    workspace: gated(
      true, scopeLabel, 'workspace', 'workspace',
      ctx.pluginId, manifest, () => createWorkspaceAPI(ctx, manifest),
    ),
    canvas: gated(
      true, scopeLabel, 'canvas', 'canvas',
      ctx.pluginId, manifest, () => createCanvasAPI(ctx, manifest),
    ),
    window: createWindowAPI(ctx, manifest), // always available (v0.8+)
    mcp: {
      // v0.9 MCP tool contribution stubs — implementation will follow in a separate PR
      async contributeTools() { throw new Error('MCP tool contribution requires API >= 0.9 (not yet implemented)'); },
      async removeTools() { throw new Error('MCP tool contribution requires API >= 0.9 (not yet implemented)'); },
      async listContributedTools() { return []; },
      onToolCall() { return { dispose() {} }; },
    },
    context: contextInfo, // always available
  };

  return api;
}
