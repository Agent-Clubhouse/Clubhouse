/**
 * Agent-to-Agent MCP Tools — allows linked agents to communicate.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import { registerToolTemplate, buildToolName } from '../tool-registry';
import { bindingManager } from '../binding-manager';
import { agentRegistry } from '../../agent-registry';
import * as ptyManager from '../../pty-manager';
import * as structuredManager from '../../structured-manager';
import type { McpToolResult } from '../types';
import { appLog } from '../../log-service';
import { getProvider } from '../../../orchestrators';
import type { PasteSubmitTiming } from '../../../orchestrators';

// ── File-backed message delivery ────────────────────────────────────────────
//
// Multi-line paste via bracketed-paste escape sequences is unreliable across
// different CLIs (GHCP in particular mangles or truncates multi-line pastes).
// Instead we write the full message to a temp file and send a short single-line
// reference into the PTY.  The receiving agent reads the file with its normal
// file-reading tool.

const A2A_MSG_DIR = path.join(app.getPath('temp'), 'clubhouse-a2a-messages');

/** Ensure the a2a message directory exists (idempotent). */
async function ensureMsgDir(): Promise<void> {
  await fsp.mkdir(A2A_MSG_DIR, { recursive: true });
}

/**
 * Write a message to a temp file and return its path.
 * File is named after the taskId for easy correlation.
 */
