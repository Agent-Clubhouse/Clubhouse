/**
 * Agent-to-Agent MCP Tools — allows linked agents to communicate.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import { buildToolName } from '../tool-registry';
import { mcpAdapter } from '../mcp-adapter';
import { bindingManager } from '../binding-manager';
import { agentRegistry } from '../../agent-registry';
import * as ptyManager from '../../pty-manager';
import * as structuredManager from '../../structured-manager';
import * as agentSystem from '../../agent-system';
import { getDurableConfig } from '../../agent-config';
import type { McpToolResult } from '../types';
import { appLog } from '../../log-service';
import { broadcastToAllWindows } from '../../../util/ipc-broadcast';
import { IPC } from '../../../../shared/ipc-channels';
import { getProvider } from '../../../orchestrators';
import type { PasteSubmitTiming } from '../../../orchestrators';
import { requireString, optionalString, numberWithDefault } from './validation';

// ── Chunked bracketed paste ─────────────────────────────────────────────────

/** Sleep helper for async delays. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Write multi-line content to a PTY using chunked bracketed paste.
 *
 * Sends the bracketed paste start marker, then the body (optionally in
 * chunks with delays between them), then the end marker.
 *
 * Small delays are ALWAYS inserted after the start marker and before the
 * end marker to prevent race conditions where the CLI hasn't entered or
 * exited paste mode before content/markers arrive.  This applies to all
 * providers, not just slow CLIs.
 *
 * When chunkSize is set and the body exceeds it, the body is split into
 * chunks with `chunkDelayMs` between each write.
 *
 * A dedicated `postEndMarkerDelayMs` is inserted AFTER the end marker to
 * give the CLI time to exit paste mode before any subsequent writes (like
 * an Enter keystroke).  Without this, `\r` can be folded into the paste.
 */
export async function writeChunkedBracketedPaste(
  agentId: string,
  body: string,
  chunkSize?: number,
  chunkDelayMs = 30,
  postEndMarkerDelayMs = 150,
): Promise<void> {
  ptyManager.write(agentId, '\x1b[200~');

  // Always delay after start marker so the CLI can enter paste mode
  await sleep(chunkDelayMs);

  if (!chunkSize || body.length <= chunkSize) {
    ptyManager.write(agentId, body);
  } else {
    for (let offset = 0; offset < body.length; offset += chunkSize) {
      if (offset > 0) await sleep(chunkDelayMs);
      ptyManager.write(agentId, body.slice(offset, offset + chunkSize));
    }
  }

  // Always delay before end marker so the last write is fully processed
  await sleep(chunkDelayMs);

  ptyManager.write(agentId, '\x1b[201~');

  // Delay AFTER end marker so the CLI can exit paste mode before \r arrives
  await sleep(postEndMarkerDelayMs);
}

/**
 * Wait until the agent's PTY buffer length is unchanged for `quiescenceMs`,
 * or until `maxWaitMs` elapses (whichever comes first).
 *
 * Used to detect when a TUI like GitHub Copilot CLI has finished rendering
 * its paste-preview UI before sending the submit Enter.  GHCP's preview
 * render time varies with network latency; a fixed sleep races against it,
 * causing the `\r` to be folded into the bracketed paste and swallowed.
 *
 * Returns `quiet: true` if the buffer settled, `quiet: false` if maxWait
 * fired first.  Either way the caller should proceed — quiet:false just
 * means we gave up waiting and will fall back to the existing retry logic.
 */
export async function waitForBufferQuiescence(
  agentId: string,
  options: { quiescenceMs: number; maxWaitMs: number; pollMs?: number },
): Promise<{ quiet: boolean; waitedMs: number }> {
  const pollMs = options.pollMs ?? 50;
  const startTs = Date.now();
  let lastLen = ptyManager.getBuffer(agentId)?.length ?? 0;
  let lastChangeTs = startTs;

  while (Date.now() - startTs < options.maxWaitMs) {
    await sleep(pollMs);
    const cur = ptyManager.getBuffer(agentId)?.length ?? 0;
    if (cur !== lastLen) {
      lastLen = cur;
      lastChangeTs = Date.now();
    } else if (Date.now() - lastChangeTs >= options.quiescenceMs) {
      return { quiet: true, waitedMs: Date.now() - startTs };
    }
  }
  return { quiet: false, waitedMs: Date.now() - startTs };
}

