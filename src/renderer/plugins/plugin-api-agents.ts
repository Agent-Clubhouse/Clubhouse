import type {
  PluginContext,
  PluginManifest,
  AgentsAPI,
  AgentInfo,
  CompletedQuickAgentInfo,
  PluginAgentDetailedStatus,
  PluginOrchestratorInfo,
  ModelOption,
  Disposable,
} from '../../shared/plugin-types';
import { ACCESS_LEVELS, accessLabel, isAccessLevel, isLegacyFreeAgent, type AccessLevel } from '../../shared/agent-access';
import { hasPermission } from './plugin-api-shared';
import { checkAnsweringCallers, pluginAnsweringLevel } from './plugin-mcp-host';
import { useAgentStore } from '../stores/agentStore';
import { getAgentStatus, onChatStatusChange } from '../features/agents/agent-status-store';
import { useProjectStore } from '../stores/projectStore';
import { useQuickAgentStore } from '../stores/quickAgentStore';
import { useOrchestratorStore } from '../stores/orchestratorStore';
import { useRemoteProjectStore, parseNamespacedId } from '../stores/remoteProjectStore';
import { useAnnexClientStore } from '../stores/annexClientStore';

/**
 * While the plugin answers an agent's tool call, an agent it starts stays at or below that
 * agent's running level (D126, #3161). `ceiling` is pluginAnsweringLevel, read once before
 * anything awaits. Null when it may, else the refusal. Outside a call the plugin acts for the
 * person, with what its manifest allows.
 */
function answeringRefusal(pluginId: string, ceiling: AccessLevel | undefined, level: AccessLevel, why: string, fix: (ceiling: string) => string): string | null {
  if (!ceiling || ACCESS_LEVELS.indexOf(level) <= ACCESS_LEVELS.indexOf(ceiling)) return null;
  return `Plugin '${pluginId}' is answering a tool call from an agent that runs at ${accessLabel(ceiling)}, so it can't start an agent at ${accessLabel(level)}${why}: an agent never sets Access above its own, even through a plugin. ${fix(accessLabel(ceiling))}`;
}

