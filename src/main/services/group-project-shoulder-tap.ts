/**
 * Shoulder Tap — urgent direct messaging for group project agents.
 *
 * Shared by MCP tool handler (agent taps) AND IPC handler (human taps).
 * Injects a message into the target agent's PTY (or structured input) with
 * clear response instructions pointing back to the bulletin board.
 */

import { agentRegistry } from './agent-registry';
import * as ptyManager from './pty-manager';
import * as structuredManager from './structured-manager';
import { getBulletinBoard } from './group-project-bulletin';
import { groupProjectRegistry } from './group-project-registry';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { buildToolName } from './clubhouse-mcp/tool-registry';
import { appLog } from './log-service';

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
  messageId: string;
  delivered: ShoulderTapDelivery[];
  failed: ShoulderTapDelivery[];
}

export async function executeShoulderTap(params: ShoulderTapParams): Promise<ShoulderTapResult> {
  const { projectId, senderLabel, targetAgentId, message } = params;
  const taskId = params.taskId || `tap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  // Resolve project name
  const project = await groupProjectRegistry.get(projectId);
  const projectName = project?.name || projectId;

  // Record tap to bulletin board
  const board = getBulletinBoard(projectId);
  const tapRecord = JSON.stringify({
    taskId,
    from: senderLabel,
    to: targetAgentId || 'all',
    message,
  });
  const bulletinMsg = await board.postMessage(senderLabel, 'shoulder-tap', tapRecord);

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

    // Build the injected message
    const taggedMessage =
      `Group Project notification — shoulder tap from "${senderLabel}" in "${projectName}"\n` +
      `${message}\n\n` +
      `---\n` +
      `RESPONSE INSTRUCTIONS:\n` +
      `Project: "${projectName}" (ID: ${projectId})\n` +
      `Task ID: ${taskId} | Message ID: ${bulletinMsg.id}\n\n` +
      `To respond, use your ${replyToolName} tool:\n` +
      `  topic: "shoulder-tap"\n` +
      `  body: "TASK_RESULT:${taskId}: <your response>"\n` +
      `To acknowledge: body: "TASK_ACK:${taskId}: Working on it"`;

    try {
      if (reg.runtime === 'pty') {
        // Bracketed paste + delayed submit (same pattern as agent-tools.ts send_message)
        ptyManager.write(binding.agentId, `\x1b[200~${taggedMessage}\x1b[201~`);
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            ptyManager.write(binding.agentId, '\r');
            resolve();
          }, 100);
        });
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

  return { taskId, messageId: bulletinMsg.id, delivered, failed };
}
