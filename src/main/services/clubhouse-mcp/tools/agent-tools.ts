import { federationMessageDirection } from '../../dispatcher-federation-policy';
import { dispatcherProviderControl } from '../../dispatcher-provider-control';
/**
 * Agent-to-Agent MCP Tools — allows linked agents to communicate.
 */

import * as path from 'path';
import { app } from 'electron';
import { createMessageFile, removeMessageFile } from './message-file';
import { buildToolName, callTool, canCallWake, keepsFirstToolList, registerGlobalTool } from '../tool-registry';
import { mcpAdapter } from '../mcp-adapter';
import { bindingManager } from '../binding-manager';
import { isTrackedDispatcher } from '../dispatcher-gate';
import { agentRegistry } from '../../agent-registry';
import { captureControllerPublication, currentRemoteCaller, type AgentToolRunResult } from '../../annex-agent-calls';
import type { McpToolResult } from '../types';
import { appLog } from '../../log-service';
import { requireString, optionalString, numberWithDefault } from './validation';
import { getAgentRuntime } from '../../agent-runtime';
import { chatEventsToText } from '../../agent-runtime/chat-text';
import { writeLineThenEnter } from '../../agent-runtime/pty-input';
import { DEFAULT_PASTE_TIMING } from '../../agent-runtime/pty-runtime';
import { isAgentStoppingError } from '../../agent-runtime/agent-stopping';
import { getProvider } from '../../../orchestrators';
import { sleepAgent, wakeWiredAgent } from './agent-lifecycle';
import { deliverToDispatcher, isDispatcherTarget, sleepingDispatcherHint } from './dispatcher-delivery';
import { isDispatcherAgentId, isDispatcherEnabled } from '../../dispatcher/dispatcher-service';
import { noteAgentReached } from '../../dispatcher/dispatcher-requests';
import type { RoutedMessagePart, RuntimeSendResult } from '../../../../shared/chat';
import { DISPATCHER_CONTROLLER_NAME } from '../../../../shared/dispatcher-name';

// PTY input helpers moved to agent-runtime/pty-input; re-exported for existing importers.
export { sleep, writeChunkedBracketedPaste, waitForBufferQuiescence, submitAfterPaste } from '../../agent-runtime/pty-input';

/** The Dispatcher messaged or woke an agent: that agent's news is for the request it is working on (#3204). */
function noteDispatcherReached(callerId: string, targetId: string): void {
  if (isDispatcherAgentId(callerId)) noteAgentReached(targetId);
}

// ── Sender label ────────────────────────────────────────────────────────────

/**
 * The `[FROM:...]` label of a sent message: `<name>@<project>`, or just the
 * name when the binding has no project. The Dispatcher lives in no project:
 * its bindings carry the orchestrator's project only for tool naming (#2548).
 */
export function buildSenderLabel(agentId: string, senderName: string, projectName?: string): string {
  if (!projectName || isTrackedDispatcher(agentId) || isDispatcherAgentId(agentId)) return senderName;
  return `${senderName}@${projectName}`;
}

/**
 * Who a message or file is from, as the target reads it, and the target's
 * name for the sender's answer. A caller on another machine has no binding
 * here: its machine said who it is (#3064), and the label names that machine.
 */
function senderOf(agentId: string, targetId: string): { senderName: string; senderLabel: string; targetName: string } {
  const sourceBinding = bindingManager.getBindingsForAgent(agentId).find(b => b.targetId === targetId);
  const remote = currentRemoteCaller();
  const senderName = remote ? `${remote.name} on ${remote.machineName}`
    : isDispatcherAgentId(agentId) ? DISPATCHER_CONTROLLER_NAME : sourceBinding?.agentName || agentId;
  const senderLabel = remote
    ? (remote.projectName ? `${remote.name}@${remote.projectName} on ${remote.machineName}` : senderName)
    : buildSenderLabel(agentId, senderName, sourceBinding?.projectName);
  const targetName = isDispatcherAgentId(targetId) ? DISPATCHER_CONTROLLER_NAME : sourceBinding?.targetName || remote?.targetName || targetId;
  return { senderName, senderLabel, targetName };
}

/**
 * A message as the target receives it: tagged with its task and sender, and
 * with reply instructions when the target has a wire back to the sender.
 */
