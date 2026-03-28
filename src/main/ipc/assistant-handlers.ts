/**
 * IPC handlers for the Clubhouse Assistant.
 *
 * Provides a dedicated spawn path that bypasses the generic quick-agent
 * flow. This ensures:
 * - Explicit execution mode control (interactive/structured/headless)
 * - Automatic MCP binding creation so tools are visible
 * - MCP config injection into the assistant workspace
 * - Session persistence for headless conversational follow-ups
 * - Comprehensive logging for debugging
 */

import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { bindingManager } from '../services/clubhouse-mcp';
import { agentRegistry, resolveOrchestrator, untrackAgent } from '../services/agent-registry';
import { resolveProfileEnv } from '../services/agent-system';
import { appLog } from '../services/log-service';
import { withValidatedArgs, stringArg, objectArg } from './validation';
import * as ptyManager from '../services/pty-manager';
import * as headlessManager from '../services/headless-manager';
import * as structuredManager from '../services/structured-manager';
import * as configPipeline from '../services/config-pipeline';
import * as freeAgentSettings from '../services/free-agent-settings';
import { waitReady as waitHookServerReady } from '../services/hook-server';
import { waitReady as waitMcpBridgeReady } from '../services/clubhouse-mcp/bridge-server';
import { injectClubhouseMcp, buildClubhouseMcpDef } from '../services/clubhouse-mcp/injection';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { isHookCapable, isHeadlessCapable, isStructuredCapable } from '../orchestrators';
import type { OrchestratorId } from '../orchestrators';

const ASSISTANT_TARGET_ID = 'clubhouse_assistant';
const LOG_NS = 'core:assistant';

/** Get or create the assistant workspace directory. */
function getAssistantWorkspace(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  const workspace = path.join(home, '.clubhouse', 'assistant');
  if (!fs.existsSync(workspace)) {
    fs.mkdirSync(workspace, { recursive: true });
    appLog(LOG_NS, 'info', 'Created assistant workspace', { meta: { path: workspace } });
  }
  // Ensure .clubhouse/settings.json exists to suppress ENOENT warnings
  // from readProjectAgentDefaults which expects this file in every "project"
  const settingsDir = path.join(workspace, '.clubhouse');
  const settingsFile = path.join(settingsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(settingsFile, '{}', 'utf-8');
  }
  return workspace;
}

interface AssistantSpawnParams {
  agentId: string;
  mission: string;
  systemPrompt: string;
  executionMode: 'interactive' | 'structured' | 'headless';
  orchestrator?: string;
  model?: string;
}

interface AssistantFollowupParams {
  message: string;
  orchestrator?: string;
  model?: string;
}

