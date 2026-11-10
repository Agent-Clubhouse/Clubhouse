import type {
  PluginContext,
  PluginManifest,
  AgentConfigAPI,
  AgentConfigTargetOptions,
  PluginPermission,
} from '../../shared/plugin-types';
import { hasPermission, handlePermissionViolation } from './plugin-api-shared';
import { usePluginStore } from './plugin-store';
import { useProjectStore } from '../stores/projectStore';
import { rendererLog } from './renderer-logger';
import { pluginDiagNamespace } from '../../shared/telemetry/diag';

/**
 * Resolves the target project path for a cross-project agentConfig operation.
 * When `opts.projectId` is provided, validates:
 *   1. The plugin has the 'agent-config.cross-project' permission
 *   2. The target project exists
 *   3. The target project has this plugin enabled (bilateral consent)
 * Returns the resolved project path.
 */
/** The project an agentConfig call acts on. Exported for the plugin API's grant table (#3174). */
export function resolveAgentConfigTarget(
  opts: AgentConfigTargetOptions | undefined,
  defaultProjectPath: string | undefined,
  pluginId: string,
  manifest: PluginManifest | undefined,
): string {
  if (!opts?.projectId) {
    if (!defaultProjectPath) {
      throw new Error(
        'No project context — pass opts.projectId to target a specific project',
      );
    }
    return defaultProjectPath;
  }

  // 1. Permission check
  if (!hasPermission(manifest, 'agent-config.cross-project')) {
    handlePermissionViolation(pluginId, 'agent-config.cross-project', 'agentConfig (cross-project)');
    throw new Error(
      `Plugin '${pluginId}' requires 'agent-config.cross-project' permission to target other projects`,
    );
  }

  // 2. Resolve target project
  const project = useProjectStore.getState().projects.find((p) => p.id === opts.projectId);
  if (!project) {
    throw new Error(`Target project not found: ${opts.projectId}`);
  }

  // 3. Bilateral consent: target project must have this plugin enabled
  // App-scoped plugins are implicitly enabled in all projects
  const { projectEnabled, appEnabled } = usePluginStore.getState();
  if (!appEnabled.includes(pluginId)) {
    const enabledInTarget = projectEnabled[opts.projectId] || [];
    if (!enabledInTarget.includes(pluginId)) {
      throw new Error(
        `Plugin '${pluginId}' is not enabled in target project '${project.name}'. ` +
        'Cross-project agent config requires the plugin to be enabled in both projects.',
      );
    }
  }

  return project.path;
}