/**
 * Submit content that was just pasted into an agent's PTY.
 *
 * Sends `\r` (Enter) with provider-specific delays and buffer health checks.
 * If the first Enter doesn't trigger processing (buffer doesn't grow), a
 * second Enter is sent as a retry — some CLIs show a paste preview that
 * requires Enter to accept before another Enter actually submits.
 *
 * When `timing.quiescenceMs` is set, the fixed `initialDelayMs` and
 * `retryDelayMs` sleeps are replaced with quiescence waits capped at those
 * values.  This addresses GitHub Copilot CLI's variable paste-preview
 * render time — a fixed 1200ms delay races against network jitter and
 * causes the `\r` to be folded into the paste payload (then ignored).
 */
export async function submitAfterPaste(
  agentId: string,
  timing: PasteSubmitTiming,
): Promise<void> {
  const bufferBefore = ptyManager.getBuffer(agentId)?.length ?? 0;

  if (timing.quiescenceMs) {
    await waitForBufferQuiescence(agentId, {
      quiescenceMs: timing.quiescenceMs,
      maxWaitMs: timing.initialDelayMs,
      pollMs: timing.quiescencePollMs,
    });
  } else {
    await sleep(timing.initialDelayMs);
  }
  ptyManager.write(agentId, '\r');

  if (timing.quiescenceMs) {
    await waitForBufferQuiescence(agentId, {
      quiescenceMs: timing.quiescenceMs,
      maxWaitMs: timing.retryDelayMs,
      pollMs: timing.quiescencePollMs,
    });
  } else {
    await sleep(timing.retryDelayMs);
  }
  const bufferAfterFirst = ptyManager.getBuffer(agentId)?.length ?? 0;
  if (bufferAfterFirst > bufferBefore) return; // First Enter worked

  // Second Enter — submit the message
  ptyManager.write(agentId, '\r');
  await sleep(timing.finalCheckDelayMs);
}

// ── File-backed message helpers ─────────────────────────────────────────────

const A2A_MSG_DIR = path.join(app.getPath('temp'), 'clubhouse-a2a-messages');

async function ensureMsgDir(): Promise<void> {
  await fsp.mkdir(A2A_MSG_DIR, { recursive: true });
}

/** Write content to a temp file, return its path. */
export async function writeMessageFile(taskId: string, content: string): Promise<string> {
  await ensureMsgDir();
  const filePath = path.join(A2A_MSG_DIR, `${taskId}.md`);
  await fsp.writeFile(filePath, content, 'utf-8');
  return filePath;
}

/** Schedule cleanup of a message file after a delay (default 5 min). */
export function scheduleMessageCleanup(filePath: string, delayMs = 5 * 60 * 1000): void {
  setTimeout(async () => {
    try { await fsp.unlink(filePath); } catch { /* already gone */ }
  }, delayMs);
}