export function registerAssistantHandlers(): void {
  // ── SPAWN ────────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.ASSISTANT.SPAWN, withValidatedArgs(
    [objectArg<AssistantSpawnParams>()],
    async (_event, params) => {
      const { agentId, mission, systemPrompt, executionMode, model } = params as AssistantSpawnParams;
      const orchestratorId = (params as AssistantSpawnParams).orchestrator;

      appLog(LOG_NS, 'info', 'Spawn requested', {
        meta: { agentId, executionMode, orchestrator: orchestratorId || 'default', model: model || 'default' },
      });

      const workspace = getAssistantWorkspace();

      // Write the system prompt as CLAUDE.md in the workspace
      try {
        fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), systemPrompt, 'utf-8');
        appLog(LOG_NS, 'info', 'Wrote CLAUDE.md to workspace', { meta: { path: workspace, length: systemPrompt.length } });
      } catch (err) {
        appLog(LOG_NS, 'warn', 'Failed to write CLAUDE.md', { meta: { error: String(err) } });
      }

      // Resolve orchestrator
      let provider;
      try {
        provider = await resolveOrchestrator(workspace, orchestratorId as OrchestratorId | undefined);
        appLog(LOG_NS, 'info', 'Orchestrator resolved', { meta: { id: provider.id, displayName: provider.displayName } });
      } catch (err) {
        const msg = `Failed to resolve orchestrator: ${err instanceof Error ? err.message : String(err)}`;
        appLog(LOG_NS, 'error', msg);
        throw new Error(msg);
      }

      // Write system prompt to provider-specific instructions file so
      // non-Claude-Code orchestrators (Copilot, Codex) have context.
      const localInstructions = provider.conventions?.localInstructionsFile;
      if (localInstructions && localInstructions !== 'CLAUDE.md') {
        try {
          const instrPath = path.join(workspace, localInstructions);
          fs.mkdirSync(path.dirname(instrPath), { recursive: true });
          fs.writeFileSync(instrPath, systemPrompt, 'utf-8');
          appLog(LOG_NS, 'info', `Wrote ${localInstructions} to workspace`, { meta: { path: instrPath } });
        } catch (err) {
          appLog(LOG_NS, 'warn', `Failed to write ${localInstructions}`, { meta: { error: String(err) } });
        }
      }

      // Profile env
      const profileEnv = await resolveProfileEnv(workspace, provider.id);

      // Pre-flight check
      const availability = await provider.checkAvailability(profileEnv);
      appLog(LOG_NS, 'info', 'Pre-flight check', {
        meta: { orchestrator: provider.id, available: availability.available, error: availability.error },
      });
      if (!availability.available) {
        throw new Error(availability.error || `${provider.displayName} is not available`);
      }

      // Register agent
      const runtime = executionMode === 'structured' ? 'structured' : executionMode === 'headless' ? 'headless' : 'pty';
      agentRegistry.register(agentId, {
        projectPath: workspace,
        orchestrator: provider.id as OrchestratorId,
        runtime,
      });
      appLog(LOG_NS, 'info', 'Agent registered', { meta: { agentId, runtime, projectPath: workspace } });

      // Create MCP binding so assistant tools are visible
      bindingManager.bind(agentId, {
        targetId: ASSISTANT_TARGET_ID,
        targetKind: 'assistant',
        label: 'Clubhouse Assistant',
      });
      appLog(LOG_NS, 'info', 'MCP binding created', { meta: { agentId, targetId: ASSISTANT_TARGET_ID } });

      const permissionMode = freeAgentSettings.getPermissionMode(workspace);

      try {
        if (executionMode === 'structured') {
          await spawnStructured(agentId, workspace, provider, mission, systemPrompt, model, profileEnv, permissionMode);
        } else if (executionMode === 'headless') {
          await spawnHeadless(agentId, workspace, provider, mission, systemPrompt, model, profileEnv, permissionMode);
        } else {
          await spawnInteractive(agentId, workspace, provider, mission, systemPrompt, model, profileEnv, permissionMode);
        }

        appLog(LOG_NS, 'info', 'Agent spawned successfully', { meta: { agentId, executionMode } });
        return { success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appLog(LOG_NS, 'error', 'Spawn failed', { meta: { agentId, executionMode, error: msg } });
        // Cleanup on failure
        bindingManager.unbind(agentId, ASSISTANT_TARGET_ID);
        untrackAgent(agentId);
        throw new Error(msg);
      }
    },
  ));

  // ── SEND_FOLLOWUP ───────────────────────────────────────────────────────
  // Spawns a new headless agent with --continue to resume the previous
  // session in the assistant workspace. Returns { agentId } so the renderer
  // can track the follow-up. Broadcasts ASSISTANT.RESULT on completion.
  ipcMain.handle(IPC.ASSISTANT.SEND_FOLLOWUP, withValidatedArgs(
    [objectArg<AssistantFollowupParams>()],
    async (_event, params) => {
      const { message, model } = params as AssistantFollowupParams;
      const orchestratorId = (params as AssistantFollowupParams).orchestrator;

      const agentId = `assistant_followup_${Date.now()}_${randomUUID().slice(0, 8)}`;
      const workspace = getAssistantWorkspace();

      appLog(LOG_NS, 'info', 'Follow-up requested', {
        meta: { agentId, orchestrator: orchestratorId || 'default', messageLength: message.length },
      });

      // Resolve orchestrator
      const provider = await resolveOrchestrator(workspace, orchestratorId as OrchestratorId | undefined);
      if (!isHeadlessCapable(provider)) {
        throw new Error(`${provider.displayName} does not support headless mode`);
      }

      const profileEnv = await resolveProfileEnv(workspace, provider.id);
      const permissionMode = freeAgentSettings.getPermissionMode(workspace);

      const nonce = randomUUID();
      // Register the follow-up agent (each follow-up gets its own agentId)
      agentRegistry.register(agentId, {
        projectPath: workspace,
        orchestrator: provider.id as OrchestratorId,
        runtime: 'headless',
      });
      agentRegistry.setNonce(agentId, nonce);

      // Create MCP binding for this follow-up agent
      bindingManager.bind(agentId, {
        targetId: ASSISTANT_TARGET_ID,
        targetKind: 'assistant',
        label: 'Clubhouse Assistant',
      });
      appLog(LOG_NS, 'info', 'Follow-up: registered agent and MCP binding', { meta: { agentId } });

      // MCP injection
      let mcpPort = 0;
      const mcpConfigFile = provider.conventions?.mcpConfigFile || '.mcp.json';
      const mcpJsonPath = path.join(workspace, mcpConfigFile);
      configPipeline.snapshotFile(agentId, mcpJsonPath);

      try {
        mcpPort = await waitMcpBridgeReady();
        await injectClubhouseMcp(workspace, agentId, mcpPort, nonce, provider.conventions);
      } catch {
        appLog(LOG_NS, 'warn', 'MCP bridge not available for follow-up', { meta: { agentId } });
      }

      // Build headless command — session persists so --continue works
      const headlessResult = await provider.buildHeadlessCommand({
        cwd: workspace, model, mission: message,
        agentId, freeAgentMode: true, permissionMode,
        // No noSessionPersistence — sessions must persist for --continue
        resume: true, // signals continuation
      });

      if (!headlessResult) {
        throw new Error('Provider returned null for headless command');
      }

      const { binary } = headlessResult;
      let { args } = headlessResult;

      // Add --continue to resume the most recent session
      args = [...args, '--continue'];

      if (mcpPort > 0 && provider.buildMcpArgs) {
        const serverDef = buildClubhouseMcpDef(mcpPort, agentId, nonce);
        args = [...args, ...provider.buildMcpArgs(serverDef)];
      }

      appLog(LOG_NS, 'info', 'Follow-up headless spawn', {
        meta: { agentId, binary, args: args.join(' '), cwd: workspace },
      });

      const spawnEnv: Record<string, string> = {
        ...headlessResult.env, ...profileEnv,
        CLUBHOUSE_AGENT_ID: agentId,
        CLUBHOUSE_HOOK_NONCE: nonce,
        ...(mcpPort > 0 ? { CLUBHOUSE_MCP_PORT: String(mcpPort) } : {}),
      };

      await headlessManager.spawnHeadless(
        agentId, workspace, binary, args, spawnEnv,
        headlessResult.outputKind || 'stream-json',
        (exitAgentId, exitCode) => {
          appLog(LOG_NS, 'info', 'Follow-up headless exited', { meta: { agentId: exitAgentId, exitCode } });
          // Notify renderer that the follow-up completed
          broadcastToAllWindows(IPC.ASSISTANT.RESULT, { agentId: exitAgentId, exitCode });
          // DON'T unbind or untrack — we want to keep the MCP binding alive
          // for future follow-ups. Cleanup happens on explicit reset only.
        },
      );

      return { agentId };
    },
  ));

  // ── BIND (standalone, for manual binding if needed) ──────────────────────
  ipcMain.handle(IPC.ASSISTANT.BIND, withValidatedArgs(
    [stringArg()],
    (_event, agentId) => {
      if (!agentRegistry.get(agentId as string)) {
        throw new Error(`Agent not registered: ${agentId}`);
      }
      bindingManager.bind(agentId as string, {
        targetId: ASSISTANT_TARGET_ID,
        targetKind: 'assistant',
        label: 'Clubhouse Assistant',
      });
      appLog(LOG_NS, 'info', 'MCP binding created (manual)', { meta: { agentId } });
    },
  ));

  // ── UNBIND ───────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.ASSISTANT.UNBIND, withValidatedArgs(
    [stringArg()],
    (_event, agentId) => {
      bindingManager.unbind(agentId as string, ASSISTANT_TARGET_ID);
      appLog(LOG_NS, 'info', 'MCP binding removed', { meta: { agentId } });
    },
  ));

  // ── RESET ─────────────────────────────────────────────────────────────────
  // Full cleanup of assistant resources. Called when user resets the assistant.
  ipcMain.handle(IPC.ASSISTANT.RESET, withValidatedArgs(
    [stringArg()],
    (_event, agentId) => {
      appLog(LOG_NS, 'info', 'Assistant reset requested', { meta: { agentId } });
      configPipeline.restoreForAgent(agentId as string);
      bindingManager.unbindAgent(agentId as string);
      untrackAgent(agentId as string);
    },
  ));

  // ── SAVE_HISTORY ──────────────────────────────────────────────────────────
  // Persist chat history to the assistant workspace for session restoration.
  ipcMain.handle(IPC.ASSISTANT.SAVE_HISTORY, withValidatedArgs(
    [objectArg<{ items: any[] }>()],
    async (_event, params) => {
      const { items } = params as { items: any[] };
      const workspace = getAssistantWorkspace();
      const historyPath = path.join(workspace, 'chat-history.json');
      try {
        await fs.promises.writeFile(historyPath, JSON.stringify(items), 'utf-8');
        appLog(LOG_NS, 'info', 'Chat history saved', { meta: { items: items.length } });
      } catch (err) {
        appLog(LOG_NS, 'warn', 'Failed to save chat history', { meta: { error: String(err) } });
      }
    },
  ));

  // ── LOAD_HISTORY ──────────────────────────────────────────────────────────
  // Load chat history from the assistant workspace.
  ipcMain.handle(IPC.ASSISTANT.LOAD_HISTORY, async () => {
    const workspace = getAssistantWorkspace();
    const historyPath = path.join(workspace, 'chat-history.json');
    try {
      const data = await fs.promises.readFile(historyPath, 'utf-8');
      const items = JSON.parse(data);
      appLog(LOG_NS, 'info', 'Chat history loaded', { meta: { items: items.length } });
      return items;
    } catch {
      return null;
    }
  });
}

