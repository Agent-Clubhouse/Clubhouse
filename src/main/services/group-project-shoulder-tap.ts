/**
 * Shoulder Tap — urgent, ephemeral direct messaging for group project agents.
 *
 * Shared by MCP tool handler (agent taps) AND IPC handler (human taps).
 * Injects a message into the target agent's PTY (or structured input). The
 * tap is NOT recorded to the bulletin board — if a response is expected,
 * the target is told to post to the sender's inbox channel.
 */

import { agentRegistry } from './agent-registry';
import * as structuredManager from './structured-manager';
import { inboxChannelName } from './group-project-bulletin';
import { groupProjectRegistry } from './group-project-registry';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { buildToolName } from './clubhouse-mcp/tool-registry';
import { writeChunkedBracketedPaste, submitAfterPaste } from './clubhouse-mcp/tools/agent-tools';
import { getProvider } from '../orchestrators';
import type { PasteSubmitTiming } from '../orchestrators';
import { appLog } from './log-service';

/** Default paste submit timing used when no provider is available. */
const DEFAULT_TIMING: PasteSubmitTiming = {
  initialDelayMs: 500,
  retryDelayMs: 300,
  finalCheckDelayMs: 250,
  chunkSize: 512,
  chunkDelayMs: 50,
  postEndMarkerDelayMs: 150,
};

export interface ShoulderTapParams {
  projectId: string;
  senderLabel: string;        // "agentName@proj" or "user"
  targetAgentId: string | null; // null = broadcast to all members
  message: string;
  taskId?: string;
}

export interface ShoulderTapDelivery {
  agentId: string;
  agentName: string;
  status: 'delivered' | 'not-running' | 'unsupported-runtime';
}

export interface ShoulderTapResult {
  taskId: string;
  delivered: ShoulderTapDelivery[];
  failed: ShoulderTapDelivery[];
}

/**
 * Derive the reply channel for a shoulder tap target: the sender's inbox
 * channel if the sender is an agent (senderLabel is `agentName@projectName`),
 * or null when the sender is the UI/human user.
 */
function senderReplyChannel(senderLabel: string): string | null {
  if (!senderLabel || senderLabel === 'user') return null;
  const senderAgentName = senderLabel.split('@')[0];
  if (!senderAgentName) return null;
  return inboxChannelName(senderAgentName);
}

export async function executeShoulderTap(params: ShoulderTapParams): Promise<ShoulderTapResult> {
  const { projectId, senderLabel, targetAgentId, message } = params;
  const taskId = params.taskId || `tap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  // Resolve project name
  const project = await groupProjectRegistry.get(projectId);
  const projectName = project?.name || projectId;

  const replyChannel = senderReplyChannel(senderLabel);

  // Find target agents
  const allBindings = bindingManager.getAllBindings();
  const members = allBindings.filter(
    b => b.targetKind === 'group-project' && b.targetId === projectId,
  );

  let targets: typeof members;
  if (!targetAgentId || targetAgentId === 'all') {
    // Broadcast to all members, excluding sender if sender is an agent
    targets = members.filter(b => {
      const agentLabel = b.agentName
        ? `${b.agentName}${b.projectName ? '@' + b.projectName : ''}`
        : b.agentId;
      return agentLabel !== senderLabel;
    });
  } else {
    targets = members.filter(b => b.agentId === targetAgentId);
  }

  const delivered: ShoulderTapDelivery[] = [];
  const failed: ShoulderTapDelivery[] = [];

  for (const binding of targets) {
    const agentName = binding.agentName || binding.agentId;
    const reg = agentRegistry.get(binding.agentId);

    if (!reg) {
      failed.push({ agentId: binding.agentId, agentName, status: 'not-running' });
      continue;
    }

    // Build the response tool name for this agent's group binding
    const replyToolName = buildToolName(binding, 'post_bulletin');

    // Build the injected message. This tap is ephemeral — no bulletin record
    // was written — so the only trail of this exchange is what the target
    // chooses to post in reply. Point them at the sender's inbox channel.
    const replyLines = replyChannel
      ? [
          `To respond, use your ${replyToolName} tool:`,
          `  topic: "${replyChannel}"    (sender's inbox)`,
          `  body: "TASK_RESULT:${taskId}: <your response>"`,
          `To acknowledge: body: "TASK_ACK:${taskId}: Working on it"`,
        ]
      : [
          `This tap was initiated by a human user. No channel reply is required;`,
          `if you need to follow up, post a status update to "general".`,
        ];

    const taggedMessage =
      `Group Project notification — shoulder tap from "${senderLabel}" in "${projectName}"\n` +
      `${message}\n\n` +
      `---\n` +
      `RESPONSE INSTRUCTIONS:\n` +
      `Project: "${projectName}" (ID: ${projectId})\n` +
      `Task ID: ${taskId}\n` +
      `This tap is ephemeral — no bulletin record was created.\n\n` +
      replyLines.join('\n');

    try {
      if (reg.runtime === 'pty') {
        // Use chunked bracketed paste with provider-specific timing
        const provider = getProvider(reg.orchestrator);
        const timing: PasteSubmitTiming = provider?.getPasteSubmitTiming() ?? DEFAULT_TIMING;

        await writeChunkedBracketedPaste(
          binding.agentId,
          taggedMessage,
          timing.chunkSize,
          timing.chunkDelayMs,
          timing.postEndMarkerDelayMs,
        );

        await submitAfterPaste(binding.agentId, timing);

        delivered.push({ agentId: binding.agentId, agentName, status: 'delivered' });
      } else if (reg.runtime === 'structured') {
        await structuredManager.sendMessage(binding.agentId, taggedMessage);
        delivered.push({ agentId: binding.agentId, agentName, status: 'delivered' });
      } else {
        failed.push({ agentId: binding.agentId, agentName, status: 'unsupported-runtime' });
      }
    } catch (err) {
      appLog('core:group-project', 'error', 'Shoulder tap delivery failed', {
        meta: { agentId: binding.agentId, taskId, error: err instanceof Error ? err.message : String(err) },
      });
      failed.push({ agentId: binding.agentId, agentName, status: 'not-running' });
    }
  }

  appLog('core:group-project', 'info', 'Shoulder tap executed', {
    meta: { projectId, taskId, senderLabel, deliveredCount: delivered.length, failedCount: failed.length },
  });

  return { taskId, delivered, failed };
}
