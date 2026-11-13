/**
 * Shoulder Tap — urgent, ephemeral direct messaging for group project agents.
 *
 * Shared by MCP tool handler (agent taps) AND IPC handler (human taps).
 * Injects a message into the target agent's PTY. The
 * tap is NOT recorded to the bulletin board — if a response is expected,
 * the target is told to post to the sender's inbox channel.
 */

import { agentRegistry } from './agent-registry';
import { inboxChannelName } from './group-project-bulletin';
import { groupProjectRegistry } from './group-project-registry';
import { groupProjectHost } from './group-project-host';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { buildToolName } from './clubhouse-mcp/tool-registry';
import { getAgentRuntime } from './agent-runtime';
import { isAgentStoppingError } from './agent-runtime/agent-stopping';
import { appLog } from './log-service';
import { ATTR } from '../../shared/telemetry/attributes';
import { tel } from '../telemetry/facade';
import { groupProjectMay } from './group-project-roles';
import { findDurableAgentConfig } from './clubhouse-mcp/tools/agent-lifecycle';
import * as agentSystem from './agent-system';

/** Wake a sleeping durable member with the tap as its first message. False when it can't be found or started. */
async function wakeWithTap(agentId: string, message: string): Promise<boolean> {
  try {
    const durable = await findDurableAgentConfig(agentId);
    if (!durable) return false;
    const { agentConfig, projectPath } = durable;
    await agentSystem.spawnAgent({
      agentId, projectPath, cwd: agentConfig.worktreePath || projectPath, kind: 'durable',
      model: agentConfig.model, mission: message, orchestrator: agentConfig.orchestrator, freeAgentMode: agentConfig.freeAgentMode,
    });
    return true;
  } catch (err) {
    // telemetry-exempt: reported as not delivered in the tap's result; logged
    appLog('core:group-project', 'warn', 'Shoulder tap could not wake the member', { meta: { agentId, error: err instanceof Error ? err.message : String(err) } });
    return false;
  }
}

export interface ShoulderTapParams {
  projectId: string;
  senderLabel: string;        // "agentName@proj" or "user"
  senderKind?: 'group_project_action';
  senderAgentId?: string;     // set when the sender is an agent
  targetAgentId: string | null; // null = broadcast to all members
  message: string;
  taskId?: string;
}

export interface ShoulderTapDelivery {
  agentId: string;
  agentName: string;
  /** `woken`: it was asleep, and the group project's wake grant woke it with the tap (#3360). */
  status: 'delivered' | 'woken' | 'not-running' | 'unsupported-runtime';
  /** Why a sleeping member wasn't woken: the group project's wake grant is off. */
  refusal?: 'group_project_wake_off';
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
async function senderReplyChannel(projectId: string, senderLabel: string, senderAgentId?: string): Promise<string | null> {
  if (!senderLabel || senderLabel === 'user') return null;
  const senderAgentName = senderLabel.split('@')[0];
  if (!senderAgentName) return null;
  if (senderAgentId) {
    // The sender's own inbox, which a same-named member doesn't share (#1646).
    try { return await groupProjectHost.inboxFor(projectId, senderAgentName, senderAgentId); } catch { /* telemetry-exempt: name-derived fallback */ }
  }
  return inboxChannelName(senderAgentName);
}

const DELIVERY_RESULT = {
  'delivered': 'delivered',
  'woken': 'woken',
  'not-running': 'not_running',
  'unsupported-runtime': 'unsupported_runtime',
} as const;

/**
 * Deliver a shoulder tap, recorded as `clubhouse.group.shoulder_tap`: no
 * targets is `skipped`, every target failing is `tap_undelivered`.
 */
export function executeShoulderTap(params: ShoulderTapParams): Promise<ShoulderTapResult> {
  const broadcast = !params.targetAgentId || params.targetAgentId === 'all';
  return tel.flow('clubhouse.group.shoulder_tap', { attrs: [ATTR.tapBroadcast(broadcast)] }, async (span) => {
    const result = await deliverShoulderTap(params);
    span.set(ATTR.targetsCount(result.delivered.length + result.failed.length));
    return result;
  }, {
    classify: (r) => {
      if (r.delivered.length + r.failed.length === 0) return { outcome: 'skipped' };
      return r.delivered.length === 0 ? { error: 'tap_undelivered' } : 'ok';
    },
  });
}

function recordDelivery(status: ShoulderTapDelivery['status'], runtime: 'pty' | 'chat' | undefined): void {
  const attrs = [ATTR.deliveryResult(DELIVERY_RESULT[status])];
  if (runtime) attrs.push(ATTR.agentRuntime(runtime));
  tel.count('clubhouse.group.shoulder_tap.deliveries', 1, attrs);
}

async function deliverShoulderTap(params: ShoulderTapParams): Promise<ShoulderTapResult> {
  const { projectId, senderLabel, targetAgentId, message } = params;
  const taskId = params.taskId || `tap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  // Resolve project name
  const project = await groupProjectRegistry.get(projectId);
  const projectName = project?.name || projectId;

  const replyChannel = params.senderKind === 'group_project_action' ? null : await senderReplyChannel(projectId, senderLabel, params.senderAgentId);

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
          params.senderKind === 'group_project_action'
            ? `This tap was initiated by a group project Action. No channel reply is required;`
            : `This tap was initiated by a human user. No channel reply is required;`,
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

    if (!reg) {
      // A sleeping member: the group project wakes it with the tap only when it holds the wake grant (#3360).
      if (project && groupProjectMay(project, 'wake') && await wakeWithTap(binding.agentId, taggedMessage)) {
        delivered.push({ agentId: binding.agentId, agentName, status: 'woken' });
        recordDelivery('woken', undefined);
      } else {
        failed.push({ agentId: binding.agentId, agentName, status: 'not-running', ...(project && !groupProjectMay(project, 'wake') && { refusal: 'group_project_wake_off' as const }) });
        recordDelivery('not-running', undefined);
      }
      continue;
    }

    const runtime = getAgentRuntime(binding.agentId);
    try {
      if (runtime) {
        await runtime.sendMessage(taggedMessage, {
          source: 'shoulder_tap', taskId,
          // A tap from the UI has no sender to show: chat reads it as the user's own.
          ...(params.senderAgentId && {
            routed: [{ sender: { agentId: params.senderAgentId, name: senderLabel.split('@')[0] }, text: message }],
          }),
        });
        delivered.push({ agentId: binding.agentId, agentName, status: 'delivered' });
        recordDelivery('delivered', runtime.kind);
      } else {
        failed.push({ agentId: binding.agentId, agentName, status: 'unsupported-runtime' });
        recordDelivery('unsupported-runtime', undefined);
      }
    } catch (err) {
      // A terminal agent that is shutting down refuses the tap; for delivery it is not running.
      const stopping = isAgentStoppingError(err);
      appLog('core:group-project', stopping ? 'info' : 'error', stopping ? 'Shoulder tap not delivered: the agent is shutting down' : 'Shoulder tap delivery failed', {
        meta: { agentId: binding.agentId, taskId, error: err instanceof Error ? err.message : String(err) },
      });
      failed.push({ agentId: binding.agentId, agentName, status: 'not-running' });
      recordDelivery('not-running', runtime?.kind);
    }
  }

  appLog('core:group-project', 'info', 'Shoulder tap executed', {
    meta: { projectId, taskId, senderLabel, deliveredCount: delivered.length, failedCount: failed.length },
  });

  return { taskId, delivered, failed };
}