// ── Spawn Paths ──────────────────────────────────────────────────────────────

async function spawnInteractive(
  agentId: string, workspace: string, provider: any,
  mission: string, systemPrompt: string, model: string | undefined,
  profileEnv: Record<string, string> | undefined, permissionMode: 'auto' | 'skip-all',
): Promise<void> {
  const nonce = randomUUID();
  agentRegistry.setNonce(agentId, nonce);

  // Snapshot MCP config before injection
  const mcpConfigFile = provider.conventions?.mcpConfigFile || '.mcp.json';
  const mcpJsonPath = path.join(workspace, mcpConfigFile);
  configPipeline.snapshotFile(agentId, mcpJsonPath);

  // Parallel: hook server + MCP bridge + spawn command
  let mcpPort = 0;
  // Don't pass mission to buildSpawnCommand for providers that use -p (Copilot,
  // Codex) — -p enters one-shot prompt mode and exits, crashing the PTY session.
  // Claude Code handles positional args correctly for interactive mode.
  // The system prompt is never passed — it's in the instructions file.
  const interactiveMission = provider.id === 'claude-code' ? mission : undefined;
  const [, , spawnCmd] = await Promise.all([
    waitHookServerReady().then(async (port) => {
      if (isHookCapable(provider)) {
        await provider.writeHooksConfig(workspace, `http://127.0.0.1:${port}/hook`);
        appLog(LOG_NS, 'info', 'Hook config written', { meta: { agentId, hookPort: port } });
      }
    }).catch((err) => {
      appLog(LOG_NS, 'warn', 'Hook server not available for interactive mode', { meta: { agentId, error: String(err) } });
    }),
    waitMcpBridgeReady().then(async (port) => {
      mcpPort = port;
      await injectClubhouseMcp(workspace, agentId, port, nonce, provider.conventions);
      appLog(LOG_NS, 'info', 'MCP config injected', { meta: { agentId, mcpPort: port } });
    }).catch((err) => {
      appLog(LOG_NS, 'warn', 'MCP bridge not available', { meta: { agentId, error: String(err) } });
    }),
    provider.buildSpawnCommand({
      cwd: workspace, model, mission: interactiveMission,
      agentId, freeAgentMode: true, permissionMode,
    }),
  ]);

  const { binary } = spawnCmd;
  let { args } = spawnCmd;
  const { env } = spawnCmd;

  // CLI-based MCP args for providers that need them
  if (mcpPort > 0 && provider.buildMcpArgs) {
    const serverDef = buildClubhouseMcpDef(mcpPort, agentId, nonce);
    args = [...args, ...provider.buildMcpArgs(serverDef)];
  }

  appLog(LOG_NS, 'info', 'PTY spawn starting', {
    meta: { agentId, binary, args: args.join(' '), cwd: workspace, mcpPort },
  });

  const spawnEnv: Record<string, string> = {
    ...env, ...profileEnv,
    CLUBHOUSE_AGENT_ID: agentId,
    CLUBHOUSE_HOOK_NONCE: nonce,
    ...(mcpPort > 0 ? { CLUBHOUSE_MCP_PORT: String(mcpPort) } : {}),
  };

  await ptyManager.spawn(agentId, workspace, binary, args, spawnEnv, (exitAgentId, exitCode, buffer) => {
    appLog(LOG_NS, 'info', 'Interactive PTY exited', { meta: { agentId: exitAgentId, exitCode, bufferLength: buffer?.length || 0 } });
    // DON'T unbind or untrack — conversation continues with follow-ups.
    // Cleanup happens on explicit reset only.
  });
}