export function createAgentsAPI(ctx: PluginContext, manifest?: PluginManifest): AgentsAPI {
  // A local agent's sessions live under its own project. App-scope plugins
  // (Review, Canvas) have no ctx.projectPath, so fall back to that project.
  const sessionProjectPath = (agentId: string): string | undefined => {
    if (ctx.projectPath) return ctx.projectPath;
    const projectId = useAgentStore.getState().agents[agentId]?.projectId;
    return projectId ? useProjectStore.getState().projects.find((p) => p.id === projectId)?.path : undefined;
  };

  return {
    list(): AgentInfo[] {
      const localAgents = useAgentStore.getState().agents;
      const remoteAgents = useRemoteProjectStore.getState().remoteAgents;
      const allAgents = { ...localAgents, ...remoteAgents };
      return Object.values(allAgents)
        .filter((a) => !ctx.projectId || a.projectId === ctx.projectId)
        .map((a) => ({
          id: a.id,
          name: a.name,
          kind: a.kind,
          status: a.status,
          color: a.color,
          icon: a.icon,
          exitCode: a.exitCode,
          mission: a.mission,
          projectId: a.projectId,
          branch: a.branch,
          worktreePath: a.worktreePath,
          model: a.model,
          parentAgentId: a.parentAgentId,
          orchestrator: a.orchestrator,
          freeAgentMode: a.freeAgentMode,
          pluginMetadata: a.pluginMetadata,
          mcpIds: a.mcpIds,
        }));
    },

    async createDurable(options: {
      projectId?: string;
      name: string;
      color: string;
      model?: string;
      useWorktree?: boolean;
      orchestrator?: string;
      freeAgentMode?: boolean;
      access?: AccessLevel;
      mcpIds?: string[];
      /** @deprecated Structured mode was removed; ignored. */
      structuredMode?: boolean;
      /** @deprecated Personas were retired; ignored. */
      persona?: string;
    }): Promise<string> {
      if (options.access !== undefined && !isAccessLevel(options.access)) {
        throw new Error(`agents.createDurable: access must be one of ${ACCESS_LEVELS.join(', ')}`);
      }
      if (options.freeAgentMode && !hasPermission(manifest, 'agents.free-agent-mode')) {
        throw new Error(`Plugin '${ctx.pluginId}' requires 'agents.free-agent-mode' permission to use freeAgentMode`);
      }
      const elevated = hasPermission(manifest, 'agents.free-agent-mode');
      if (options.access !== undefined && ACCESS_LEVELS.indexOf(options.access) > ACCESS_LEVELS.indexOf('ask') && !elevated) {
        throw new Error(`Plugin '${ctx.pluginId}' requires 'agents.free-agent-mode' permission to start an agent at ${options.access}`);
      }
      if (options.structuredMode !== undefined) {
        console.warn(`[plugin:${ctx.pluginId}] agents.createDurable: 'structuredMode' is deprecated and ignored (structured mode was removed).`);
      }
      if (options.persona !== undefined) {
        console.warn(`[plugin:${ctx.pluginId}] agents.createDurable: 'persona' is deprecated and ignored (personas were retired).`);
      }

      let projectId = ctx.projectId;
      let projectPath = ctx.projectPath;

      if (options.projectId) {
        const project = useProjectStore.getState().projects.find((p) => p.id === options.projectId);
        if (!project) throw new Error(`Project not found: ${options.projectId}`);
        projectId = project.id;
        projectPath = project.path;
      }

      if (!projectId || !projectPath) {
        throw new Error('createDurable requires a project context');
      }

      // Without the permission a plugin's agent never starts above Ask first, whatever the Default access (#2761).
      let access: AccessLevel | boolean | undefined = options.access ?? (elevated ? options.freeAgentMode : 'ask');
      // Read once: the call may end while this awaits the Default access.
      const ceiling = pluginAnsweringLevel(ctx.pluginId);
      if (ceiling) {
        // Answering an agent: the level is worked out here as main would, and the one checked is the one made.
        let level: AccessLevel;
        let why = '';
        if (typeof access === 'string') level = access;
        // Its highest meaning is Full access; allowed only under a caller at Full access, it is sent as is for main to map.
        else if (access === true) { level = 'full_access'; why = ' (freeAgentMode can mean Full access)'; }
        else {
          const base = await window.clubhouse.app.getDefaultAccess();
          const fallback: AccessLevel = isAccessLevel(base) ? base : 'ask';
          // Off keeps a Default that is already off, or becomes Ask first; unset is the Default.
          level = access === false && isLegacyFreeAgent(fallback) ? 'ask' : fallback;
          if (access === undefined) why = ' (the Default access for new agents)';
        }
        const refused = answeringRefusal(ctx.pluginId, ceiling, level, why, (c) => `Pass access at or below ${c}, or ask the person to start it.`);
        if (refused) throw new Error(refused);
        if (access !== true) access = level;
      }
      const model = options.model && options.model !== 'default' ? options.model : undefined;
      const config = await window.clubhouse.agent.createDurable(
        projectPath, options.name, options.color, model, options.useWorktree ?? false, options.orchestrator,
        access, options.mcpIds,
      );
      return useAgentStore.getState().spawnDurableAgent(projectId, projectPath, config, false);
    },

    async runQuick(mission: string, options?: { model?: string; systemPrompt?: string; projectId?: string; orchestrator?: string; freeAgentMode?: boolean; metadata?: Record<string, string> }): Promise<string> {
      if (options?.freeAgentMode && !hasPermission(manifest, 'agents.free-agent-mode')) {
        throw new Error(`Plugin '${ctx.pluginId}' requires 'agents.free-agent-mode' permission to use freeAgentMode`);
      }

      let projectId = ctx.projectId;
      let projectPath = ctx.projectPath;

      if (options?.projectId) {
        const project = useProjectStore.getState().projects.find((p) => p.id === options.projectId);
        if (!project) throw new Error(`Project not found: ${options.projectId}`);
        projectId = project.id;
        projectPath = project.path;
      }

      if (!projectId || !projectPath) {
        throw new Error('runQuick requires a project context');
      }
      // A quick agent with Free Agent Mode can run at Full access; without it, at Ask first (D126, #3161).
      const refused = answeringRefusal(ctx.pluginId, pluginAnsweringLevel(ctx.pluginId), options?.freeAgentMode ? 'full_access' : 'ask', options?.freeAgentMode ? ' (freeAgentMode can mean Full access)' : '',
        () => 'Leave freeAgentMode out, or ask the person to start it.');
      if (refused) throw new Error(refused);
      return useAgentStore.getState().spawnQuickAgent(
        projectId,
        projectPath,
        mission,
        options?.model,
        undefined, // parentAgentId
        options?.orchestrator,
        options?.freeAgentMode,
        options?.metadata,
      );
    },

    async kill(agentId: string): Promise<void> {
      const remoteParts = parseNamespacedId(agentId);
      if (remoteParts) {
        await useAnnexClientStore.getState().sendAgentKill(remoteParts.satelliteId, remoteParts.agentId);
        return;
      }
      const agent = useAgentStore.getState().agents[agentId];
      if (!agent) return;
      const project = useProjectStore.getState().projects.find((p) => p.id === agent.projectId);
      await useAgentStore.getState().killAgent(agentId, project?.path);
    },

    async resume(agentId: string, options?: { mission?: string }): Promise<void> {
      // While the plugin answers an agent's tool call, it wakes only an agent that agent may wake
      // (D126, #3168). One on another desktop can't be checked here, so it is refused then.
      const refused = await checkAnsweringCallers(ctx.pluginId, { kind: 'wake', agentId });
      if (refused) throw new Error(refused);
      // Check remote agents first
      const remoteParts = parseNamespacedId(agentId);
      if (remoteParts) {
        await useAnnexClientStore.getState().sendAgentWake(
          remoteParts.satelliteId,
          remoteParts.agentId,
          options?.mission ? { mission: options.mission } : undefined,
        );
        return;
      }

      const agent = useAgentStore.getState().agents[agentId];
      if (!agent || agent.kind !== 'durable') {
        throw new Error('Can only resume durable agents');
      }
      const project = useProjectStore.getState().projects.find((p) => p.id === agent.projectId);
      if (!project) throw new Error('Project not found for agent');
      const configs = await window.clubhouse.agent.listDurable(project.path);
      const config = configs.find((c: { id: string }) => c.id === agentId);
      if (!config) throw new Error('Durable config not found for agent');
      await useAgentStore.getState().spawnDurableAgent(project.id, project.path, config, false, options?.mission);
    },

    listCompleted(projectId?: string): CompletedQuickAgentInfo[] {
      const pid = projectId || ctx.projectId;
      if (!pid) return [];
      const records = useQuickAgentStore.getState().completedAgents[pid] || [];
      return records.map((r) => ({
        id: r.id,
        projectId: r.projectId,
        name: r.name,
        mission: r.mission,
        summary: r.summary,
        filesModified: r.filesModified,
        exitCode: r.exitCode,
        completedAt: r.completedAt,
        parentAgentId: r.parentAgentId,
        pluginMetadata: r.pluginMetadata,
      }));
    },

    dismissCompleted(projectId: string, agentId: string): void {
      useQuickAgentStore.getState().dismissCompleted(projectId, agentId);
    },

    getDetailedStatus(agentId: string): PluginAgentDetailedStatus | null {
      // Chat agents report their chat session's state, as the chat header does (#2208).
      const status = getAgentStatus(agentId)
        || useRemoteProjectStore.getState().remoteAgentDetailedStatus[agentId];
      if (!status) return null;
      return {
        state: status.state,
        message: status.message,
        toolName: status.toolName,
      };
    },

    async getModelOptions(projectId?: string, orchestrator?: string): Promise<ModelOption[]> {
      const DEFAULT_OPTIONS: ModelOption[] = [
        { id: 'default', label: 'Default' },
        { id: 'opus', label: 'Opus' },
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'haiku', label: 'Haiku' },
      ];
      const pid = projectId || ctx.projectId;
      if (!pid) return DEFAULT_OPTIONS;
      const project = useProjectStore.getState().projects.find((p) => p.id === pid);
      if (!project) return DEFAULT_OPTIONS;
      try {
        const result = await window.clubhouse.agent.getModelOptions(project.path, orchestrator);
        if (Array.isArray(result) && result.length > 0) return result;
        return DEFAULT_OPTIONS;
      } catch {
        return DEFAULT_OPTIONS;
      }
    },

    listOrchestrators(): PluginOrchestratorInfo[] {
      const orchestrators = useOrchestratorStore.getState().allOrchestrators;
      return orchestrators.map((o) => ({
        id: o.id,
        displayName: o.displayName,
        shortName: o.shortName,
        badge: o.badge,
        capabilities: {
          headless: o.capabilities.headless,
          hooks: o.capabilities.hooks,
          sessionResume: o.capabilities.sessionResume,
          permissions: o.capabilities.permissions,
        },
      }));
    },

    async checkOrchestratorAvailability(orchestratorId: string): Promise<{ available: boolean; error?: string }> {
      try {
        const result = await window.clubhouse.agent.checkOrchestrator(ctx.projectPath, orchestratorId);
        return { available: !!result?.available, error: result?.error };
      } catch (err) {
        return { available: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    onStatusChange(callback: (agentId: string, status: string, prevStatus: string) => void): Disposable {
      let prevStatuses: Record<string, string> = {};
      // Snapshot current state from both local and remote stores
      const localAgents = useAgentStore.getState().agents;
      const remoteAgents = useRemoteProjectStore.getState().remoteAgents;
      for (const [id, agent] of Object.entries({ ...localAgents, ...remoteAgents })) {
        prevStatuses[id] = agent.status;
      }

      function checkChanges() {
        const current = { ...useAgentStore.getState().agents, ...useRemoteProjectStore.getState().remoteAgents };
        for (const [id, agent] of Object.entries(current)) {
          const prev = prevStatuses[id];
          if (prev && prev !== agent.status) {
            callback(id, agent.status, prev);
          }
        }
        const next: Record<string, string> = {};
        for (const [id, agent] of Object.entries(current)) {
          next[id] = agent.status;
        }
        prevStatuses = next;
      }

      const unsub1 = useAgentStore.subscribe(checkChanges);
      const unsub2 = useRemoteProjectStore.subscribe(checkChanges);

      return { dispose: () => { unsub1(); unsub2(); } };
    },

    onAnyChange(callback: () => void): Disposable {
      const unsub1 = useAgentStore.subscribe(callback);
      const unsub2 = useRemoteProjectStore.subscribe(callback);
      // A chat turn starting or ending changes getDetailedStatus too.
      const unsub3 = onChatStatusChange(callback);
      return { dispose: () => { unsub1(); unsub2(); unsub3(); } };
    },

    async listSessions(agentId: string) {
      // Remote agent: proxy through annex client
      const remoteParts = parseNamespacedId(agentId);
      if (remoteParts) {
        const remoteAgent = useRemoteProjectStore.getState().remoteAgents[agentId];
        const origProjectId = remoteAgent?.projectId
          ? (parseNamespacedId(remoteAgent.projectId)?.agentId || '')
          : '';
        try {
          return await window.clubhouse.annexClient.sessionList(
            remoteParts.satelliteId, remoteParts.agentId, origProjectId, remoteAgent?.orchestrator,
          ) as any[];
        } catch {
          return [];
        }
      }

      const projectPath = sessionProjectPath(agentId);
      if (!projectPath) return [];
      const agent = useAgentStore.getState().agents[agentId];
      try {
        return await window.clubhouse.agent.listSessions(projectPath, agentId, agent?.orchestrator);
      } catch {
        return [];
      }
    },

    async readSessionTranscript(agentId: string, sessionId: string, offset: number, limit: number) {
      // Remote agent: proxy through annex client
      const remoteParts = parseNamespacedId(agentId);
      if (remoteParts) {
        const remoteAgent = useRemoteProjectStore.getState().remoteAgents[agentId];
        const origProjectId = remoteAgent?.projectId
          ? (parseNamespacedId(remoteAgent.projectId)?.agentId || '')
          : '';
        try {
          return await window.clubhouse.annexClient.sessionTranscript(
            remoteParts.satelliteId, remoteParts.agentId, sessionId, origProjectId, offset, limit, remoteAgent?.orchestrator,
          ) as import('../../shared/session-types').SessionTranscriptPage | null;
        } catch {
          return null;
        }
      }

      const projectPath = sessionProjectPath(agentId);
      if (!projectPath) return null;
      const agent = useAgentStore.getState().agents[agentId];
      try {
        const result = await window.clubhouse.agent.readSessionTranscript(projectPath, agentId, sessionId, offset, limit, agent?.orchestrator);
        return result as import('../../shared/session-types').SessionTranscriptPage | null;
      } catch {
        return null;
      }
    },

    async getSessionSummary(agentId: string, sessionId: string) {
      // Remote agent: proxy through annex client
      const remoteParts = parseNamespacedId(agentId);
      if (remoteParts) {
        const remoteAgent = useRemoteProjectStore.getState().remoteAgents[agentId];
        const origProjectId = remoteAgent?.projectId
          ? (parseNamespacedId(remoteAgent.projectId)?.agentId || '')
          : '';
        try {
          return await window.clubhouse.annexClient.sessionSummary(
            remoteParts.satelliteId, remoteParts.agentId, sessionId, origProjectId, remoteAgent?.orchestrator,
          ) as import('../../shared/session-types').SessionSummary;
        } catch {
          return null;
        }
      }

      const projectPath = sessionProjectPath(agentId);
      if (!projectPath) return null;
      const agent = useAgentStore.getState().agents[agentId];
      try {
        return await window.clubhouse.agent.getSessionSummary(projectPath, agentId, sessionId, agent?.orchestrator);
      } catch {
        return null;
      }
    },

    // v0.9 companion agent methods
    async spawnCompanion(options?: { model?: string; systemPrompt?: string }) {
      // A companion starts at Ask first: above a caller at Plan (D126, #3161).
      const refused = answeringRefusal(ctx.pluginId, pluginAnsweringLevel(ctx.pluginId), 'ask', '', () => 'Ask the person to start it.');
      if (refused) throw new Error(refused);
      return window.clubhouse.agent.spawnCompanion(ctx.pluginId, options);
    },
    async getCompanionStatus() {
      return window.clubhouse.agent.getCompanionStatus(ctx.pluginId);
    },
    async getCompanionWorkspace() {
      return window.clubhouse.agent.getCompanionWorkspace(ctx.pluginId);
    },
  };
}
