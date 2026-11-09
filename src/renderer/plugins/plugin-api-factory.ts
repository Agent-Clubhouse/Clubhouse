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
import { createUIAPI, createCommandsAPI, createEventsAPI, createNavigationAPI, createWidgetsAPI } from './plugin-api-ui';
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
import { createAnnexAPI } from './plugin-api-annex';
import { createMcpAPI } from './plugin-mcp-host';
import { guardNamespace } from './plugin-api-guard';

// Re-export test helpers and utilities used by external consumers
export { _resetEnforcedViolations } from './plugin-api-shared';
export { computeDataDir, computeWorkspaceRoot } from './plugin-api-files';
export { _resetBadgeStoreCache } from './plugin-api-badges';

export { _resetPluginMcpStateForTests } from './plugin-mcp-host';

export function createPluginAPI(ctx: PluginContext, mode?: PluginRenderMode, manifest?: PluginManifest): PluginAPI {
  // Ref used to pass the fully-constructed API to createCanvasAPI without a circular reference.
  // By the time a plugin calls api.canvas.registerWidgetType(), api is already assigned.
  const apiRef: { current: PluginAPI | null } = { current: null };

  const effectiveMode = mode || (ctx.scope === 'app' ? 'app' : 'project');
  const isDual = ctx.scope === 'dual';

  // For dual-scope plugins, project API is available only in project mode
  const projectAvailable = ctx.scope === 'project' || (isDual && effectiveMode === 'project');
  // For dual-scope plugins, projects API is always available; for single scope it depends.
  // v0.8+: project-scoped plugins can also access projects API (lifted scope restriction).
  const apiVersion = manifest?.engine?.api ?? 0;
  const projectsAvailable = ctx.scope === 'app' || isDual || (ctx.scope === 'project' && apiVersion >= 0.8);
  const scopeLabel = effectiveMode === 'app' ? 'app' : ctx.scope;

  // While the plugin answers an agent's tool call, what it changes is checked against that agent (D126, #3174).
  const guardScope = { ctx, manifest, base: ctx.projectPath };
  const guard = <T,>(ns: string, value: T): T => guardNamespace(ns, value, guardScope);

  const contextInfo: PluginContextInfo = {
    mode: effectiveMode,
    projectId: ctx.projectId,
    projectPath: ctx.projectPath,
  };

  const api: PluginAPI = {
    project: gated(
      projectAvailable && !!ctx.projectPath && !!ctx.projectId, scopeLabel, 'project', 'files',
      ctx.pluginId, manifest, () => guard('project', createProjectAPI(ctx)),
    ),
    projects: gated(
      projectsAvailable, 'project', 'projects', 'projects',
      ctx.pluginId, manifest, () => guard('projects', createProjectsAPI()),
    ),
    git: gated(
      projectAvailable && !!ctx.projectPath, scopeLabel, 'git', 'git',
      ctx.pluginId, manifest, () => guard('git', createGitAPI(ctx)),
    ),
    storage: gated(
      true, scopeLabel, 'storage', 'storage',
      ctx.pluginId, manifest, () => guard('storage', createStorageAPI(ctx)),
    ),
    ui: gated(
      true, scopeLabel, 'ui', 'notifications',
      ctx.pluginId, manifest, () => guard('ui', createUIAPI(ctx)),
    ),
    commands: gated(
      true, scopeLabel, 'commands', 'commands',
      ctx.pluginId, manifest, () => guard('commands', createCommandsAPI(ctx)),
    ),
    events: gated(
      true, scopeLabel, 'events', 'events',
      ctx.pluginId, manifest, () => guard('events', createEventsAPI()),
    ),
    settings: guard('settings', createSettingsAPI(ctx)), // always available
    agents: gated(
      true, scopeLabel, 'agents', 'agents',
      ctx.pluginId, manifest, () => guard('agents', createAgentsAPI(ctx, manifest)),
    ),
    navigation: gated(
      true, scopeLabel, 'navigation', 'navigation',
      ctx.pluginId, manifest, () => guard('navigation', createNavigationAPI()),
    ),
    widgets: gated(
      true, scopeLabel, 'widgets', 'widgets',
      ctx.pluginId, manifest, () => guard('widgets', createWidgetsAPI()),
    ),
    terminal: gated(
      true, scopeLabel, 'terminal', 'terminal',
      ctx.pluginId, manifest, () => guard('terminal', createTerminalAPI(ctx)),
    ),
    logging: gated(
      true, scopeLabel, 'logging', 'logging',
      ctx.pluginId, manifest, () => guard('logging', createLoggingAPI(ctx)),
    ),
    files: gated(
      projectAvailable && !!ctx.projectPath, scopeLabel, 'files', 'files',
      ctx.pluginId, manifest, () => guard('files', createFilesAPI(ctx, manifest)),
    ),
    process: gated(
      (projectAvailable && !!ctx.projectPath) || hasPermission(manifest, 'process'),
      scopeLabel, 'process', 'process',
      ctx.pluginId, manifest, () => guard('process', createProcessAPI(ctx, manifest)),
    ),
    badges: gated(
      true, scopeLabel, 'badges', 'badges',
      ctx.pluginId, manifest, () => guard('badges', createBadgesAPI(ctx)),
    ),
    agentConfig: gated(
      // Available in project mode (as before), OR in app/dual-app mode when plugin has cross-project permission
      (projectAvailable && !!ctx.projectPath) || hasPermission(manifest, 'agent-config.cross-project'),
      scopeLabel, 'agentConfig', 'agent-config',
      ctx.pluginId, manifest, () => guard('agentConfig', createAgentConfigAPI(ctx, manifest)),
    ),
    sounds: gated(
      true, scopeLabel, 'sounds', 'sounds',
      ctx.pluginId, manifest, () => guard('sounds', createSoundsAPI(ctx)),
    ),
    theme: gated(
      true, scopeLabel, 'theme', 'theme',
      ctx.pluginId, manifest, () => guard('theme', createThemeAPI(ctx)),
    ),
    workspace: gated(
      true, scopeLabel, 'workspace', 'workspace',
      ctx.pluginId, manifest, () => guard('workspace', createWorkspaceAPI(ctx, manifest)),
    ),
    canvas: gated(
      true, scopeLabel, 'canvas', 'canvas',
      ctx.pluginId, manifest, () => guard('canvas', createCanvasAPI(ctx, manifest, () => apiRef.current!)),
    ),
    window: guard('window', createWindowAPI(ctx, manifest)), // always available (v0.8+)
    annex: gated(
      true, scopeLabel, 'annex', 'annex',
      ctx.pluginId, manifest, () => guard('annex', createAnnexAPI(ctx)),
    ),
    mcp: gated(
      true, scopeLabel, 'mcp', 'mcp.tools',
      ctx.pluginId, manifest, () => guard('mcp', createMcpAPI(ctx)),
    ),
    context: contextInfo, // always available
  };

  // The Hub was removed, and `api.hub` with it, from API 0.9. A plugin on an
  // older API (0.7 or 0.8) that only reads it still gets the empty namespace
  // it always had. Keep this until 0.7 and 0.8 are removed (#2757).
  if ((manifest?.engine?.api ?? 0.9) < 0.9) {
    Object.defineProperty(api, 'hub', { value: Object.freeze({}), enumerable: true });
  }

  apiRef.current = api;
  return api;
}