async function spawnStructured(
  agentId: string, workspace: string, provider: any,
  mission: string, systemPrompt: string, model: string | undefined,
  profileEnv: Record<string, string> | undefined, permissionMode: 'auto' | 'skip-all',
): Promise<void> {
  if (!isStructuredCapable(provider)) {
    throw new Error(`${provider.displayName} does not support structured mode`);
  }

  const nonce = randomUUID();
  agentRegistry.setNonce(agentId, nonce);
  agentRegistry.setRuntime(agentId, 'structured');

  // MCP injection — same as headless/interactive so assistant tools are visible
  let mcpPort = 0;
  const mcpConfigFile = provider.conventions?.mcpConfigFile || '.mcp.json';
  const mcpJsonPath = path.join(workspace, mcpConfigFile);
  configPipeline.snapshotFile(agentId, mcpJsonPath);

  try {
    mcpPort = await waitMcpBridgeReady();
    await injectClubhouseMcp(workspace, agentId, mcpPort, nonce, provider.conventions);
    appLog(LOG_NS, 'info', 'MCP config injected (structured)', { meta: { agentId, mcpPort } });
  } catch {
    appLog(LOG_NS, 'warn', 'MCP bridge not available for structured', { meta: { agentId } });
  }

  const adapter = provider.createStructuredAdapter();
  appLog(LOG_NS, 'info', 'Structured adapter created', { meta: { agentId, orchestrator: provider.id } });

  // Build env with Clubhouse-specific variables
  const structuredEnv: Record<string, string> = {
    ...profileEnv,
    CLUBHOUSE_AGENT_ID: agentId,
    CLUBHOUSE_HOOK_NONCE: nonce,
    ...(mcpPort > 0 ? { CLUBHOUSE_MCP_PORT: String(mcpPort) } : {}),
  };

  await structuredManager.startStructuredSession(agentId, adapter, {
    mission, systemPrompt, model, cwd: workspace,
    env: structuredEnv, freeAgentMode: true, permissionMode,
  }, (exitAgentId) => {
    appLog(LOG_NS, 'info', 'Structured session ended', { meta: { agentId: exitAgentId } });
    configPipeline.restoreForAgent(exitAgentId);
    // Don't unbind/untrack immediately — allow follow-ups via new sessions.
    // Cleanup happens on explicit reset only, same as headless conversational mode.
  });

  appLog(LOG_NS, 'info', 'Structured session started', { meta: { agentId } });
}

