/**
 * The Dispatcher's chat as a group chat (#3043): what reaches it from the
 * Dispatcher's reports, and how it reads.
 *
 * Agents' messages reach the Dispatcher raw (deliverToDispatcher records each
 * one here). When the Dispatcher passes an agent's news on with tell_user, it
 * names the agent (`from`) and says what kind of news it is (`kind`). Then:
 *
 * 1. Tool noise is cleaned out (shared/dispatcher-chat-noise).
 * 2. The triage rules (dispatcher-triage) decide: now, at the next check-in,
 *    or never.
 * 3. What shows now reaches the chat as a Clubhouse update, which the group
 *    chat view doesn't show: the chat says it in its own words, naming the
 *    agent when it is an agent's news. So the user reads each piece of news
 *    once, in the Dispatcher's voice, and answers a question in the chat
 *    (#3193). The chat's reply is the news itself, with no turn after it to
 *    react to a row the user already read. The agent's own messages stay in
 *    its own chat and the Dispatcher's transcript.
 *
 * Each answer or question is matched to the user's request it is for
 * (dispatcher-requests, #3204): an answer shows now and closes it, a question
 * leaves it waiting on the user, and the chat is told its id so the user's
 * answer goes back under it.
 *
 * The triage state (news held for a check-in, what was shown) is kept in
 * `dispatcher-news.json` beside the Dispatcher's folders, not in memory, and
 * survives a restart. Clear chat leaves it alone; Forget everything drops the
 * held news (clearHeldNews).
 */
import * as fs from 'fs';
import * as path from 'path';
import { getBaseDirPath } from '../base-dir';
import { appLog } from '../log-service';
import { recordNewsTriage } from '../../telemetry/dispatcher-telemetry';
import { bindingManager } from '../clubhouse-mcp/binding-manager';
import type { MessageSender } from '../../../shared/chat';
import { cleanAgentNews } from '../../../shared/dispatcher-chat-noise';
import {
  applyTriage,
  emptyTriageState,
  revertShown,
  triageNews,
  type HeldNews,
  type NewsItem,
  type NewsKind,
  type TriageDecision,
  type TriageState,
} from './dispatcher-triage';
import { clearAgentMessages, findInInbox } from './dispatcher-news-inbox';
import { CHAT_UPDATE_TAG, setChatDelivery, type ChannelMessage } from './dispatcher-channel';
import { findRequestFor, restoreRequest, settleRequest } from './dispatcher-requests';
import { isDispatcherIdentityAgentId } from './dispatcher-service';

const NS = 'core:dispatcher';

/** What the Dispatcher's tell_user carries. */
export interface ChatReport {
  message: string;
  /** The agent whose news it is, by id or name. Absent for the Dispatcher's own words. */
  from?: string;
  /** Absent means news that needs the person, as tell_user always meant. */
  kind?: NewsKind;
  /** The id of the user's request it is about, from the hand-off. */
  request?: string;
}

/** What reaches the chat agent, and how the chat shows it. */
export interface ChatMessage extends ChannelMessage {
  /**
   * Call when it didn't reach the chat: it is forgotten as shown, so the
   * Dispatcher can send it again, and the request it settled is put back.
   */
  notDelivered?: () => void;
}

/** A report that isn't shown now: held for the next check-in, or never shown. */
export interface ChatHold {
  hold: 'later' | 'never';
  reason: string;
}

export type ChatDecision = ChatMessage | ChatHold;

export function isChatHold(decision: ChatDecision | null): decision is ChatHold {
  return !!decision && 'hold' in decision;
}


// ── Triage state ──────────────────────────────────────────────────────────

let state: TriageState | null = null;
let saving: Promise<void> = Promise.resolve();

export function getNewsStatePath(): string {
  return path.join(getBaseDirPath(), 'dispatcher-news.json');
}

function readState(): TriageState {
  if (state) return state;
  try {
    const parsed = JSON.parse(fs.readFileSync(getNewsStatePath(), 'utf8')) as Partial<TriageState>;
    // An older file's `openRequests` count is left behind: requests are keyed now (dispatcher-requests).
    state = {
      held: Array.isArray(parsed.held) ? parsed.held.filter((h) => h && typeof h.text === 'string' && typeof h.at === 'number') : [],
      shown: Array.isArray(parsed.shown) ? parsed.shown.filter((h) => h && typeof h.text === 'string' && typeof h.at === 'number') : [],
      ...(typeof parsed.lastCheckInAt === 'number' && { lastCheckInAt: parsed.lastCheckInAt }),
    };
  } catch {
    // telemetry-exempt: no file yet, or one that can't be read: start empty.
    state = emptyTriageState();
  }
  return state;
}