export async function writeMessageFile(taskId: string, content: string): Promise<string> {
  await ensureMsgDir();
  const filePath = path.join(A2A_MSG_DIR, `${taskId}.md`);
  await fsp.writeFile(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Schedule cleanup of a message file after a delay.
 * Default 5 minutes — long enough for the receiving agent to read it.
 */
export function scheduleMessageCleanup(filePath: string, delayMs = 5 * 60 * 1000): void {
  setTimeout(async () => {
    try {
      await fsp.unlink(filePath);
    } catch {
      // File may already be gone — that's fine
    }
  }, delayMs);
}

/** Register all agent-to-agent tool templates. */
export function registerAgentTools(): void {
  // clubhouse__<project>_<name>_<hash>__send_message
  registerToolTemplate(
    'agent',
    'send_message',
    {
      description:
        'Send a message to the linked agent. The message is injected as terminal input and submitted.\n\n' +
        'IMPORTANT — this is asynchronous. The target agent will process the message on its own timeline ' +
        'and may be in the middle of other work. There is no inline response.\n\n' +
        'Multi-line messages are automatically saved to a temp file and the agent receives a single-line ' +
        'reference with the file path. The target agent should read the file for full instructions.\n\n' +
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
    },
    async (targetId, agentId, args): Promise<McpToolResult> => {
      const message = args.message as string;
      if (!message) {
        return { content: [{ type: 'text', text: 'Missing required argument: message' }], isError: true };
      }

      const taskId = (args.task_id as string) || `t_${Date.now().toString(36)}`;
      const forceSubmit = args.force_submit !== false; // default true

      const reg = agentRegistry.get(targetId);
      if (!reg) {
        appLog('core:mcp', 'warn', 'send_message: target agent not found in registry', {
          meta: { sourceAgent: agentId, targetAgent: targetId },
        });
        return { content: [{ type: 'text', text: `Agent ${targetId} is not running` }], isError: true };
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

          if (isMultiLine) {
            // Multi-line messages are written to a temp file and a short
            // single-line reference is sent to the PTY.  This avoids
            // bracketed-paste issues (GHCP and other CLIs mangle or
            // truncate multi-line paste content).
            const filePath = await writeMessageFile(taskId, taggedMessage);
            scheduleMessageCleanup(filePath);

            const ptyLine = `[TASK:${taskId}] [FROM:${senderLabel}] Message from ${senderLabel} saved to ${filePath} — read that file for full instructions.`;
            ptyManager.write(targetId, ptyLine);

            appLog('core:mcp', 'info', 'send_message: multi-line message written to file', {
              meta: { targetAgent: targetId, taskId, filePath, messageLength: taggedMessage.length },
            });
          } else {
            ptyManager.write(targetId, taggedMessage);
          }

          if (forceSubmit) {
            // Resolve provider-specific paste submit timing. Different CLIs
            // process input at different speeds — Claude Code is
            // fast (200ms) while Copilot CLI needs longer (500ms).
            const provider = getProvider(reg.orchestrator);
            const timing: PasteSubmitTiming = provider?.getPasteSubmitTiming()
              ?? { initialDelayMs: 200, retryDelayMs: 200, finalCheckDelayMs: 200 };

            appLog('core:mcp', 'info', 'send_message: using submit timing', {
              meta: { targetAgent: targetId, taskId, orchestrator: reg.orchestrator, timing },
            });

            // Snapshot the buffer length before the submit keystroke so we can
            // heuristically check whether the receiving agent processed the input.
            const bufferBefore = ptyManager.getBuffer(targetId)?.length ?? 0;

            // Send Enter to submit the message, then optionally a second
            // Enter if the buffer didn't grow (some CLIs need confirmation).
            await new Promise<void>((resolve) => {
              setTimeout(() => {
                ptyManager.write(targetId, '\r');

                appLog('core:mcp', 'info', 'send_message: first Enter sent', {
                  meta: { targetAgent: targetId, taskId },
                });

                // Check if the first \r triggered processing; if not, send
                // a second \r to submit.
                setTimeout(() => {
                  const bufferAfterFirst = ptyManager.getBuffer(targetId)?.length ?? 0;
                  const firstEnterWorked = bufferAfterFirst > bufferBefore;

                  if (firstEnterWorked) {
                    appLog('core:mcp', 'info', 'send_message: first Enter triggered processing, skipping retry', {
                      meta: { targetAgent: targetId, taskId, bufferBefore, bufferAfterFirst },
                    });
                    resolve();
                    return;
                  }

                  // Second Enter — submit the message
                  ptyManager.write(targetId, '\r');

                  appLog('core:mcp', 'info', 'send_message: second Enter sent (submit)', {
                    meta: { targetAgent: targetId, taskId, bufferBefore, bufferAfterFirst },
                  });

                  // Final buffer check
                  setTimeout(() => {
                    const bufferAfterSecond = ptyManager.getBuffer(targetId)?.length ?? 0;
                    const secondEnterWorked = bufferAfterSecond > bufferBefore;
                    appLog('core:mcp', 'info', 'send_message: post-submit buffer check', {
                      meta: { targetAgent: targetId, taskId, bufferBefore, bufferAfterSecond, secondEnterWorked },
                    });
                    resolve();
                  }, timing.finalCheckDelayMs);
                }, timing.retryDelayMs);
              }, timing.initialDelayMs);
            });
          }
        } else if (reg.runtime === 'structured') {
          await structuredManager.sendMessage(targetId, taggedMessage);
        } else {
          return { content: [{ type: 'text', text: `Agent runtime "${reg.runtime}" does not support input` }], isError: true };
        }

        const submitNote = forceSubmit ? '' : ' (force_submit=false, message injected without submitting)';
        const multiLineNote = taggedMessage.includes('\n') ? ' Multi-line message delivered via temp file.' : '';
        const resultText = isBidirectional
          ? `Message sent to ${targetName}. task_id=${taskId}. ` +
            `Bidirectional — ${targetName} can reply directly via send_message.${multiLineNote}${submitNote}`
          : `Message sent to ${targetName}. task_id=${taskId} — ` +
            `poll read_output for TASK_RESULT:${taskId}.${multiLineNote}${submitNote}`;

        return { content: [{ type: 'text', text: resultText }] };
      } catch (err) {
        appLog('core:mcp', 'error', 'Failed to send message to agent', {
          meta: { sourceAgent: agentId, targetAgent: targetId, error: err instanceof Error ? err.message : String(err) },
        });
        return { content: [{ type: 'text', text: `Failed to send message: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  // clubhouse__<project>_<name>_<hash>__get_status
  registerToolTemplate(
    'agent',
    'get_status',
    {
      description: 'Get the current status of the linked agent.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    async (targetId, agentId, _args): Promise<McpToolResult> => {
      const reg = agentRegistry.get(targetId);
      const running = !!reg;

      const status: Record<string, unknown> = {
        running,
        runtime: reg?.runtime || null,
      };

      appLog('core:mcp', 'info', 'get_status: resolved', {
        meta: { sourceAgent: agentId, targetAgent: targetId, running, runtime: reg?.runtime },
      });

      return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
    },
  );

  // clubhouse__<project>_<name>_<hash>__read_output
  registerToolTemplate(
    'agent',
    'read_output',
    {
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
    },
    async (targetId, agentId, args): Promise<McpToolResult> => {
      const reg = agentRegistry.get(targetId);
      if (!reg) {
        appLog('core:mcp', 'warn', 'read_output: target agent not found in registry', {
          meta: { sourceAgent: agentId, targetAgent: targetId },
        });
        return { content: [{ type: 'text', text: `Agent ${targetId} is not running` }], isError: true };
      }

      let lines = (args.lines as number) || 50;
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
  );

  // clubhouse__<project>_<name>_<hash>__check_connectivity
  registerToolTemplate(
    'agent',
    'check_connectivity',
    {
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
    },
    async (targetId, agentId, _args): Promise<McpToolResult> => {
      const reg = agentRegistry.get(targetId);
      if (!reg) {
        return { content: [{ type: 'text', text: `Agent ${targetId} is not running` }], isError: true };
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
  );
}