export function createAgentConfigAPI(ctx: PluginContext, manifest?: PluginManifest): AgentConfigAPI {
  const { projectPath: defaultProjectPath, pluginId } = ctx;

  // In app mode with cross-project permission, defaultProjectPath may be undefined.
  // All methods must then use opts.projectId to resolve the target.
  if (!defaultProjectPath && !hasPermission(manifest, 'agent-config.cross-project')) {
    throw new Error('AgentConfigAPI requires projectPath');
  }

  const pluginSkillPrefix = `plugin-${pluginId}-`;
  const pluginTemplatePrefix = `plugin-${pluginId}-`;
  const storageScope = 'project' as const;

  /** Helper to create scoped storage for a given project path. */
  function storageFor(targetProjectPath: string) {
    return {
      async read(key: string): Promise<unknown> {
        return window.clubhouse.plugin.storageRead({ pluginId: `_agentconfig:${pluginId}`, scope: storageScope, key, projectPath: targetProjectPath });
      },
      async write(key: string, value: unknown): Promise<void> {
        await window.clubhouse.plugin.storageWrite({ pluginId: `_agentconfig:${pluginId}`, scope: storageScope, key, value, projectPath: targetProjectPath });
      },
      async delete(key: string): Promise<void> {
        await window.clubhouse.plugin.storageDelete({ pluginId: `_agentconfig:${pluginId}`, scope: storageScope, key, projectPath: targetProjectPath });
      },
      async list(): Promise<string[]> {
        return window.clubhouse.plugin.storageList({ pluginId: `_agentconfig:${pluginId}`, scope: storageScope, projectPath: targetProjectPath });
      },
    };
  }

  /** Adding permission rules is deprecated (#3245): said once per method, never applied. */
  const warned = new Set<string>();
  function warnPermissionRulesIgnored(method: string, count: number): void {
    if (warned.has(method)) return;
    warned.add(method);
    rendererLog(pluginDiagNamespace(pluginId), 'warn',
      `agentConfig.${method} is deprecated and does nothing: permission rules are each CLI's own, not project defaults. ${count} rule(s) ignored.`);
  }

  /** Check if plugin has elevated permission for sub-scope */
  function requirePermission(perm: PluginPermission): void {
    if (!hasPermission(manifest, perm)) {
      handlePermissionViolation(pluginId, perm, `agentConfig (requires '${perm}')`);
      throw new Error(`Plugin '${pluginId}' requires '${perm}' permission`);
    }
  }

  return {
    // ── Skills ──────────────────────────────────────────────────────
    async injectSkill(name: string, content: string, opts?: AgentConfigTargetOptions): Promise<void> {
      const projectPath = resolveAgentConfigTarget(opts, defaultProjectPath, pluginId, manifest);
      const storage = storageFor(projectPath);
      const safeName = `${pluginSkillPrefix}${name}`;
      await window.clubhouse.agentSettings.writeSourceSkillContent(projectPath, safeName, content);
      const skills = ((await storage.read('injected-skills')) as string[] | null) ?? [];
      if (!skills.includes(safeName)) {
        skills.push(safeName);
        await storage.write('injected-skills', skills);
      }
    },

    async removeSkill(name: string, opts?: AgentConfigTargetOptions): Promise<void> {
      const projectPath = resolveAgentConfigTarget(opts, defaultProjectPath, pluginId, manifest);
      const storage = storageFor(projectPath);
      const safeName = `${pluginSkillPrefix}${name}`;
      await window.clubhouse.agentSettings.deleteSourceSkill(projectPath, safeName);
      const skills = ((await storage.read('injected-skills')) as string[] | null) ?? [];
      await storage.write('injected-skills', skills.filter((s) => s !== safeName));
    },

    async listInjectedSkills(opts?: AgentConfigTargetOptions): Promise<string[]> {
      const projectPath = resolveAgentConfigTarget(opts, defaultProjectPath, pluginId, manifest);
      const storage = storageFor(projectPath);
      const skills = ((await storage.read('injected-skills')) as string[] | null) ?? [];
      return skills.map((s) => s.replace(pluginSkillPrefix, ''));
    },

    // ── Agent Templates ──────────────────────────────────────────────
    async injectAgentTemplate(name: string, content: string, opts?: AgentConfigTargetOptions): Promise<void> {
      const projectPath = resolveAgentConfigTarget(opts, defaultProjectPath, pluginId, manifest);
      const storage = storageFor(projectPath);
      const safeName = `${pluginTemplatePrefix}${name}`;
      await window.clubhouse.agentSettings.writeSourceAgentTemplateContent(projectPath, safeName, content);
      const templates = ((await storage.read('injected-templates')) as string[] | null) ?? [];
      if (!templates.includes(safeName)) {
        templates.push(safeName);
        await storage.write('injected-templates', templates);
      }
    },

    async removeAgentTemplate(name: string, opts?: AgentConfigTargetOptions): Promise<void> {
      const projectPath = resolveAgentConfigTarget(opts, defaultProjectPath, pluginId, manifest);
      const storage = storageFor(projectPath);
      const safeName = `${pluginTemplatePrefix}${name}`;
      await window.clubhouse.agentSettings.deleteSourceAgentTemplate(projectPath, safeName);
      const templates = ((await storage.read('injected-templates')) as string[] | null) ?? [];
      await storage.write('injected-templates', templates.filter((t) => t !== safeName));
    },

    async listInjectedAgentTemplates(opts?: AgentConfigTargetOptions): Promise<string[]> {
      const projectPath = resolveAgentConfigTarget(opts, defaultProjectPath, pluginId, manifest);
      const storage = storageFor(projectPath);
      const templates = ((await storage.read('injected-templates')) as string[] | null) ?? [];
      return templates.map((t) => t.replace(pluginTemplatePrefix, ''));
    },

    // ── Instructions ──────────────────────────────────────────────────
    // A Managed Agent part attributed to this plugin (#3245), no longer the project's
    // legacy defaults. Main also clears what this plugin had saved there.
    async appendInstructions(content: string, opts?: AgentConfigTargetOptions): Promise<void> {
      const projectPath = resolveAgentConfigTarget(opts, defaultProjectPath, pluginId, manifest);
      await window.clubhouse.agentSettings.setPluginManagedParts(projectPath, pluginId, { instructions: content });
    },

    async removeInstructionAppend(opts?: AgentConfigTargetOptions): Promise<void> {
      const projectPath = resolveAgentConfigTarget(opts, defaultProjectPath, pluginId, manifest);
      await window.clubhouse.agentSettings.setPluginManagedParts(projectPath, pluginId, { instructions: null });
    },

    async getInstructionAppend(opts?: AgentConfigTargetOptions): Promise<string | null> {
      const projectPath = resolveAgentConfigTarget(opts, defaultProjectPath, pluginId, manifest);
      const parts = await window.clubhouse.agentSettings.readPluginManagedParts(projectPath, pluginId);
      if (parts?.instructions != null) return parts.instructions;
      // A block saved before #3245, until the plugin writes again or someone imports it.
      const defaults = await window.clubhouse.agentSettings.readProjectAgentDefaults(projectPath);
      const existing = defaults.instructions || '';
      const regex = new RegExp(
        `<!-- plugin:${pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:start -->\\n([\\s\\S]*?)\\n<!-- plugin:${pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:end -->`,
      );
      const match = existing.match(regex);
      return match ? match[1] : null;
    },

    // ── Permissions (elevated) ────────────────────────────────────────
    // Deprecated (#3245): permission rules are each CLI's own syntax, not something a
    // project hands every agent. Adding them does nothing and says so; removing and
    // reading still work on rules saved before.
    async addPermissionAllowRules(rules: string[], opts?: AgentConfigTargetOptions): Promise<void> {
      requirePermission('agent-config.permissions');
      resolveAgentConfigTarget(opts, defaultProjectPath, pluginId, manifest);
      warnPermissionRulesIgnored('addPermissionAllowRules', rules.length);
    },

    async addPermissionDenyRules(rules: string[], opts?: AgentConfigTargetOptions): Promise<void> {
      requirePermission('agent-config.permissions');
      resolveAgentConfigTarget(opts, defaultProjectPath, pluginId, manifest);
      warnPermissionRulesIgnored('addPermissionDenyRules', rules.length);
    },

    async removePermissionRules(opts?: AgentConfigTargetOptions): Promise<void> {
      requirePermission('agent-config.permissions');
      const projectPath = resolveAgentConfigTarget(opts, defaultProjectPath, pluginId, manifest);
      await window.clubhouse.agentSettings.updatePluginAgentDefaults(projectPath, pluginId, { allow: null, deny: null });
    },

    async getPermissionRules(opts?: AgentConfigTargetOptions): Promise<{ allow: string[]; deny: string[] }> {
      requirePermission('agent-config.permissions');
      const projectPath = resolveAgentConfigTarget(opts, defaultProjectPath, pluginId, manifest);
      const defaults = await window.clubhouse.agentSettings.readProjectAgentDefaults(projectPath);
      const existing = defaults.permissions || {};
      const tag = `/* plugin:${pluginId} */`;
      return {
        allow: (existing.allow || []).filter((r) => r.includes(tag)).map((r) => r.replace(` ${tag}`, '')),
        deny: (existing.deny || []).filter((r) => r.includes(tag)).map((r) => r.replace(` ${tag}`, '')),
      };
    },

    // ── MCP (elevated) ────────────────────────────────────────────────
    async injectMcpServers(servers: Record<string, unknown>, opts?: AgentConfigTargetOptions): Promise<void> {
      requirePermission('agent-config.mcp');
      const projectPath = resolveAgentConfigTarget(opts, defaultProjectPath, pluginId, manifest);
      const storage = storageFor(projectPath);
      // Store plugin's MCP config separately for tracking
      await storage.write('injected-mcp', servers);
      // Each server becomes a Managed Agent part attributed to this plugin (#3245).
      const result = await window.clubhouse.agentSettings.setPluginManagedParts(projectPath, pluginId, { mcpServers: servers });
      for (const note of result?.notes ?? []) rendererLog(pluginDiagNamespace(pluginId), 'warn', note);
    },

    async removeMcpServers(opts?: AgentConfigTargetOptions): Promise<void> {
      requirePermission('agent-config.mcp');
      const projectPath = resolveAgentConfigTarget(opts, defaultProjectPath, pluginId, manifest);
      const storage = storageFor(projectPath);
      await storage.delete('injected-mcp');
      await window.clubhouse.agentSettings.setPluginManagedParts(projectPath, pluginId, { mcpServers: null });
    },

    async getInjectedMcpServers(opts?: AgentConfigTargetOptions): Promise<Record<string, unknown>> {
      requirePermission('agent-config.mcp');
      const projectPath = resolveAgentConfigTarget(opts, defaultProjectPath, pluginId, manifest);
      const storage = storageFor(projectPath);
      const data = await storage.read('injected-mcp');
      return (data as Record<string, unknown>) || {};
    },

    // Agent templates from plugins had nowhere to show once the legacy
    // template UI went (#2901). Kept in the API as a no-op so plugins that
    // call it keep working.
    registerAgentTemplate() {
      return { dispose: () => {} };
    },

    async contributeWrapperPreset(preset: {
      binary: string;
      separator: string;
      orchestratorMap: Record<string, { subcommand: string }>;
      env?: Record<string, string>;
      mcpCatalog: Array<{ id: string; name: string; description: string }>;
      defaultMcps?: string[];
      refreshCommandId?: string;
      contributingPluginId?: string;
    }): Promise<void> {
      const projectPath = ctx.projectPath;
      if (!projectPath) throw new Error('contributeWrapperPreset requires a project context');
      await window.clubhouse.project.writeLaunchWrapper(projectPath, {
        binary: preset.binary,
        separator: preset.separator,
        orchestratorMap: preset.orchestratorMap,
        env: preset.env,
        refreshCommandId: preset.refreshCommandId,
        contributingPluginId: preset.contributingPluginId ?? pluginId,
      });
      await window.clubhouse.project.writeMcpCatalog(projectPath, preset.mcpCatalog);
      if (preset.defaultMcps) {
        await window.clubhouse.project.writeDefaultMcps(projectPath, preset.defaultMcps);
      }
    },

    async removeWrapperPreset(opts?: AgentConfigTargetOptions): Promise<void> {
      const projectPath = resolveAgentConfigTarget(opts, defaultProjectPath, pluginId, manifest);
      await window.clubhouse.project.writeLaunchWrapper(projectPath, undefined);
      await window.clubhouse.project.writeMcpCatalog(projectPath, []);
      await window.clubhouse.project.writeDefaultMcps(projectPath, []);
      await window.clubhouse.project.writeWrapperCatalogSnapshot(projectPath, undefined);
    },
  };
}