/** Register all agent-to-agent tool templates. */
export function registerAgentTools(): void {
  // clubhouse__<project>_<name>_<hash>__send_message
  mcpAdapter.registerMcpCommand({
    id: 'agent.sendMessage',
    category: 'agent',
    label: 'Send Message',
    mcp: { targetKind: 'agent', nameSuffix: 'send_message' },
    description:
      'Send a message to the linked agent. The message is injected as terminal input and submitted.\n\n' +
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
      'Use check_connectivity to determine the link direction if unsure.',
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
        force_submit: {
          type: 'boolean',
          description:
            'Whether to send a delayed Enter keystroke after the message to force submission. ' +
            'Defaults to true. Set to false to inject text into the terminal without submitting ' +
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

      const reg = agentRegistry.get(targetId);
      if (!reg) {
        appLog('core:mcp', 'warn', 'send_message: target agent not found in registry', {
          meta: { sourceAgent: agentId, targetAgent: targetId },
        });
        return { content: [{ type: 'text', text: `Agent ${targetId} is sleeping. Use the wake tool to start it first.` }], isError: true };
      }

      // Resolve sender identity from the binding
      const sourceBinding = bindingManager.getBindingsForAgent(agentId).find(b => b.targetId === targetId);
      const senderName = sourceBinding?.agentName || agentId;
      const senderProject = sourceBinding?.projectName;
      const senderLabel = senderProject ? `${senderName}@${senderProject}` : senderName;
      const targetName = sourceBinding?.targetName || targetId;

      // Check if the target has a reverse binding back to the caller
      const reverseBindings = bindingManager.getBindingsForAgent(targetId);
      const reverseBinding = reverseBindings.find(b => b.targetId === agentId);
      const isBidirectional = !!reverseBinding;

      appLog('core:mcp', 'info', 'send_message: target resolved', {
        meta: { sourceAgent: agentId, targetAgent: targetId, runtime: reg.runtime, taskId, senderLabel, isBidirectional },
      });

      // Build the tagged message with sender identification
      let taggedMessage = `[TASK:${taskId}] [FROM:${senderLabel}] ${message}`;

      // If bidirectional, append reply instructions so the target knows how to respond
      if (isBidirectional && reverseBinding) {
        const replyToolName = buildToolName(reverseBinding, 'send_message');
        taggedMessage += `\n\n---\nReply to ${senderName} via tool "${replyToolName}" with task_id="${taskId}". ` +
          `Prefix your response with TASK_RESULT:${taskId}.`;
      }

      try {
        if (reg.runtime === 'pty') {
          const isMultiLine = taggedMessage.includes('\n');

          appLog('core:mcp', 'info', 'send_message: writing to PTY', {
            meta: { targetAgent: targetId, taskId, isMultiLine, forceSubmit, messageLength: taggedMessage.length },
          });

          // Resolve provider-specific paste submit timing up front.
          const provider = getProvider(reg.orchestrator);
          const timing: PasteSubmitTiming = provider?.getPasteSubmitTiming()
            ?? { initialDelayMs: 500, retryDelayMs: 300, finalCheckDelayMs: 250, chunkSize: 512, chunkDelayMs: 50, postEndMarkerDelayMs: 150 };

          if (isMultiLine) {
            // Chunked bracketed paste: send start marker, body in chunks
            // with delays, then end marker.  Slow CLIs (GHCP) need this
            // to avoid mangling or truncating multi-line paste content.
            await writeChunkedBracketedPaste(
              targetId,
              taggedMessage,
              timing.chunkSize,
              timing.chunkDelayMs,
              timing.postEndMarkerDelayMs,
            );
          } else {
            ptyManager.write(targetId, taggedMessage);
          }

          if (forceSubmit) {
            appLog('core:mcp', 'info', 'send_message: using paste submit timing', {
              meta: { targetAgent: targetId, taskId, orchestrator: reg.orchestrator, timing },
            });

            await submitAfterPaste(targetId, timing);
          }
        } else if (reg.runtime === 'structured') {
          await structuredManager.sendMessage(targetId, taggedMessage);
        } else {
          return { content: [{ type: 'text', text: `Agent runtime "${reg.runtime}" does not support input` }], isError: true };
        }

        const submitNote = forceSubmit ? '' : ' (force_submit=false, message injected without submitting)';
        const resultText = isBidirectional
          ? `Message sent to ${targetName}. task_id=${taskId}. ` +
            `Bidirectional — ${targetName} can reply directly via send_message.${submitNote}`
          : `Message sent to ${targetName}. task_id=${taskId} — ` +
            `poll read_output for TASK_RESULT:${taskId}.${submitNote}`;

        return { content: [{ type: 'text', text: resultText }] };
      } catch (err) {
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
    mcp: { targetKind: 'agent', nameSuffix: 'get_status' },
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
          : 'Agent is sleeping. Use the wake tool to start it.',
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
    mcp: { targetKind: 'agent', nameSuffix: 'read_output' },
    description:
        'Read recent terminal output from the linked agent.\n\n' +
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
        return { content: [{ type: 'text', text: `Agent ${targetId} is sleeping. Use the wake tool to start it first.` }], isError: true };
      }

      let lines = numberWithDefault(args, 'lines', 50);
      lines = Math.min(lines, 500);

      try {
        if (reg.runtime === 'pty') {
          const buffer = ptyManager.getBuffer(targetId);
          if (!buffer) {
            return { content: [{ type: 'text', text: 'No output available' }] };
          }
          // Take last N lines
          const allLines = buffer.split('\n');
          const lastLines = allLines.slice(-lines).join('\n');
          return { content: [{ type: 'text', text: lastLines }] };
        } else {
          return { content: [{ type: 'text', text: `Output reading not supported for runtime "${reg.runtime}"` }], isError: true };
        }
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
    mcp: { targetKind: 'agent', nameSuffix: 'check_connectivity' },
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
        return { content: [{ type: 'text', text: `Agent ${targetId} is sleeping. Use the wake tool to start it first.` }], isError: true };
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
    mcp: { targetKind: 'agent', nameSuffix: 'send_file' },
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
        filename: {
          type: 'string',
          description:
            'Optional filename hint (e.g. "plan.md", "data.json"). ' +
            'Defaults to <task_id>.md.',
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
      const rawFilename = optionalString(args, 'filename') || `${taskId}.md`;
      const filename = path.basename(rawFilename);

      const reg = agentRegistry.get(targetId);
      if (!reg) {
        return { content: [{ type: 'text', text: `Agent ${targetId} is sleeping. Use the wake tool to start it first.` }], isError: true };
      }

      const sourceBinding = bindingManager.getBindingsForAgent(agentId).find(b => b.targetId === targetId);
      const senderName = sourceBinding?.agentName || agentId;
      const senderProject = sourceBinding?.projectName;
      const senderLabel = senderProject ? `${senderName}@${senderProject}` : senderName;
      const targetName = sourceBinding?.targetName || targetId;

      try {
        // Write content to temp file
        await ensureMsgDir();
        const filePath = path.join(A2A_MSG_DIR, `${taskId}-${filename}`);
        await fsp.writeFile(filePath, content, 'utf-8');
        scheduleMessageCleanup(filePath);

        appLog('core:mcp', 'info', 'send_file: file written', {
          meta: { sourceAgent: agentId, targetAgent: targetId, taskId, filePath, contentLength: content.length },
        });

        if (reg.runtime === 'pty') {
          // Send single-line notification to PTY
          const ptyLine = `[TASK:${taskId}] [FROM:${senderLabel}] File delivered: ${filePath} — read this file for content from ${senderLabel}.`;
          ptyManager.write(targetId, ptyLine);

          // Submit with Enter
          const provider = getProvider(reg.orchestrator);
          const timing = provider?.getPasteSubmitTiming()
            ?? { initialDelayMs: 500, retryDelayMs: 300, finalCheckDelayMs: 250, chunkSize: 512, chunkDelayMs: 50, postEndMarkerDelayMs: 150 };

          await sleep(timing.initialDelayMs);
          ptyManager.write(targetId, '\r');
        } else if (reg.runtime === 'structured') {
          await structuredManager.sendMessage(
            targetId,
            `[TASK:${taskId}] [FROM:${senderLabel}] File delivered: ${filePath} — read this file for content from ${senderLabel}.`,
          );
        } else {
          return { content: [{ type: 'text', text: `Agent runtime "${reg.runtime}" does not support input` }], isError: true };
        }

        return {
          content: [{
            type: 'text',
            text: `File delivered to ${targetName}. task_id=${taskId}, path=${filePath}`,
          }],
        };
      } catch (err) {
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
    mcp: { targetKind: 'agent', nameSuffix: 'clear_agent' },
    description:
        'Send a /clear command to the linked agent, clearing its conversation context.\n\n' +
        'Injects /clear directly into the agent\'s terminal. Use this when the agent\'s context ' +
        'is bloated or stale and a fresh slate would improve its performance.\n\n' +
        'The agent must be running. Use get_status to check first.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async (targetId, agentId, _args): Promise<McpToolResult> => {
      const reg = agentRegistry.get(targetId);
      if (!reg) {
        return { content: [{ type: 'text', text: `Agent ${targetId} is sleeping. Use the wake tool to start it first.` }], isError: true };
      }

      try {
        if (reg.runtime === 'pty') {
          ptyManager.write(targetId, '/clear');
          ptyManager.write(targetId, '\r');
        } else {
          return { content: [{ type: 'text', text: `Agent runtime "${reg.runtime}" does not support /clear` }], isError: true };
        }

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
    mcp: { targetKind: 'agent', nameSuffix: 'compact_agent' },
    description:
        'Send a /compact command to the linked agent, compacting its conversation context.\n\n' +
        'Injects /compact directly into the agent\'s terminal. Use this when the agent\'s context ' +
        'is large and you want it summarized without losing continuity.\n\n' +
        'The agent must be running. Use get_status to check first.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async (targetId, agentId, _args): Promise<McpToolResult> => {
      const reg = agentRegistry.get(targetId);
      if (!reg) {
        return { content: [{ type: 'text', text: `Agent ${targetId} is sleeping. Use the wake tool to start it first.` }], isError: true };
      }

      try {
        if (reg.runtime === 'pty') {
          ptyManager.write(targetId, '/compact');
          ptyManager.write(targetId, '\r');
        } else {
          return { content: [{ type: 'text', text: `Agent runtime "${reg.runtime}" does not support /compact` }], isError: true };
        }

        appLog('core:mcp', 'info', 'compact_agent: /compact sent', { meta: { sourceAgent: agentId, targetAgent: targetId } });
        return { content: [{ type: 'text', text: `Sent /compact to agent ${targetId}.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Failed to send /compact: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  });

  // clubhouse__<project>_<name>_<hash>__wake
  mcpAdapter.registerMcpCommand({
    id: 'agent.wake',
    category: 'agent',
    label: 'Wake Agent',
    mcp: { targetKind: 'agent', nameSuffix: 'wake' },
    description:
        'Wake up a sleeping agent by spawning it in its PTY.\n\n' +
        'Use this when the linked agent is not running (sleeping) and you need it to be alive ' +
        'to send it messages or collaborate. This uses the same mechanism as the "Wake Up" button ' +
        'in the Clubhouse UI — it reads the agent\'s durable config and spawns a fresh session.\n\n' +
        'If the agent is already running, this returns immediately without re-spawning.\n\n' +
        'Set resume=true to resume the agent\'s previous CLI session instead of starting fresh.',
    inputSchema: {
      type: 'object',
      properties: {
        resume: {
          type: 'boolean',
          description:
            'Whether to resume the agent\'s previous CLI session. ' +
            'Defaults to false (fresh session).',
        },
      },
    },
    handler: async (targetId, agentId, args): Promise<McpToolResult> => {
      const resume = args.resume === true;

      // If already running, nothing to do
      const reg = agentRegistry.get(targetId);
      if (reg) {
        appLog('core:mcp', 'info', 'wake: agent already running', {
          meta: { sourceAgent: agentId, targetAgent: targetId, runtime: reg.runtime },
        });
        return { content: [{ type: 'text', text: `Agent is already running (runtime=${reg.runtime}).` }] };
      }

      // Look up the calling agent's project path to find the durable config
      const callerReg = agentRegistry.get(agentId);
      if (!callerReg) {
        return { content: [{ type: 'text', text: 'Cannot determine project path — caller agent not registered' }], isError: true };
      }

      const projectPath = callerReg.projectPath;

      appLog('core:mcp', 'info', 'wake: looking up durable config', {
        meta: { sourceAgent: agentId, targetAgent: targetId, projectPath, resume },
      });

      try {
        const config = await getDurableConfig(projectPath, targetId);
        if (!config) {
          return {
            content: [{ type: 'text', text: `No durable agent config found for ${targetId} in project. The agent may be a quick agent or from a different project.` }],
            isError: true,
          };
        }

        const cwd = config.worktreePath || projectPath;

        // Broadcast waking status to renderer before spawning
        broadcastToAllWindows(IPC.AGENT.AGENT_WAKING, targetId);

        await agentSystem.spawnAgent({
          agentId: targetId,
          projectPath,
          cwd,
          kind: 'durable',
          model: config.model,
          orchestrator: config.orchestrator,
          freeAgentMode: config.freeAgentMode,
          resume,
          sessionId: resume ? config.lastSessionId : undefined,
        });

        appLog('core:mcp', 'info', 'wake: agent spawned successfully', {
          meta: { sourceAgent: agentId, targetAgent: targetId, resume, cwd },
        });

        return {
          content: [{
            type: 'text',
            text: `Agent ${config.name || targetId} is waking up. New tools and interactions will be available in a few seconds.`,
          }],
        };
      } catch (err) {
        appLog('core:mcp', 'error', 'wake: failed to spawn agent', {
          meta: { sourceAgent: agentId, targetAgent: targetId, error: err instanceof Error ? err.message : String(err) },
        });
        return {
          content: [{
            type: 'text',
            text: `Failed to wake agent: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    },
  });
}