function buildTaggedMessage(agentId: string, targetId: string, message: string, taskId: string): { text: string; routed: RoutedMessagePart[]; senderLabel: string; targetName: string; isBidirectional: boolean } {
  const { senderName, senderLabel, targetName } = senderOf(agentId, targetId);

  // Check if the target has a reverse binding back to the caller
  const reverseBinding = bindingManager.getBindingsForAgent(targetId).find(b => b.targetId === agentId);

  let text = `[TASK:${taskId}] [FROM:${senderLabel}] ${message}`;

  // If bidirectional, append reply instructions so the target knows how to respond
  if (reverseBinding) {
    const replyToolName = buildToolName(reverseBinding, 'send_message');
    // A CLI with a fixed tool list doesn't have this tool if the wire is newer than its session.
    const fallback = keepsFirstToolList(targetId)
      ? `If you don't have that tool, use call_wire_tool with target="${agentId}" and tool="send_message". `
      : '';
    text += `\n\n---\nReply to ${senderName} via tool "${replyToolName}" with task_id="${taskId}". ${fallback}` +
      `Prefix your response with TASK_RESULT:${taskId}.`;
  }
  const routed = [{ sender: { agentId, name: senderName }, text: message }];
  return { text, routed, senderLabel, targetName, isBidirectional: !!reverseBinding };
}

/** The error for a tool that needs the target awake. The Dispatcher wakes targets itself. */
function sleepingError(agentId: string, targetId: string, action: string): McpToolResult {
  // Only a caller that has wake_agent on this wire is pointed at it (#3215).
  const hint = canCallWake(agentId, targetId) ? `Call its wake_agent tool before ${action}.` : `Start it from Clubhouse before ${action}.`;
  return remoteDelivery({ content: [{ type: 'text', text: `Agent ${targetId} is sleeping. ${hint}` }], isError: true }, 'retry_later', 'sleeping');
}

function remoteDelivery(result: McpToolResult, state: NonNullable<AgentToolRunResult['annexDelivery']>['state'], reason?: string): AgentToolRunResult {
  return currentRemoteCaller() ? { ...result, annexDelivery: { state, ...(reason && { reason }) } } : result;
}

/** Leave remote work in its durable sender queue, not the volatile chat queue. */
function remoteInputPreflight(targetId: string, receiverWake = false): AgentToolRunResult | undefined {
  if (!currentRemoteCaller()) return undefined;
  const runtime = getAgentRuntime(targetId);
  if (receiverWake && !runtime && !agentRegistry.get(targetId)) return undefined;
  if (!runtime || (runtime.kind === 'chat' && (runtime.getState() !== 'idle' || runtime.hasPendingWork?.()))) {
    return remoteDelivery({ content: [{ type: 'text', text: 'The target is busy, starting or asleep. Input was not accepted; this delivery will retry later.' }], isError: true }, 'retry_later', 'target_not_ready');
  }
  return undefined;
}

function remoteInputReceipt(result: McpToolResult, sent?: RuntimeSendResult): AgentToolRunResult {
  if (!currentRemoteCaller()) return result;
  if (sent?.delivery === 'queued') {
    return remoteDelivery({ content: [{ type: 'text', text: 'Input was queued by the receiving runtime during a readiness race. Delivery is indeterminate; it will not be automatically resent. Inspect the target before sending new work.' }], isError: true }, 'indeterminate', 'runtime_queued');
  }
  return remoteDelivery(result, 'delivered');
}

// ── File-backed message helpers ─────────────────────────────────────────────

/** Write content privately. The task id is retained only for API compatibility. */
export async function writeMessageFile(_taskId: string, content: string): Promise<string> {
  return createMessageFile(content, app.getPath('temp'));
}

/** Schedule cleanup of this private file and its empty directory (default 5 min). */
export function scheduleMessageCleanup(filePath: string, delayMs = 5 * 60 * 1000): void {
  const timer = setTimeout(() => { void removeMessageFile(filePath); }, delayMs);
  timer.unref?.();
}

