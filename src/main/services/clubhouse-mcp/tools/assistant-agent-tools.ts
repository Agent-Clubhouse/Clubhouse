import { registerMcpCommand, toCommandId } from '../mcp-command-adapter';
import { createDurable, updateDurable, updateDurableConfig, deleteDurable } from '../../agent-config';
import { resolveOrchestrator } from '../../agent-system';
import { appLog } from '../../log-service';
import { AGENT_COLORS } from '../../../../shared/name-generator';
import { getPersonaTemplate, getPersonaIds } from '../../../../renderer/features/assistant/content/personas';
import { requireString, optionalString, stringWithDefault, optionalBoolean } from './validation';

/** Register agent CRUD tools (create, update, delete, write instructions). */
export function registerAgentTools(): void {

// ── Agent Write Tools ──────────────────────────────────────────────────────

registerMcpCommand({
  id: toCommandId('assistant', 'create_agent'),
  category: 'assistant',
  label: 'Create Agent',
  description:
    'Create a new durable agent in a project. Has full parity with the Create Agent dialog. ' +
    'Returns the created agent\'s ID and configuration.',
  inputSchema: {
    type: 'object',
    properties: {
      project_path: {
        type: 'string',
        description: 'The project directory path.',
      },
      name: {
        type: 'string',
        description: 'Agent name. Auto-generated if omitted.',
      },
      color: {
        type: 'string',
        description: `Agent color ID. Options: ${AGENT_COLORS.map(c => c.id).join(', ')}. Defaults to "${AGENT_COLORS[0]?.id || 'emerald'}".`,
      },
      model: {
        type: 'string',
        description: 'Model identifier (e.g. "claude-opus", "claude-sonnet"). Falls back to orchestrator default if omitted.',
      },
      orchestrator: {
        type: 'string',
        description: 'Orchestrator ID (e.g. "claude-code", "copilot-cli", "codex-cli"). Falls back to project/app default if omitted.',
      },
      use_worktree: {
        type: 'boolean',
        description: 'Whether to create an isolated git worktree. Defaults to true.',
      },
      free_agent_mode: {
        type: 'boolean',
        description: 'Whether to enable free agent mode (skip all permission prompts). Defaults to project default.',
      },
      mcp_ids: {
        type: 'string',
        description: 'Comma-separated list of MCP server IDs to attach to this agent.',
      },
      persona: {
        type: 'string',
        description:
          `Persona template ID. Auto-injects role-specific instructions into the agent's CLAUDE.md. ` +
          `Options: ${getPersonaIds().join(', ')}.`,
      },
    },
    required: ['project_path'],
  },
  targetKind: 'assistant',
  nameSuffix: 'create_agent',
  handler: async (_targetId, _agentId, args) => {
    const projectPath = requireString(args, 'project_path');
    const name = stringWithDefault(args, 'name', `agent-${Date.now().toString(36).slice(-4)}`);
    const color = stringWithDefault(args, 'color', AGENT_COLORS[0]?.id || 'emerald');
    const model = optionalString(args, 'model');
    const useWorktree = args.use_worktree !== false; // default true
    const orchestratorArg = optionalString(args, 'orchestrator');
    const freeAgentMode = optionalBoolean(args, 'free_agent_mode');
    const mcpIdsRaw = optionalString(args, 'mcp_ids');
    const mcpIds = mcpIdsRaw ? mcpIdsRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const personaId = optionalString(args, 'persona');

    // Resolve orchestrator — default to project/app default so avatar always renders
    let orchestrator = orchestratorArg;
    if (!orchestrator) {
      try {
        const defaultProvider = await resolveOrchestrator(projectPath);
        orchestrator = defaultProvider.id;
      } catch { /* leave undefined — createDurable handles it */ }
    }

    // Validate persona ID if provided
    if (personaId && !getPersonaTemplate(personaId)) {
      return {
        content: [{
          type: 'text',
          text: `Unknown persona "${personaId}". Valid options: ${getPersonaIds().join(', ')}.`,
        }],
        isError: true,
      };
    }

    try {
      const agent = await createDurable(
        projectPath,
        name,
        color,
        model,
        useWorktree,
        orchestrator,
        freeAgentMode,
        mcpIds,
        undefined,
        undefined,
        personaId,
      );

      // Inject persona-specific instructions into the agent's worktree
      if (personaId && agent.worktreePath) {
        try {
          const persona = getPersonaTemplate(personaId);
          if (persona) {
            const provider = await resolveOrchestrator(projectPath, orchestrator);
            // Read existing instructions (from applyAgentDefaults) and append persona content
            let existing = '';
            try {
              existing = await provider.readInstructions(agent.worktreePath);
            } catch {
              // No existing instructions — start fresh
            }
            const combined = existing
              ? `${existing}\n\n${persona.content}`
              : persona.content;
            await provider.writeInstructions(agent.worktreePath, combined);
          }
        } catch (err) {
          appLog('assistant', 'warn', 'Failed to inject persona instructions', {
            meta: { agentName: name, persona: personaId, error: err instanceof Error ? err.message : String(err) },
          });
        }
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            message: `Agent "${agent.name}" created successfully.`,
            id: agent.id,
            name: agent.name,
            color: agent.color,
            icon: agent.icon || null,
            hasWorktree: !!agent.worktreePath,
            worktreePath: agent.worktreePath,
            model: agent.model,
            orchestrator: agent.orchestrator,
            persona: agent.persona || null,
          }),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to create agent: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
});

registerMcpCommand({
  id: toCommandId('assistant', 'update_agent'),
  category: 'assistant',
  label: 'Update Agent',
  description:
    'Update a durable agent\'s configuration. Can change model, orchestrator, ' +
    'free agent mode, clubhouse mode override, name, color, and icon. ' +
    'IMPORTANT: Do NOT clear an agent\'s icon unless the user explicitly asks — custom icons are user-set.',
  inputSchema: {
    type: 'object',
    properties: {
      project_path: {
        type: 'string',
        description: 'The project directory path.',
      },
      agent_id: {
        type: 'string',
        description: 'The agent ID.',
      },
      name: {
        type: 'string',
        description: 'New agent name.',
      },
      color: {
        type: 'string',
        description: 'New agent color.',
      },
      icon: {
        type: 'string',
        description: 'Agent icon filename. Set to "" to remove a custom icon. Omit to leave unchanged.',
      },
      model: {
        type: 'string',
        description: 'New model identifier.',
      },
      orchestrator: {
        type: 'string',
        description: 'New orchestrator ID.',
      },
      free_agent_mode: {
        type: 'boolean',
        description: 'Enable or disable free agent mode.',
      },
      clubhouse_mode_override: {
        type: 'boolean',
        description: 'Override for Clubhouse mode behavior.',
      },
    },
    required: ['project_path', 'agent_id'],
  },
  targetKind: 'assistant',
  nameSuffix: 'update_agent',
  handler: async (_targetId, _agentId, args) => {
    const projectPath = requireString(args, 'project_path');
    const agentId = requireString(args, 'agent_id');
    try {
      // Update basic fields (name, color, icon) via updateDurable
      const basicUpdates: Record<string, string | null | undefined> = {};
      if (args.name !== undefined) basicUpdates.name = requireString(args, 'name');
      if (args.color !== undefined) basicUpdates.color = requireString(args, 'color');
      if (args.icon !== undefined) {
        // Explicit icon update: empty string means remove
        const iconVal = optionalString(args, 'icon');
        basicUpdates.icon = iconVal === '' ? null : iconVal;
      }
      if (Object.keys(basicUpdates).length > 0) {
        await updateDurable(projectPath, agentId, basicUpdates as any);
      }

      // Update config fields (model, orchestrator, freeAgentMode, etc.) via updateDurableConfig
      const configUpdates: Record<string, unknown> = {};
      if (args.model !== undefined) configUpdates.model = requireString(args, 'model');
      if (args.orchestrator !== undefined) configUpdates.orchestrator = requireString(args, 'orchestrator');
      if (args.free_agent_mode !== undefined) configUpdates.freeAgentMode = optionalBoolean(args, 'free_agent_mode');
      if (args.clubhouse_mode_override !== undefined) configUpdates.clubhouseModeOverride = optionalBoolean(args, 'clubhouse_mode_override');
      if (Object.keys(configUpdates).length > 0) {
        await updateDurableConfig(projectPath, agentId, configUpdates as any);
      }

      return {
        content: [{ type: 'text', text: `Agent ${agentId} updated successfully.` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to update agent: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
});

registerMcpCommand({
  id: toCommandId('assistant', 'delete_agent'),
  category: 'assistant',
  label: 'Delete Agent',
  description:
    'Delete a durable agent from a project. This removes the agent\'s configuration ' +
    'and worktree (if any). This action cannot be undone.',
  inputSchema: {
    type: 'object',
    properties: {
      project_path: {
        type: 'string',
        description: 'The project directory path.',
      },
      agent_id: {
        type: 'string',
        description: 'The agent ID to delete.',
      },
    },
    required: ['project_path', 'agent_id'],
  },
  targetKind: 'assistant',
  nameSuffix: 'delete_agent',
  handler: async (_targetId, _agentId, args) => {
    const projectPath = requireString(args, 'project_path');
    const agentId = requireString(args, 'agent_id');
    try {
      await deleteDurable(projectPath, agentId);
      return {
        content: [{ type: 'text', text: `Agent ${agentId} deleted.` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to delete agent: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
});

registerMcpCommand({
  id: toCommandId('assistant', 'write_agent_instructions'),
  category: 'assistant',
  label: 'Write Agent Instructions',
  description:
    'Write or update the CLAUDE.md (or equivalent) instructions file for an agent. ' +
    'Uses the correct file path for the agent\'s orchestrator.',
  inputSchema: {
    type: 'object',
    properties: {
      project_path: {
        type: 'string',
        description: 'The project directory path (or agent worktree path).',
      },
      content: {
        type: 'string',
        description: 'The full markdown content to write as the agent\'s instructions.',
      },
      orchestrator: {
        type: 'string',
        description: 'Orchestrator ID to determine file path. Defaults to project default.',
      },
    },
    required: ['project_path', 'content'],
  },
  targetKind: 'assistant',
  nameSuffix: 'write_agent_instructions',
  handler: async (_targetId, _agentId, args) => {
    const projectPath = requireString(args, 'project_path');
    const content = requireString(args, 'content');
    const orchestratorId = optionalString(args, 'orchestrator');
    try {
      const provider = await resolveOrchestrator(projectPath, orchestratorId);
      await provider.writeInstructions(projectPath, content);
      return {
        content: [{ type: 'text', text: `Instructions written for ${provider.displayName} at ${projectPath}.` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to write instructions: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
});

}