async function spawnHeadless(
  agentId: string, workspace: string, provider: any,
  mission: string, systemPrompt: string, model: string | undefined,
  profileEnv: Record<string, string> | undefined, permissionMode: 'auto' | 'skip-all',
): Promise<void> {
  if (!isHeadlessCapable(provider)) {
    throw new Error(`${provider.displayName} does not support headless mode`);
  }

  const nonce = randomUUID();
  agentRegistry.setNonce(agentId, nonce);
  agentRegistry.setRuntime(agentId, 'headless');

  // MCP injection for headless
  let mcpPort = 0;
  const mcpConfigFile = provider.conventions?.mcpConfigFile || '.mcp.json';
  const mcpJsonPath = path.join(workspace, mcpConfigFile);
  configPipeline.snapshotFile(agentId, mcpJsonPath);

  try {
    mcpPort = await waitMcpBridgeReady();
    await injectClubhouseMcp(workspace, agentId, mcpPort, nonce, provider.conventions);
    appLog(LOG_NS, 'info', 'MCP config injected (headless)', { meta: { agentId, mcpPort } });
  } catch {
    appLog(LOG_NS, 'warn', 'MCP bridge not available for headless', { meta: { agentId } });
  }

  // Session persistence is enabled (no noSessionPersistence flag) so that
  // follow-up messages can use --continue to resume the conversation.
  const headlessResult = await provider.buildHeadlessCommand({
    cwd: workspace, model, mission, systemPrompt,
    agentId, freeAgentMode: true, permissionMode,
  });

  if (!headlessResult) {
    throw new Error('Provider returned null for headless command');
  }

  const { binary } = headlessResult;
  let { args } = headlessResult;
  if (mcpPort > 0 && provider.buildMcpArgs) {
    const serverDef = buildClubhouseMcpDef(mcpPort, agentId, nonce);
    args = [...args, ...provider.buildMcpArgs(serverDef)];
  }

  appLog(LOG_NS, 'info', 'Headless spawn starting', {
    meta: { agentId, binary, args: args.join(' '), cwd: workspace, mcpPort },
  });

  const spawnEnv: Record<string, string> = {
    ...headlessResult.env, ...profileEnv,
    CLUBHOUSE_AGENT_ID: agentId,
    CLUBHOUSE_HOOK_NONCE: nonce,
    ...(mcpPort > 0 ? { CLUBHOUSE_MCP_PORT: String(mcpPort) } : {}),
  };

  await headlessManager.spawnHeadless(
    agentId, workspace, binary, args, spawnEnv,
    headlessResult.outputKind || 'stream-json',
    (exitAgentId, exitCode) => {
      appLog(LOG_NS, 'info', 'Headless exited', { meta: { agentId: exitAgentId, exitCode } });
      // Notify renderer that the headless agent completed.
      // DON'T unbind or untrack — conversation continues with follow-ups.
      // Cleanup happens on explicit reset only (same as interactive mode).
      broadcastToAllWindows(IPC.ASSISTANT.RESULT, { agentId: exitAgentId, exitCode });
      configPipeline.restoreForAgent(exitAgentId);
      // DON'T unbind or untrack — conversation continues with follow-ups.
      // Cleanup happens on explicit reset only.
    },
  );
}
