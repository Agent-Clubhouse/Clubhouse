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
import { hasPermission } from './plugin-api-shared';
import { useAgentStore } from '../stores/agentStore';
import { useProjectStore } from '../stores/projectStore';
import { useQuickAgentStore } from '../stores/quickAgentStore';
import { useOrchestratorStore } from '../stores/orchestratorStore';
import { useRemoteProjectStore, isRemoteProjectId, parseNamespacedId } from '../stores/remoteProjectStore';
import { useAnnexClientStore } from '../stores/annexClientStore';

export function createAgentsAPI(ctx: PluginContext, manifest?: PluginManifest): AgentsAPI {
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
        }));
    },

    async runQuick(mission: string, options?: { model?: string; systemPrompt?: string; projectId?: string; orchestrator?: string; freeAgentMode?: boolean }): Promise<string> {
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
      return useAgentStore.getState().spawnQuickAgent(
        projectId,
        projectPath,
        mission,
        options?.model,
        undefined, // parentAgentId
        options?.orchestrator,
        options?.freeAgentMode,
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
      // Check remote agents first
      const remoteParts = parseNamespacedId(agentId);
      if (remoteParts) {
        await useAnnexClientStore.getState().sendAgentWake(
          remoteParts.satelliteId,
          remoteParts.agentId,
          options?.mission || 'Wake up',
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
      }));
    },

    dismissCompleted(projectId: string, agentId: string): void {
      useQuickAgentStore.getState().dismissCompleted(projectId, agentId);
    },

    getDetailedStatus(agentId: string): PluginAgentDetailedStatus | null {
      const status = useAgentStore.getState().agentDetailedStatus[agentId];
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
      return { dispose: () => { unsub1(); unsub2(); } };
    },

    async listSessions(agentId: string) {
      const projectPath = ctx.projectPath;
      if (!projectPath) return [];
      const agent = useAgentStore.getState().agents[agentId];
      try {
        return await window.clubhouse.agent.listSessions(projectPath, agentId, agent?.orchestrator);
      } catch {
        return [];
      }
    },

    async readSessionTranscript(agentId: string, sessionId: string, offset: number, limit: number) {
      const projectPath = ctx.projectPath;
      if (!projectPath) return null;
      const agent = useAgentStore.getState().agents[agentId];
      try {
        const result = await window.clubhouse.agent.readSessionTranscript(projectPath, agentId, sessionId, offset, limit, agent?.orchestrator);
        // Cast the IPC result to the typed SessionTranscriptPage (event types are normalized on the main process side)
        return result as import('../../shared/session-types').SessionTranscriptPage | null;
      } catch {
        return null;
      }
    },

    async getSessionSummary(agentId: string, sessionId: string) {
      const projectPath = ctx.projectPath;
      if (!projectPath) return null;
      const agent = useAgentStore.getState().agents[agentId];
      try {
        return await window.clubhouse.agent.getSessionSummary(projectPath, agentId, sessionId, agent?.orchestrator);
      } catch {
        return null;
      }
    },
  };
}
