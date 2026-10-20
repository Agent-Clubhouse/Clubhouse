/**
 * Helper questions (#2366): a helper's question goes to its orchestrator, not
 * the user, while the orchestrator's control level is "hands-off".
 *
 * routeHelperQuestion is offered every question a chat agent asks (Claude
 * AskUserQuestion, Codex requestUserInput) before the user sees it. For a
 * helper whose parent orchestrates hands-off and is running, it sends the
 * parent the question, its options and a request id, and the helper stays
 * blocked. Anything else (no parent, an "ask" control level, a sleeping
 * parent, a failed delivery) leaves the question with the user, as before.
 * Terminal agents answer in their terminal and are never routed.
 *
 * The parent answers with answer_helper_question, or passes the question to
 * the user with `escalate`. If the parent stops first, its helpers' open
 * questions go to the user. The user can still answer a routed question in
 * the helper's chat; whichever answer comes first wins. The tool is in the
 * `orchestration` group, like the other tools an orchestrator uses on its
 * helpers.
 */

import { randomUUID } from 'crypto';
import { registerGlobalTool } from '../tool-registry';
import type { McpToolResult } from '../types';
import * as agentConfig from '../../agent-config';
import { agentRegistry } from '../../agent-registry';
import { getAgentRuntime } from '../../agent-runtime';
import { isAgentStoppingError } from '../../agent-runtime/agent-stopping';
import { getOrchestrationPolicy } from '../../orchestration-policy';
import { appLog } from '../../log-service';
import { isDisposedAgent } from '../../../../shared/agent-helpers';
import type { ChatEventDataMap, ChatQuestion, ChatQuestionAnswers } from '../../../../shared/chat';
import { McpArgError, optionalString } from './validation';

type QuestionData = ChatEventDataMap['question'];
type QuestionRoute = NonNullable<QuestionData['routedTo']>;

interface RoutedQuestion {
  helperId: string;
  helperName: string;
  parentId: string;
  /** The helper runtime's own request id. */
  requestId: string;
  questions: ChatQuestion[];
}

/** Questions sent to a parent and not yet answered by it, by the id the parent was given. */
const routed = new Map<string, RoutedQuestion>();
/** Parents whose exit is watched, so their helpers' questions go to the user if they stop. */
const watchedParents = new Map<string, () => void>();

function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], ...(isError && { isError: true }) };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A refusal meant for the caller, as is. */
class QuestionToolError extends Error {}

// ── Routing ──────────────────────────────────────────────────────────────

function quote(text: string): string {
  return JSON.stringify(text);
}

/** The message a parent gets for a helper's question. */
export function formatHelperQuestion(helper: { id: string; name: string }, id: string, questions: ChatQuestion[]): string {
  const lines = [
    `[QUESTION FROM HELPER:${helper.name} (${helper.id})] ${helper.name} is waiting for your answer. ` +
      `Answer with answer_helper_question, requestId ${quote(id)}. If the user should decide, call it with escalate: true instead.`,
  ];
  questions.forEach((q, i) => {
    lines.push(`${i + 1}. ${q.header ? `${q.header}. ` : ''}${q.prompt}`);
    if (q.options?.length) {
      const options = q.options.map((o) => `${quote(o.label)}${o.description ? ` (${o.description})` : ''}`);
      lines.push(`   Options: ${options.join('; ')}`);
    }
    if (q.options?.length) {
      const rule = q.multiSelect ? 'Pick one or more.' : 'Pick one.';
      lines.push(`   ${rule}${q.allowFreeText ? ' Your own text is fine too.' : ''}`);
    }
  });
  return lines.join('\n');
}

/**
 * Send a helper's question to its parent when the parent orchestrates
 * hands-off and is running. Returns the parent, or null when the user should
 * be asked. Never throws.
 */
