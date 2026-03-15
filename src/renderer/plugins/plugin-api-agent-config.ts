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

// ── Plugin instruction markers ──────────────────────────────────────────
const PLUGIN_INSTRUCTION_START = (pluginId: string) => `\n\n<!-- plugin:${pluginId}:start -->`;
const PLUGIN_INSTRUCTION_END = (pluginId: string) => `<!-- plugin:${pluginId}:end -->`;

/**
 * Resolves the target project path for a cross-project agentConfig operation.
 * When `opts.projectId` is provided, validates:
 *   1. The plugin has the 'agent-config.cross-project' permission
 *   2. The target project exists
 *   3. The target project has this plugin enabled (bilateral consent)
 * Returns the resolved project path.
 */
function resolveAgentConfigTarget(
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
    async appendInstructions(content: string, opts?: AgentConfigTargetOptions): Promise<void> {
      const projectPath = resolveAgentConfigTarget(opts, defaultProjectPath, pluginId, manifest);
      const defaults = await window.clubhouse.agentSettings.readProjectAgentDefaults(projectPath);
      const existing = defaults.instructions || '';
      const startMarker = PLUGIN_INSTRUCTION_START(pluginId);
      const endMarker = PLUGIN_INSTRUCTION_END(pluginId);

      // Remove any existing block from this plugin
      const regex = new RegExp(
        `\\n?\\n?<!-- plugin:${pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:start -->[\\s\\S]*?<!-- plugin:${pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:end -->`,
      );
      const cleaned = existing.replace(regex, '');

      // Append new block
      const updated = cleaned + startMarker + '\n' + content + '\n' + endMarker;
      await window.clubhouse.agentSettings.writeProjectAgentDefaults(projectPath, {
        ...defaults,
        instructions: updated,
      });
    },

    async removeInstructionAppend(opts?: AgentConfigTargetOptions): Promise<void> {
      const projectPath = resolveAgentConfigTarget(opts, defaultProjectPath, pluginId, manifest);
      const defaults = await window.clubhouse.agentSettings.readProjectAgentDefaults(projectPath);
      const existing = defaults.instructions || '';
      const regex = new RegExp(
        `\\n?\\n?<!-- plugin:${pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:start -->[\\s\\S]*?<!-- plugin:${pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:end -->`,
      );
      const cleaned = existing.replace(regex, '');
      if (cleaned !== existing) {
        await window.clubhouse.agentSettings.writeProjectAgentDefaults(projectPath, {
          ...defaults,
          instructions: cleaned,
        });
      }
    },

    async getInstructionAppend(opts?: AgentConfigTargetOptions): Promise<string | null> {
      const projectPath = resolveAgentConfigTarget(opts, defaultProjectPath, pluginId, manifest);
      const defaults = await window.clubhouse.agentSettings.readProjectAgentDefaults(projectPath);
      const existing = defaults.instructions || '';
      const regex = new RegExp(
        `<!-- plugin:${pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:start -->\\n([\\s\\S]*?)\\n<!-- plugin:${pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:end -->`,
      );
      const match = existing.match(regex);
      return match ? match[1] : null;
    },

    // ── Permissions (elevated) ────────────────────────────────────────
    async addPermissionAllowRules(rules: string[], opts?: AgentConfigTargetOptions): Promise<void> {
      requirePermission('agent-config.permissions');
      const projectPath = resolveAgentConfigTarget(opts, defaultProjectPath, pluginId, manifest);
      const defaults = await window.clubhouse.agentSettings.readProjectAgentDefaults(projectPath);
      const existing = defaults.permissions || {};
      const allow = existing.allow || [];
      // Tag rules for tracking
      const taggedRules = rules.map((r) => `${r} /* plugin:${pluginId} */`);
      const merged = [...allow.filter((r) => !r.includes(`/* plugin:${pluginId} */`)), ...taggedRules];
      await window.clubhouse.agentSettings.writeProjectAgentDefaults(projectPath, {
        ...defaults,
        permissions: { ...existing, allow: merged },
      });
    },

    async addPermissionDenyRules(rules: string[], opts?: AgentConfigTargetOptions): Promise<void> {
      requirePermission('agent-config.permissions');
      const projectPath = resolveAgentConfigTarget(opts, defaultProjectPath, pluginId, manifest);
      const defaults = await window.clubhouse.agentSettings.readProjectAgentDefaults(projectPath);
      const existing = defaults.permissions || {};
      const deny = existing.deny || [];
      const taggedRules = rules.map((r) => `${r} /* plugin:${pluginId} */`);
      const merged = [...deny.filter((r) => !r.includes(`/* plugin:${pluginId} */`)), ...taggedRules];
      await window.clubhouse.agentSettings.writeProjectAgentDefaults(projectPath, {
        ...defaults,
        permissions: { ...existing, deny: merged },
      });
    },

    async removePermissionRules(opts?: AgentConfigTargetOptions): Promise<void> {
      requirePermission('agent-config.permissions');
      const projectPath = resolveAgentConfigTarget(opts, defaultProjectPath, pluginId, manifest);
      const defaults = await window.clubhouse.agentSettings.readProjectAgentDefaults(projectPath);
      const existing = defaults.permissions || {};
      const tag = `/* plugin:${pluginId} */`;
      const allow = (existing.allow || []).filter((r) => !r.includes(tag));
      const deny = (existing.deny || []).filter((r) => !r.includes(tag));
      await window.clubhouse.agentSettings.writeProjectAgentDefaults(projectPath, {
        ...defaults,
        permissions: { allow, deny },
      });
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

      // Merge into project agent defaults mcpJson
      const defaults = await window.clubhouse.agentSettings.readProjectAgentDefaults(projectPath);
      let mcpConfig: Record<string, unknown> = {};
      if (defaults.mcpJson) {
        try { mcpConfig = JSON.parse(defaults.mcpJson); } catch { /* ignore */ }
      }
      const mcpServers = (mcpConfig.mcpServers as Record<string, unknown>) || {};

      // Tag server entries for this plugin
      const taggedServers: Record<string, unknown> = {};
      for (const [name, config] of Object.entries(servers)) {
        taggedServers[`plugin-${pluginId}-${name}`] = config;
      }

      const mergedServers = {
        ...Object.fromEntries(
          Object.entries(mcpServers).filter(([k]) => !k.startsWith(`plugin-${pluginId}-`)),
        ),
        ...taggedServers,
      };

      const updatedConfig = { ...mcpConfig, mcpServers: mergedServers };
      await window.clubhouse.agentSettings.writeProjectAgentDefaults(projectPath, {
        ...defaults,
        mcpJson: JSON.stringify(updatedConfig, null, 2),
      });
    },

    async removeMcpServers(opts?: AgentConfigTargetOptions): Promise<void> {
      requirePermission('agent-config.mcp');
      const projectPath = resolveAgentConfigTarget(opts, defaultProjectPath, pluginId, manifest);
      const storage = storageFor(projectPath);
      await storage.delete('injected-mcp');

      const defaults = await window.clubhouse.agentSettings.readProjectAgentDefaults(projectPath);
      let mcpConfig: Record<string, unknown> = {};
      if (defaults.mcpJson) {
        try { mcpConfig = JSON.parse(defaults.mcpJson); } catch { /* ignore */ }
      }
      const mcpServers = (mcpConfig.mcpServers as Record<string, unknown>) || {};
      const cleaned = Object.fromEntries(
        Object.entries(mcpServers).filter(([k]) => !k.startsWith(`plugin-${pluginId}-`)),
      );

      const updatedConfig = { ...mcpConfig, mcpServers: cleaned };
      await window.clubhouse.agentSettings.writeProjectAgentDefaults(projectPath, {
        ...defaults,
        mcpJson: JSON.stringify(updatedConfig, null, 2),
      });
    },

    async getInjectedMcpServers(opts?: AgentConfigTargetOptions): Promise<Record<string, unknown>> {
      requirePermission('agent-config.mcp');
      const projectPath = resolveAgentConfigTarget(opts, defaultProjectPath, pluginId, manifest);
      const storage = storageFor(projectPath);
      const data = await storage.read('injected-mcp');
      return (data as Record<string, unknown>) || {};
    },

    async contributeWrapperPreset(preset: {
      binary: string;
      separator: string;
      orchestratorMap: Record<string, { subcommand: string }>;
      env?: Record<string, string>;
      mcpCatalog: Array<{ id: string; name: string; description: string }>;
      defaultMcps?: string[];
    }): Promise<void> {
      const projectPath = ctx.projectPath;
      if (!projectPath) throw new Error('contributeWrapperPreset requires a project context');
      await window.clubhouse.project.writeLaunchWrapper(projectPath, {
        binary: preset.binary,
        separator: preset.separator,
        orchestratorMap: preset.orchestratorMap,
        env: preset.env,
      });
      await window.clubhouse.project.writeMcpCatalog(projectPath, preset.mcpCatalog);
      if (preset.defaultMcps) {
        await window.clubhouse.project.writeDefaultMcps(projectPath, preset.defaultMcps);
      }
    },
  };
}