function writeState(next: TriageState): void {
  state = next;
  const file = getNewsStatePath();
  const body = JSON.stringify(next, null, 2);
  saving = saving.then(async () => {
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, body, 'utf8');
    } catch (err) {
      // telemetry-exempt: the state stays in memory for this run; logged
      appLog(NS, 'warn', 'Dispatcher news state not saved', { meta: { error: err instanceof Error ? err.message : String(err) } });
    }
  });
}

/** News waiting for the next check-in, for the check-in itself and for tests. */
export function heldNews(): readonly HeldNews[] {
  return readState().held;
}

/**
 * Forget everything (#3046): drop the news held for the next check-in, so a
 * later check-in doesn't bring back what was forgotten. What was shown stays. Returns how many were dropped.
 */
export function clearHeldNews(): number {
  const current = readState();
  const dropped = current.held.length;
  if (dropped > 0) writeState({ ...current, held: [] });
  return dropped;
}

// ── The delivery step ─────────────────────────────────────────────────────

export interface GroupChatDeps {
  now?: () => number;
  /** An agent the Dispatcher named that hasn't messaged it lately: by id or name, among agents wired to it. */
  findAgent?: (from: string) => MessageSender | null;
  /** Whether this is one of the Dispatcher's own agents, whose words are its own. */
  isOwnAgent?: (agentId: string) => boolean;
}

const NEVER_REASONS: Record<Extract<TriageDecision, { show: 'never' }>['reason'], string> = {
  empty: 'Nothing was left to show once tool output and ids were taken out. Write plain sentences.',
  duplicate: 'The user was already told this.',
  nothing_changed: 'Nothing changed since the last check-in, so no summary was shown.',
};

const LATER_REASONS: Record<Extract<TriageDecision, { show: 'later' }>['reason'], string> = {
  routine: 'Held for the next check-in summary.',
  nothing_asked: 'It answers no request of the user\'s, so it is held for the next check-in summary. If it is the outcome of one, send it again with its request_id.',
};

function heldLine(h: HeldNews): string {
  return h.fromName ? `- ${h.fromName}: ${h.text}` : `- ${h.text}`;
}

/** How the user's answer goes back: under the request's id, when the news is for one. */
function answerWith(request: string | undefined): string {
  return request ? `pass their answer on with start_work and request_id ${request}` : 'pass their answer on with start_work';
}

/** The chat's message for the Dispatcher's own words: a Clubhouse update the chat says in its own words. */
function ownWords(text: string, reason: 'needs_user' | 'answer', request?: string): ChatMessage {
  const about = request ? ` on request ${request}` : '';
  const then = reason === 'needs_user' && request ? ` When they answer, ${answerWith(request)}.` : '';
  return {
    text: `${CHAT_UPDATE_TAG} News for the user${about}. Tell them in your own words, briefly.${then}\n\n${text}`,
    routed: [{ fromClubhouse: true, text }],
  };
}

function checkInMessage(summary: string, held: readonly HeldNews[]): ChatMessage {
  const text = `${CHAT_UPDATE_TAG} Check-in. Since the last one:\n${held.map(heldLine).join('\n')}\n\n`
    + `${summary}\n\nGive the user a short summary in your own words: what changed and anything that needs them.`;
  return { text, routed: [{ fromClubhouse: true, text: summary }] };
}

/**
 * The chat's message for an agent's news: the chat tells the user in its own words, naming the
 * agent, and that reply is the only thing the user sees of it (#3193).
 */
export function agentNews(sender: MessageSender, text: string, reason: 'needs_user' | 'answer', request?: string): ChatMessage {
  const what = reason === 'needs_user'
    ? `${sender.name} needs the user for this. Ask them in your own words, briefly, and say it comes from ${sender.name}. `
      + `Keep every option, number and name. They answer here, in this conversation; ${answerWith(request)}.`
    : `News from ${sender.name} that answers what the user asked${request ? ` in request ${request}` : ''}. `
      + `Tell them in your own words, briefly, and say it comes from ${sender.name}. `
      + 'Keep every number and name.';
  return {
    text: `${CHAT_UPDATE_TAG} ${what} Your reply is the whole message: no acknowledgment before or after it.\n\n${text}`,
    routed: [{ fromClubhouse: true, text }],
  };
}