export async function routeHelperQuestion(helperId: string, question: QuestionData): Promise<QuestionRoute | null> {
  pruneRouted();
  try {
    const projectPath = agentRegistry.get(helperId)?.projectPath;
    if (!projectPath) return null;
    const helper = await agentConfig.getDurableConfig(projectPath, helperId);
    if (!helper?.parentAgentId) return null;
    const parent = await agentConfig.getDurableConfig(projectPath, helper.parentAgentId);
    if (!parent || isDisposedAgent(parent)) return null;
    const policy = await getOrchestrationPolicy(projectPath, parent.id);
    if (!policy?.orchestrate || policy.control !== 'hands-off') return null;
    const runtime = getAgentRuntime(parent.id);
    if (!runtime?.isRunning()) return null;

    const id = `hq_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    routed.set(id, {
      helperId, helperName: helper.name, parentId: parent.id, requestId: question.requestId, questions: question.questions,
    });
    try {
      await runtime.sendMessage(formatHelperQuestion(helper, id, question.questions), {
        source: 'mcp', taskId: `helper_question_${id}`,
      });
    } catch (err) {
      routed.delete(id);
      if (isAgentStoppingError(err)) return null;
      throw err;
    }
    watchParent(parent.id, parent.name, runtime);
    appLog('core:mcp', 'info', 'Helper question sent to its parent', {
      meta: { helperId, parentId: parent.id, questionId: id, questions: question.questions.length },
    });
    return { agentId: parent.id, name: parent.name };
  } catch (err) {
    // telemetry-exempt: logged; the question falls back to the user
    appLog('core:mcp', 'warn', 'Could not send a helper question to its parent', {
      meta: { helperId, error: errorText(err) },
    });
    return null;
  }
}

/** When the parent stops, its helpers' open questions go to the user. */
function watchParent(parentId: string, parentName: string, runtime: { onExit(listener: () => void): () => void }): void {
  if (watchedParents.has(parentId)) return;
  const unsubscribe = runtime.onExit(() => {
    watchedParents.get(parentId)?.();
    watchedParents.delete(parentId);
    for (const [id, entry] of [...routed]) {
      if (entry.parentId !== parentId) continue;
      routed.delete(id);
      const helper = getAgentRuntime(entry.helperId);
      void helper?.escalateQuestion?.(entry.requestId, `${parentName} stopped before answering, so this question is yours.`)
        .catch((err: unknown) => {
          // telemetry-exempt: logged; the question stays in the helper's chat
          appLog('core:mcp', 'warn', 'Could not pass a helper question to the user', {
            meta: { helperId: entry.helperId, error: errorText(err) },
          });
        });
    }
  });
  watchedParents.set(parentId, unsubscribe);
}

/** Forget questions answered elsewhere (the user, in the helper's chat) or whose helper stopped. */
function pruneRouted(): void {
  for (const [id, entry] of routed) {
    const runtime = getAgentRuntime(entry.helperId);
    if (!runtime?.isRunning() || !runtime.hasPendingQuestion?.(entry.requestId)) routed.delete(id);
  }
}

// ── Answers ──────────────────────────────────────────────────────────────

function answerValues(value: unknown, label: string): string[] {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0 || !list.every((v) => typeof v === 'string' && v.trim())) {
    throw new McpArgError(`The answer to ${label} must be text, or a list of text for a pick-several question.`);
  }
  return (list as string[]).map((v) => v.trim());
}

/** One answer, matched to the question's options (by label, case-insensitive) where it can be. */
function answerFor(q: ChatQuestion, index: number, value: unknown): string | string[] {
  const label = `question ${index + 1}`;
  const values = answerValues(value, label);
  if (values.length > 1 && !q.multiSelect) throw new McpArgError(`Question ${index + 1} takes one answer.`);
  const matched = values.map((v) => {
    const lower = v.toLowerCase();
    const option = q.options?.find((o) => o.label.toLowerCase() === lower || o.id.toLowerCase() === lower);
    if (option) return option.id;
    if (q.options?.length && !q.allowFreeText) {
      throw new McpArgError(`${quote(v)} is not an option for ${label}. Pick one of: ${q.options.map((o) => quote(o.label)).join(', ')}.`);
    }
    return v;
  });
  return q.multiSelect ? matched : matched[0];
}

/**
 * The parent's answer as the helper's runtime takes it: answers keyed by
 * question id. `answer` is for a single question; `answers` is keyed by the
 * question's number (1, 2, ...), its id or its header.
 */
export function parseHelperAnswers(questions: ChatQuestion[], args: Record<string, unknown>): ChatQuestionAnswers {
  const out: ChatQuestionAnswers = {};
  if (args.answers !== undefined && args.answers !== null) {
    if (typeof args.answers !== 'object' || Array.isArray(args.answers)) {
      throw new McpArgError('answers must be an object keyed by question number, e.g. {"1": "Yes"}.');
    }
    for (const [key, value] of Object.entries(args.answers as Record<string, unknown>)) {
      const lower = key.trim().toLowerCase();
      const index = questions.findIndex((q, i) =>
        String(i + 1) === lower || q.id.toLowerCase() === lower || q.header?.toLowerCase() === lower);
      if (index === -1) throw new McpArgError(`Unknown question ${quote(key)}. Key answers by question number, 1 to ${questions.length}.`);
      out[questions[index].id] = answerFor(questions[index], index, value);
    }
  } else if (args.answer !== undefined && args.answer !== null) {
    if (questions.length !== 1) {
      throw new McpArgError(`There are ${questions.length} questions. Use answers, keyed by question number, e.g. {"1": "...", "2": "..."}.`);
    }
    out[questions[0].id] = answerFor(questions[0], 0, args.answer);
  } else {
    throw new McpArgError('Give answer (one question) or answers (keyed by question number), or escalate: true.');
  }
  const missing = questions.findIndex((q) => out[q.id] === undefined);
  if (missing !== -1) throw new McpArgError(`Missing an answer for question ${missing + 1}.`);
  return out;
}

async function answerHelperQuestion(agentId: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const id = optionalString(args, 'requestId')?.trim();
  if (!id) throw new McpArgError('Missing required argument: requestId');
  const entry = routed.get(id);
  if (!entry || entry.parentId !== agentId) {
    throw new QuestionToolError(`No open helper question ${quote(id)}. It may have been answered already.`);
  }
  const runtime = getAgentRuntime(entry.helperId);
  if (!runtime?.isRunning() || !runtime.hasPendingQuestion?.(entry.requestId)) {
    routed.delete(id);
    throw new QuestionToolError(`${entry.helperName}'s question is no longer open. The user may have answered it, or the helper stopped.`);
  }

  if (args.escalate === true) {
    const parentName = (await parentNameOf(agentId)) ?? 'Your orchestrator';
    const escalated = await runtime.escalateQuestion?.(entry.requestId, `${parentName} passed this question to you.`);
    if (!escalated) throw new QuestionToolError(`${entry.helperName}'s question is already with the user.`);
    routed.delete(id);
    appLog('core:mcp', 'info', 'answer_helper_question: escalated to the user', { meta: { agentId, helperId: entry.helperId, questionId: id } });
    return textResult(`Passed ${entry.helperName}'s question to the user. ${entry.helperName} waits for their answer.`);
  }

  const answers = parseHelperAnswers(entry.questions, args);
  await runtime.answerQuestion(entry.requestId, answers);
  routed.delete(id);
  appLog('core:mcp', 'info', 'answer_helper_question: answered', { meta: { agentId, helperId: entry.helperId, questionId: id } });
  return textResult(`Answered. ${entry.helperName} carries on.`);
}