/** Register all agent-to-agent tool templates. */
export function registerAgentTools(): void {
  for (const change of [false, true]) {
    mcpAdapter.registerMcpCommand({
      id: change ? 'agent.changeProvider' : 'agent.previewProvider', category: 'agent',
      label: change ? 'Change Provider' : 'Preview Provider',
      mcp: { targetKind: 'agent', nameSuffix: change ? 'change_provider' : 'preview_provider', group: 'dispatcher', grant: { actions: ['agent.configure'], target: 'bound' } },
      description: change
        ? 'Save the previewed provider for this sleeping connected orchestrator. Requires expectedState from preview_provider. Never stops, wakes, resumes across providers, or changes access/model policy. Old sessions remain in history.'
        : 'Preview a provider change for this connected orchestrator: active versus saved provider, local CLI availability, instruction compatibility, reset settings and an expectedState token. Sleep separately first; unavailable or incompatible targets are blocked.',
      inputSchema: { type: 'object', additionalProperties: false,
        properties: { provider: { type: 'string' }, ...(change ? { expectedState: { type: 'string' } } : {}) },
        required: change ? ['provider', 'expectedState'] : ['provider'] },
      handler: async (targetId, callerId, args) => {
        try { return { content: [{ type: 'text', text: JSON.stringify(await dispatcherProviderControl(callerId, targetId, change, args)) }] }; }
        catch (err) { return { content: [{ type: 'text', text: JSON.stringify({ status: 'blocked', code: (err as { code?: string }).code ?? 'provider_control_failed' }) }], isError: true }; }
      },
    });
  }

  // clubhouse__<project>_<name>_<hash>__send_message
  mcpAdapter.registerMcpCommand({
    id: 'agent.sendMessage',
    category: 'agent',
    label: 'Send Message',
    mcp: { targetKind: 'agent', nameSuffix: 'send_message', grant: { actions: ['agent.message'], target: 'bound' } },
    description:
      'Send a message to the linked agent. The message is injected as input to the agent and submitted.\n\n' +
      'IMPORTANT — this is asynchronous. The target agent will process the message on its own timeline ' +
      'and may be in the middle of other work. There is no inline response.\n\n' +
      'Your identity (name and project) is automatically included in the message so the target ' +
      'knows who sent the request. If the connection is bidirectional, reply instructions ' +
      '(including the exact tool name to respond back) are also appended automatically.\n\n' +
      'To get a response:\n' +
      '1. Include a task_id so the target can tag its reply (e.g. "TASK_RESULT:<task_id>: …").\n' +
      '2. If BIDIRECTIONAL: the target agent can send_message back to you directly with the task_id. ' +
      'Reply instructions are included in the message automatically.\n' +
      '3. If UNIDIRECTIONAL: poll read_output and search for your task_id marker. Output may contain ' +
      'unrelated content — filter by the marker. Allow time for the agent to process.\n\n' +
      'Use check_connectivity to determine the link direction if unsure.\n\n' +
      'A sleeping Dispatcher is woken to take the message, if you have permission to wake it.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The message to send to the agent.',
        },
        task_id: {
          type: 'string',
          description:
            'Optional correlation ID. If provided, the message is prefixed with [TASK:<task_id>] ' +
            'so the target agent knows to tag its response with TASK_RESULT:<task_id>. ' +
            'If omitted, one is auto-generated and returned.',
        },
        idempotency_key: {
          type: 'string',
          description: 'For cross-machine delivery: a stable key (up to 200 characters). Retry the exact same content with the same key; task_id is the fallback key. Receipts confirm runtime acceptance, not model execution.',
        },
        force_submit: {
          type: 'boolean',
          description:
            'Whether to send a delayed Enter keystroke after the message to force submission. ' +
            'Defaults to true. Set to false to inject text into the agent\'s input without submitting ' +
            '(useful for building up multi-part inputs).',
        },
      },
      required: ['message'],
    },
    handler: async (targetId, agentId, args): Promise<McpToolResult> => {
      const message = requireString(args, 'message');
      if (!message) {
        return { content: [{ type: 'text', text: 'Missing required argument: message' }], isError: true };
      }

      const taskId = optionalString(args, 'task_id') || `t_${Date.now().toString(36)}`;
      const forceSubmit = args.force_submit !== false; // default true

      const submitNote = forceSubmit ? '' : ' (force_submit=false, message injected without submitting)';
      const sentText = (targetName: string, isBidirectional: boolean, woke = false) => {
        const wokeNote = woke ? ` ${targetName} was asleep and was woken to take it.` : '';
        return isBidirectional
          ? `Message sent to ${targetName}. task_id=${taskId}. ` +
            `Bidirectional — ${targetName} can reply directly via send_message.${wokeNote}${submitNote}`
          : `Message sent to ${targetName}. task_id=${taskId} — ` +
            `poll read_output for TASK_RESULT:${taskId}.${wokeNote}${submitNote}`;
      };
      const remote = currentRemoteCaller();
      const publication = remote?.machineId ? captureControllerPublication(remote.machineId) : undefined;
      const receiverAdmission = () => !!publication?.current() && isDispatcherEnabled() && !!remote && !!federationMessageDirection(
        { agentId: remote.agentId, machineId: remote.machineId }, { agentId: targetId },
      );
      const receiverWake = isDispatcherTarget(targetId) && !!remote && !!federationMessageDirection(
        { agentId: remote.agentId, machineId: remote.machineId }, { agentId: targetId },
      );
      const notReady = remoteInputPreflight(targetId, receiverWake);
      if (notReady) return notReady;

      // The Dispatcher, asleep or awake: a sleeping one is woken to take the message (#3037).
      if (isDispatcherTarget(targetId)) {
        const tagged = buildTaggedMessage(agentId, targetId, message, taskId);
        // The call as the user would approve it, if waking asks first.
        const binding = bindingManager.getBindingsForAgent(agentId).find(b => b.targetId === targetId);
        const toolName = binding ? buildToolName(binding, 'send_message') : 'send_message';
        try {
          const delivery = await deliverToDispatcher({
            senderId: agentId, targetId, targetName: tagged.targetName, text: tagged.text, routed: tagged.routed,
            ...(receiverWake && { wakeAsReceiver: true, admission: receiverAdmission }),
            taskId, submit: forceSubmit, toolName, args,
          });
          if (delivery.delivered === false) {
            const failure = { content: [{ type: 'text' as const, text: delivery.text }], isError: true };
            return receiverWake && !receiverAdmission() ? remoteDelivery(failure, 'refused', 'authorization_revoked') : failure;
          }
          return remoteInputReceipt({ content: [{ type: 'text', text: sentText(tagged.targetName, tagged.isBidirectional, delivery.woke) }] }, delivery.delivery ? { delivery: delivery.delivery } : undefined);
        } catch (err) {
          // telemetry-exempt: logged, and the error reaches the sender as the tool result
          if (isAgentStoppingError(err)) {
            return { content: [{ type: 'text', text: `${tagged.targetName} is shutting down, so the message was not delivered. Try again in a moment.` }], isError: true };
          }
          appLog('core:mcp', 'error', 'Failed to send message to the Dispatcher', {
            meta: { sourceAgent: agentId, targetAgent: targetId, error: err instanceof Error ? err.message : String(err) },
          });
          return { content: [{ type: 'text', text: `Failed to send message: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      }

      const reg = agentRegistry.get(targetId);
      if (!reg) {
        appLog('core:mcp', 'warn', 'send_message: target agent not found in registry', {
          meta: { sourceAgent: agentId, targetAgent: targetId },
        });
        return sleepingError(agentId, targetId, 'sending messages');
      }

      const { text: taggedMessage, routed, senderLabel, targetName, isBidirectional } = buildTaggedMessage(agentId, targetId, message, taskId);

      appLog('core:mcp', 'info', 'send_message: target resolved', {
        meta: { sourceAgent: agentId, targetAgent: targetId, runtime: reg.runtime, taskId, senderLabel, isBidirectional },
      });

      try {
        const runtime = getAgentRuntime(targetId);
        if (!runtime) {
          return { content: [{ type: 'text', text: `Agent runtime "${reg.runtime}" does not support input` }], isError: true };
        }
        appLog('core:mcp', 'info', 'send_message: delivering', {
          meta: { targetAgent: targetId, taskId, runtime: runtime.kind, forceSubmit, messageLength: taggedMessage.length },
        });
        const sent = await runtime.sendMessage(taggedMessage, { source: 'mcp', taskId, submit: forceSubmit, routed });
        noteDispatcherReached(agentId, targetId);

        return remoteInputReceipt({ content: [{ type: 'text', text: sentText(targetName, isBidirectional) }] }, sent);
      } catch (err) {
        if (isAgentStoppingError(err)) {
          appLog('core:mcp', 'info', 'send_message: target is shutting down', { meta: { sourceAgent: agentId, targetAgent: targetId, taskId } });
          return { content: [{ type: 'text', text: `${targetName} is shutting down, so the message was not delivered.` }], isError: true };
        }
        appLog('core:mcp', 'error', 'Failed to send message to agent', {
          meta: { sourceAgent: agentId, targetAgent: targetId, error: err instanceof Error ? err.message : String(err) },
        });
        return { content: [{ type: 'text', text: `Failed to send message: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  });

  // clubhouse__<project>_<name>_<hash>__get_status
  mcpAdapter.registerMcpCommand({
    id: 'agent.getStatus',
    category: 'agent',
    label: 'Get Agent Status',
    mcp: { targetKind: 'agent', nameSuffix: 'get_status', grant: { actions: ['agent.read'], target: 'bound' } },
    description: 'Get the current status of the linked agent.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async (targetId, agentId, _args): Promise<McpToolResult> => {
      const reg = agentRegistry.get(targetId);
      const running = !!reg;

      const status: Record<string, unknown> = {
        status: running ? 'running' : 'sleeping',
        running,
        runtime: reg?.runtime || null,
        message: running
          ? 'Agent is running and available for interaction.'
          // A message wakes a sleeping Dispatcher (#3037).
          : isDispatcherTarget(targetId)
            ? sleepingDispatcherHint(agentId)
            : canCallWake(agentId, targetId)
            ? 'Agent is sleeping. Call its wake_agent tool to start it.'
            : 'Agent is sleeping. Start it from Clubhouse or a group project wake_agent tool.',
      };

      appLog('core:mcp', 'info', 'get_status: resolved', {
        meta: { sourceAgent: agentId, targetAgent: targetId, ...status },
      });

      return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
    },
  });

  // clubhouse__<project>_<name>_<hash>__read_output
  mcpAdapter.registerMcpCommand({
    id: 'agent.readOutput',
    category: 'agent',
    label: 'Read Agent Output',
    mcp: { targetKind: 'agent', nameSuffix: 'read_output', grant: { actions: ['agent.read'], target: 'bound' } },
    description:
        'Read recent output from the linked agent.\n\n' +
        'Use this to poll for responses after send_message. The output is a raw terminal buffer ' +
        'and will contain ALL agent output — tool calls, reasoning, status messages, and any replies.\n\n' +
        'To find a specific response, search the output for the TASK_RESULT:<task_id> marker you ' +
        'requested in your send_message. The agent may not have responded yet — if you don\'t see ' +
        'the marker, wait and poll again. Typical response times range from seconds to minutes ' +
        'depending on task complexity.\n\n' +
        'Tip: start with fewer lines (50) and increase if needed. The buffer is circular so very ' +
        'old output may have been evicted.',
    inputSchema: {
      type: 'object',
      properties: {
        lines: {
          type: 'number',
          description: 'Number of lines to read (default 50, max 500).',
        },
      },
    },
    handler: async (targetId, agentId, args): Promise<McpToolResult> => {
      const reg = agentRegistry.get(targetId);
      if (!reg) {
        appLog('core:mcp', 'warn', 'read_output: target agent not found in registry', {
          meta: { sourceAgent: agentId, targetAgent: targetId },
        });
        return sleepingError(agentId, targetId, 'reading output');
      }

      let lines = numberWithDefault(args, 'lines', 50);
      lines = Math.min(lines, 500);

      try {
        const runtime = getAgentRuntime(targetId);
        if (!runtime) {
          return { content: [{ type: 'text', text: `Output reading not supported for runtime "${reg.runtime}"` }], isError: true };
        }
        const slice = await runtime.readTranscript({ tail: runtime.kind === 'chat' ? lines * 4 : lines });
        const text = slice.text ?? chatEventsToText(slice.events ?? [], lines);
        if (!text) {
          return { content: [{ type: 'text', text: 'No output available' }] };
        }
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Failed to read output: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  });

  // clubhouse__<project>_<name>_<hash>__check_connectivity
  mcpAdapter.registerMcpCommand({
    id: 'agent.checkConnectivity',
    category: 'agent',
    label: 'Check Connectivity',
    mcp: { targetKind: 'agent', nameSuffix: 'check_connectivity', grant: { actions: ['agent.read'], target: 'bound' } },
    description:
        'Check whether communication with the linked agent is bidirectional or unidirectional.\n\n' +
        'Returns a JSON object with:\n' +
        '- direction: "bidirectional" or "unidirectional"\n' +
        '- guidance: how to handle responses based on the direction\n\n' +
        'BIDIRECTIONAL means the target agent also has a link back to you and can call send_message ' +
        'to deliver responses directly into your input. You can include a task_id and the target ' +
        'will send back a message tagged with TASK_RESULT:<task_id>.\n\n' +
        'UNIDIRECTIONAL means the target agent cannot send messages back to you. You must poll ' +
        'read_output to find responses. Always include a task_id in your send_message and instruct ' +
        'the target to output "TASK_RESULT:<task_id>: <response>" so you can locate it in the ' +
        'output buffer. The buffer contains all terminal output so filter carefully by the marker.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async (targetId, agentId, _args): Promise<McpToolResult> => {
      const reg = agentRegistry.get(targetId);
      if (!reg) {
        return sleepingError(agentId, targetId, 'checking connectivity');
      }

      // Check if the target has a binding back to the caller
      const reverseBindings = bindingManager.getBindingsForAgent(targetId);
      const reverseBinding = reverseBindings.find(b => b.targetId === agentId);
      const hasBidirectional = !!reverseBinding;

      const direction = hasBidirectional ? 'bidirectional' : 'unidirectional';

      let replyToolName: string | undefined;
      if (hasBidirectional && reverseBinding) {
        replyToolName = buildToolName(reverseBinding, 'send_message');
      }

      const guidance = hasBidirectional
        ? `The target agent can send messages back to you directly via send_message. ` +
          `Include a task_id in your message and the target can respond with a message tagged ` +
          `TASK_RESULT:<task_id>. You may also poll read_output as a fallback.` +
          (replyToolName ? ` The target should use tool "${replyToolName}" to reply.` : '')
        : 'The target agent CANNOT send messages back to you. You must poll read_output to find responses. ' +
          'Always include a task_id and instruct the target to print "TASK_RESULT:<task_id>: <answer>" ' +
          'in its output. Poll read_output periodically and search for your task_id marker. ' +
          'Allow time — the agent may be busy with other work. Output may contain unrelated content.';

      appLog('core:mcp', 'info', 'check_connectivity: resolved', {
        meta: { sourceAgent: agentId, targetAgent: targetId, direction },
      });

      const result: Record<string, unknown> = { direction, target: targetId, guidance };
      if (replyToolName) {
        result.replyTool = replyToolName;
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  });

  // clubhouse__<project>_<name>_<hash>__send_file
  mcpAdapter.registerMcpCommand({
    id: 'agent.sendFile',
    category: 'agent',
    label: 'Send File',
    mcp: { targetKind: 'agent', nameSuffix: 'send_file', grant: { actions: ['agent.message'], target: 'bound' } },
    description:
        'Send a message to the linked agent via a temp file.\n\n' +
        'The message content is written to a temporary file on disk and the agent receives a ' +
        'single-line notification with the file path. The target agent reads the file with its ' +
        'normal file-reading tool.\n\n' +
        'Use this instead of send_message when:\n' +
        '- The message is very long or has complex formatting\n' +
        '- send_message paste injection is unreliable for the target CLI\n' +
        '- You want to send structured data (JSON, code, etc.) without terminal mangling\n\n' +
        'The temp file is automatically cleaned up after 5 minutes.',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The content to write to the file and deliver to the agent.',
        },
        task_id: {
          type: 'string',
          description:
            'Optional correlation ID. Works the same as send_message task_id.',
        },
        idempotency_key: {
          type: 'string',
          description: 'For cross-machine delivery: a stable key (up to 200 characters). Retry only the same content with the same key; task_id is the fallback key.',
        },
        filename: {
          type: 'string',
          description:
            'Optional filename hint (e.g. "plan.md", "data.json"). ' +
            'Kept in delivery metadata; Clubhouse generates the private storage name.',
        },
      },
      required: ['content'],
    },
    handler: async (targetId, agentId, args): Promise<McpToolResult> => {
      const content = requireString(args, 'content');
      if (!content) {
        return { content: [{ type: 'text', text: 'Missing required argument: content' }], isError: true };
      }

      const taskId = optionalString(args, 'task_id') || `t_${Date.now().toString(36)}`;
      const rawFilename = optionalString(args, 'filename') || 'message.md';
      const filename = path.basename(rawFilename);

      const reg = agentRegistry.get(targetId);
      const remote = currentRemoteCaller();
      const publication = remote?.machineId ? captureControllerPublication(remote.machineId) : undefined;
      const receiverAdmission = () => !!publication?.current() && isDispatcherEnabled() && !!remote && !!federationMessageDirection(
        { agentId: remote.agentId, machineId: remote.machineId }, { agentId: targetId });
      const receiverWake = isDispatcherTarget(targetId) && !!remote && receiverAdmission();
      if (!reg && !isDispatcherTarget(targetId)) {
        return sleepingError(agentId, targetId, 'sending files');
      }
      const notReady = remoteInputPreflight(targetId, receiverWake);
      if (notReady) return notReady;

      const { senderName, senderLabel, targetName } = senderOf(agentId, targetId);

      try {
        const filePath = await writeMessageFile(taskId, content);
        scheduleMessageCleanup(filePath);

        if (isDispatcherTarget(targetId)) {
          const tagged = buildTaggedMessage(agentId, targetId, `File delivered: ${filePath}. Filename hint: ${JSON.stringify(filename)}. Read this file for content from ${senderLabel}.`, taskId);
          const delivery = await deliverToDispatcher({ senderId: agentId, targetId, targetName, text: tagged.text, routed: tagged.routed,
            taskId, submit: true, toolName: 'send_file', args, ...(receiverWake && { wakeAsReceiver: true, admission: receiverAdmission }) });
          if (delivery.delivered === false) return remoteDelivery({ content: [{ type: 'text', text: delivery.text }], isError: true },
            receiverWake && !receiverAdmission() ? 'refused' : 'retry_later', receiverWake && !receiverAdmission() ? 'authorization_revoked' : 'target_not_ready');
          return remoteInputReceipt({ content: [{ type: 'text', text: `File delivered to ${targetName}. task_id=${taskId}, path=${filePath}` }] }, delivery.delivery ? { delivery: delivery.delivery } : undefined);
        }
        if (!reg) return sleepingError(agentId, targetId, 'sending files');

        appLog('core:mcp', 'info', 'send_file: file written', {
          meta: { sourceAgent: agentId, targetAgent: targetId, taskId, filePath, contentLength: content.length },
        });

        const runtime = getAgentRuntime(targetId);
        if (!runtime) {
          return { content: [{ type: 'text', text: `Agent runtime "${reg.runtime}" does not support input` }], isError: true };
        }
        const notice = `[TASK:${taskId}] [FROM:${senderLabel}] File delivered: ${filePath}. Filename hint: ${JSON.stringify(filename)}. Read this file for content from ${senderLabel}.`;
        let sent: RuntimeSendResult | undefined;
        if (runtime.kind === 'pty') {
          // Terminals keep the single fixed-delay Enter this tool has always sent.
          const timing = getProvider(reg.orchestrator)?.getPasteSubmitTiming() ?? DEFAULT_PASTE_TIMING;
          await writeLineThenEnter(targetId, notice, timing.initialDelayMs);
        } else {
          sent = await runtime.sendMessage(notice, {
            source: 'mcp', taskId,
            routed: [{ sender: { agentId, name: senderName }, text: `File delivered: ${filePath}` }],
          });
        }

        return remoteInputReceipt({
          content: [{
            type: 'text',
            text: `File delivered to ${targetName}. task_id=${taskId}, path=${filePath}`,
          }],
        }, sent);
      } catch (err) {
        if (isAgentStoppingError(err)) {
          appLog('core:mcp', 'info', 'send_file: target is shutting down', { meta: { sourceAgent: agentId, targetAgent: targetId, taskId } });
          return { content: [{ type: 'text', text: `${targetName} is shutting down, so the file notice was not delivered.` }], isError: true };
        }
        appLog('core:mcp', 'error', 'send_file failed', {
          meta: { sourceAgent: agentId, targetAgent: targetId, error: err instanceof Error ? err.message : String(err) },
        });
        return { content: [{ type: 'text', text: `Failed to send file: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  });

  // clubhouse__<project>_<name>_<hash>__clear_agent
  mcpAdapter.registerMcpCommand({
    id: 'agent.clearAgent',
    category: 'agent',
    label: 'Clear Agent Context',
    mcp: { targetKind: 'agent', nameSuffix: 'clear_agent', grant: { actions: ['agent.reset'], target: 'bound' } },
    description:
        'Send a /clear command to the linked agent, clearing its conversation context.\n\n' +
        'Injects /clear directly into the agent\'s CLI. Use this when the agent\'s context ' +
        'is bloated or stale and a fresh slate would improve its performance.\n\n' +
        'The agent must be running. Use get_status to check first.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async (targetId, agentId, _args): Promise<McpToolResult> => {
      const reg = agentRegistry.get(targetId);
      if (!reg) {
        return sleepingError(agentId, targetId, 'clearing context');
      }

      try {
        const runtime = getAgentRuntime(targetId);
        if (!runtime) {
          return { content: [{ type: 'text', text: `Agent runtime "${reg.runtime}" does not support /clear` }], isError: true };
        }
        await runtime.clearContext();

        appLog('core:mcp', 'info', 'clear_agent: /clear sent', { meta: { sourceAgent: agentId, targetAgent: targetId } });
        return { content: [{ type: 'text', text: `Sent /clear to agent ${targetId}.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Failed to send /clear: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  });

  // clubhouse__<project>_<name>_<hash>__compact_agent
  mcpAdapter.registerMcpCommand({
    id: 'agent.compactAgent',
    category: 'agent',
    label: 'Compact Agent Context',
    mcp: { targetKind: 'agent', nameSuffix: 'compact_agent', grant: { actions: ['agent.reset'], target: 'bound' } },
    description:
        'Send a /compact command to the linked agent, compacting its conversation context.\n\n' +
        'Injects /compact directly into the agent\'s CLI. Use this when the agent\'s context ' +
        'is large and you want it summarized without losing continuity.\n\n' +
        'The agent must be running. Use get_status to check first.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async (targetId, agentId, _args): Promise<McpToolResult> => {
      const reg = agentRegistry.get(targetId);
      if (!reg) {
        return sleepingError(agentId, targetId, 'compacting context');
      }

      try {
        const runtime = getAgentRuntime(targetId);
        if (!runtime) {
          return { content: [{ type: 'text', text: `Agent runtime "${reg.runtime}" does not support /compact` }], isError: true };
        }
        await runtime.compact();

        appLog('core:mcp', 'info', 'compact_agent: /compact sent', { meta: { sourceAgent: agentId, targetAgent: targetId } });
        return { content: [{ type: 'text', text: `Sent /compact to agent ${targetId}.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Failed to send /compact: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  });

  // clubhouse__<project>_<name>_<hash>__wake_agent
  mcpAdapter.registerMcpCommand({
    id: 'agent.wakeAgent',
    category: 'agent',
    label: 'Wake Agent',
    mcp: { targetKind: 'agent', nameSuffix: 'wake_agent', grant: [{ actions: ['agent.wake'], target: 'bound' }, { actions: ['agent.message'], target: 'bound', ifArgs: ['message'] }] },
    description:
      'Wake the linked agent if it is sleeping. It resumes its last session when it has one, at its own access level.\n\n' +
      'An optional message is delivered as its first prompt, tagged like send_message, so include what to do and why. ' +
      'The result says whether it is running, already_running, starting or still stopping, and, ' +
      'when you sent a message, messageDelivered.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Optional first prompt for the agent.',
        },
      },
    },
    handler: async (targetId, agentId, args): Promise<McpToolResult> => {
      const message = optionalString(args, 'message');
      const targetName = senderOf(agentId, targetId).targetName;
      const taskId = `t_${Date.now().toString(36)}`;
      const tagged = message ? buildTaggedMessage(agentId, targetId, message, taskId) : undefined;
      const result = await wakeWiredAgent({ callerId: agentId, targetId, targetName, mission: tagged?.text, missionRouted: tagged?.routed });
      if (tagged && !result.isError) noteDispatcherReached(agentId, targetId);
      return result;
    },
  });

  // clubhouse__<project>_<name>_<hash>__sleep_agent
  mcpAdapter.registerMcpCommand({
    id: 'agent.sleepAgent',
    category: 'agent',
    label: 'Sleep Agent',
    mcp: { targetKind: 'agent', nameSuffix: 'sleep_agent', group: 'dispatcher', grant: { actions: ['agent.sleep'], target: 'bound' } },
    description:
      'Put the linked agent to sleep. Returns once it has stopped, or already_sleeping if it was. Its session stays; wake_agent resumes it.\n\n' +
      'Without force, this refuses a chat agent that is mid-turn and any agent in the CLI view, whose turn state is unknown. ' +
      'Only use force when losing the turn in progress is fine, and ask the user if you are not sure. ' +
      'Running helpers of the agent are listed in the result; they keep running.',
    inputSchema: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          description: 'Stop it even if it is mid-turn or its turn state is unknown. The turn in progress is lost. Defaults to false.',
        },
      },
    },
    handler: async (targetId, agentId, args): Promise<McpToolResult> => {
      const targetName = senderOf(agentId, targetId).targetName;
      return sleepAgent({ callerId: agentId, targetId, targetName, force: args.force === true });
    },
  });

  registerGlobalTool(
    'call_wire_tool',
    {
      description:
        'Call a tool of one of your wires by the id of what it connects to. Your CLI reads its tool list once, ' +
        'when your session starts, so a wire added later (a helper you started, a newly connected agent) ' +
        'has no tools of its own in your list. The next session lists them. A wrong target lists your wires.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'The id on the other end of the wire, such as an agent id or helper id.' },
          tool: { type: 'string', description: 'The tool to call, without its prefix: send_message, read_output, get_status and so on.' },
          arguments: { type: 'object', description: 'The tool\'s arguments.' },
        },
        required: ['target', 'tool'],
      },
    },
    async (agentId, args): Promise<McpToolResult> => {
      const bindings = bindingManager.getBindingsForAgent(agentId);
      const binding = bindings.find((b) => b.targetId === args.target);
      if (!binding) {
        const wires = bindings.map((b) => `${isDispatcherAgentId(b.targetId) ? DISPATCHER_CONTROLLER_NAME : b.targetName || b.label} (${b.targetId})`).join(', ') || 'none';
        return { content: [{ type: 'text', text: `You have no wire to ${String(args.target)}. Your wires: ${wires}.` }], isError: true };
      }
      return callTool(agentId, buildToolName(binding, String(args.tool)), (args.arguments as Record<string, unknown>) ?? {});
    },
    // Checked as the wire tool it calls: callTool runs again with that tool.
    { group: 'fixedToolList', grant: 'called_tool' },
  );
}