function defaultFindAgent(from: string): MessageSender | null {
  const lower = from.toLowerCase();
  const seen = new Map<string, string>();
  for (const b of bindingManager.getAllBindings()) {
    if (b.targetKind !== 'agent') continue;
    if (b.agentName) seen.set(b.agentId, b.agentName);
    if (b.targetName) seen.set(b.targetId, b.targetName);
  }
  if (seen.has(from)) return { agentId: from, name: seen.get(from)! };
  const named = [...seen].filter(([, name]) => name.toLowerCase() === lower);
  return named.length === 1 ? { agentId: named[0][0], name: named[0][1] } : null;
}

/**
 * The step between the Dispatcher's report and its chat: triage, then what the
 * chat is told. Serialized, so reports reach the chat in the order they were made.
 */
export function createGroupChatDelivery(deps: GroupChatDeps = {}): (report: ChatReport) => Promise<ChatDecision> {
  const now = deps.now ?? Date.now;
  const findAgent = deps.findAgent ?? defaultFindAgent;
  const isOwnAgent = deps.isOwnAgent ?? isDispatcherIdentityAgentId;
  let chain: Promise<unknown> = Promise.resolve();

  const decide = async (report: ChatReport): Promise<ChatDecision> => {
    const at = now();
    const kind = report.kind ?? 'needs_user';
    let sender: MessageSender | null = report.from ? findInInbox(report.from, at) ?? findAgent(report.from) : null;
    if (sender?.agentId && isOwnAgent(sender.agentId)) sender = null;
    // An agent Clubhouse can't find, such as a name two projects share, is still that agent's news, under the name given.
    else if (!sender && report.from) sender = { name: report.from };
    const cleaned = cleanAgentNews(report.message);
    const request = findRequestFor({ kind, request: report.request, fromAgentId: sender?.agentId, fromName: sender?.name }, at);
    const item: NewsItem = {
      kind,
      text: cleaned,
      at,
      ...(sender?.agentId && { fromAgentId: sender.agentId }),
      ...(sender && { fromName: sender.name }),
      ...(request && { request: request.id }),
    };
    const before = readState();
    const decision = triageNews(item, before, at);
    appLog(NS, 'info', 'Dispatcher news triage', { meta: { kind, show: decision.show, reason: 'reason' in decision ? decision.reason : undefined, fromAgent: !!sender, request: request?.id } });
    const outcome = {
      kind,
      show: decision.show,
      ...('reason' in decision && { reason: decision.reason }),
      fromAgent: !!sender,
    };

    if (decision.show === 'never') {
      writeState(applyTriage(before, item, decision, at));
      recordNewsTriage(outcome);
      return { hold: 'never', reason: NEVER_REASONS[decision.reason] };
    }
    if (decision.show === 'later') {
      writeState(applyTriage(before, item, decision, at));
      recordNewsTriage(outcome);
      return { hold: 'later', reason: LATER_REASONS[decision.reason] };
    }
    // Remembered as shown now, so a repeat sent meanwhile is caught, and undone if it never reaches the chat.
    writeState(applyTriage(before, item, decision, at));
    const settled = request && decision.show === 'now' ? settleRequest(request.id, decision.reason, at) : null;
    const notDelivered = () => {
      writeState(revertShown(readState(), item, decision));
      if (settled) restoreRequest(settled, now());
    };
    if (decision.show === 'check_in') {
      recordNewsTriage({ ...outcome, held: decision.held.length });
      return { ...checkInMessage(cleaned, decision.held), notDelivered };
    }
    recordNewsTriage(outcome);
    return { ...(sender ? agentNews(sender, cleaned, decision.reason, request?.id) : ownWords(cleaned, decision.reason, request?.id)), notDelivered };
  };

  return (report) => {
    const run = chain.then(() => decide(report), () => decide(report));
    chain = run.catch((): void => undefined);
    return run;
  };
}

let uninstall: (() => void) | null = null;

/** Make the Dispatcher's chat a group chat: install the triage. */
export function installGroupChat(deps: GroupChatDeps = {}): void {
  uninstall?.();
  setChatDelivery(createGroupChatDelivery(deps));
  uninstall = () => { setChatDelivery(null); };
}

/** For tests. */
export async function _resetDispatcherNewsForTesting(): Promise<void> {
  await saving;
  uninstall?.();
  uninstall = null;
  clearAgentMessages();
  state = null;
  saving = Promise.resolve();
}

/** For tests: wait for the state file to be written. */
export function _whenNewsSavedForTesting(): Promise<void> {
  return saving;
}