async function parentNameOf(agentId: string): Promise<string | undefined> {
  const projectPath = agentRegistry.get(agentId)?.projectPath;
  if (!projectPath) return undefined;
  return (await agentConfig.getDurableConfig(projectPath, agentId))?.name;
}

// ── Registration ─────────────────────────────────────────────────────────

export function registerHelperQuestionTools(): void {
  registerGlobalTool(
    'answer_helper_question',
    {
      description:
        'Answer a question one of your helpers asked. While you orchestrate hands-off, a helper\'s ' +
        'questions come to you as "[QUESTION FROM HELPER:...]" messages with a requestId, and the helper ' +
        'waits until you answer. Give answer for a single question, or answers keyed by question number ' +
        'for several. For an option, give its label; for a pick-several question, a list. If the user ' +
        'should decide, set escalate: true and the question goes to them instead.',
      inputSchema: {
        type: 'object',
        properties: {
          requestId: { type: 'string', description: 'The requestId from the question message.' },
          answer: { type: 'string', description: 'The answer, when there is one question that takes one answer.' },
          answers: {
            type: 'object',
            description:
              'Answers keyed by question number ("1", "2", ...), each text or, for a pick-several question, a list of text.',
          },
          escalate: { type: 'boolean', description: 'Pass the question to the user instead of answering it.' },
        },
        required: ['requestId'],
      },
    },
    async (agentId, args) => {
      try {
        return await answerHelperQuestion(agentId, args);
      } catch (err) {
        if (!(err instanceof McpArgError || err instanceof QuestionToolError)) {
          // telemetry-exempt: the error reaches the calling agent as the tool result
          appLog('core:mcp', 'warn', 'answer_helper_question failed', { meta: { agentId, error: errorText(err) } });
        }
        return textResult(errorText(err), true);
      }
    },
    { group: 'orchestration' },
  );
}

export function _resetHelperQuestionsForTesting(): void {
  routed.clear();
  for (const unsubscribe of watchedParents.values()) unsubscribe();
  watchedParents.clear();
}
