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
 * 3. News shown now from an agent is rewritten into one or two sentences in
 *    its voice (dispatcher-rewrite), and shows under the agent's name and
 *    avatar. The Dispatcher's own words and check-in summaries reach the chat
 *    as a Clubhouse update, which the chat puts in its own words and the
 *    group chat view doesn't show.
 *
 * The triage state (open requests, news held for a check-in, what was shown)
 * is kept in `dispatcher-news.json` beside the Dispatcher's folders, not in
 * memory: Clear chat and Forget everything leave it alone, and it survives a
 * restart.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getBaseDirPath } from '../base-dir';
import { appLog } from '../log-service';
import { bindingManager } from '../clubhouse-mcp/binding-manager';
import * as agentConfig from '../agent-config';
import type { MessageSender } from '../../../shared/chat';
import { cleanAgentNews, toInterjection } from '../../../shared/dispatcher-chat-noise';
import {
  applyTriage,
  emptyTriageState,
  noteRequest,
  triageNews,
  type HeldNews,
  type NewsItem,
  type NewsKind,
  type TriageDecision,
  type TriageState,
} from './dispatcher-triage';
import { rewriteAgentNews, type RewriteRequest, type RewriteResult } from './dispatcher-rewrite';
import { getDispatcherPath } from './dispatcher-paths';
import { clearAgentMessages, findInInbox, takeAgentMessages } from './dispatcher-news-inbox';
import { CHAT_UPDATE_TAG, onHandOff, setChatDelivery, type ChannelMessage } from './dispatcher-channel';
import { defaultDispatcherOrchestrator, getDispatcherAgentId, isDispatcherIdentityAgentId } from './dispatcher-service';

const NS = 'core:dispatcher';

/** What the Dispatcher's tell_user carries. */
export interface ChatReport {
  message: string;
  /** The agent whose news it is, by id or name. Absent for the Dispatcher's own words. */
  from?: string;
  /** Absent means news that needs the person, as tell_user always meant. */
  kind?: NewsKind;
}

/** What reaches the chat agent, and how the chat shows it. */
export type ChatMessage = ChannelMessage;

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
    state = {
      openRequests: Array.isArray(parsed.openRequests) ? parsed.openRequests.filter((n) => typeof n === 'number') : [],
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

/** The person handed something off from the chat: its answer shows right away. */
export function noteUserRequest(now = Date.now()): void {
  writeState(noteRequest(readState(), now));
}

/** News waiting for the next check-in, for the check-in itself and for tests. */
export function heldNews(): readonly HeldNews[] {
  return readState().held;
}

// ── The delivery step ─────────────────────────────────────────────────────

export interface GroupChatDeps {
  now?: () => number;
  /** The Dispatcher's provider, for the rewrite step's Auto minimum. */
  provider?: () => Promise<string | undefined>;
  /** An agent the Dispatcher named that hasn't messaged it lately: by id or name, among agents wired to it. */
  findAgent?: (from: string) => MessageSender | null;
  /** Whether this is one of the Dispatcher's own agents, whose words are its own. */
  isOwnAgent?: (agentId: string) => boolean;
  rewrite?: (req: RewriteRequest) => Promise<RewriteResult>;
}

const NEVER_REASONS: Record<Extract<TriageDecision, { show: 'never' }>['reason'], string> = {
  empty: 'Nothing was left to show once tool output and ids were taken out. Write plain sentences.',
  duplicate: 'The user was already told this.',
  nothing_changed: 'Nothing changed since the last check-in, so no summary was shown.',
};

const LATER_REASONS: Record<Extract<TriageDecision, { show: 'later' }>['reason'], string> = {
  routine: 'Held for the next check-in summary.',
  nothing_asked: 'The user has no open request this answers, so it is held for the next check-in summary.',
};

function heldLine(h: HeldNews): string {
  return h.fromName ? `- ${h.fromName}: ${h.text}` : `- ${h.text}`;
}

/** The chat's message for the Dispatcher's own words: a Clubhouse update the chat says in its own words. */
function ownWords(text: string): ChatMessage {
  return {
    text: `${CHAT_UPDATE_TAG} News for the user. Tell them in your own words, briefly:\n\n${text}`,
    routed: [{ fromClubhouse: true, text }],
  };
}

function checkInMessage(summary: string, held: readonly HeldNews[]): ChatMessage {
  const text = `${CHAT_UPDATE_TAG} Check-in. Since the last one:\n${held.map(heldLine).join('\n')}\n\n`
    + `${summary}\n\nGive the user a short summary in your own words: what changed and anything that needs them.`;
  return { text, routed: [{ fromClubhouse: true, text: summary }] };
}

/** The chat's message for an agent's news: it shows under the agent's name, and the chat may add a word. */
function interjection(sender: MessageSender, text: string, reason: 'needs_user' | 'answer'): ChatMessage {
  const why = reason === 'needs_user' ? 'It needs the user.' : 'It answers what the user asked.';
  return {
    text: `${CHAT_UPDATE_TAG} ${sender.name} told the user, in the conversation: "${text}" ${why} `
      + 'The user has already read it. Add a short reply only if it helps, such as what it means or what you suggest next. Don\'t repeat it.',
    routed: [{ sender, text }],
  };
}

async function defaultProvider(): Promise<string | undefined> {
  const id = getDispatcherAgentId();
  const config = id ? await agentConfig.getDurableConfig(getDispatcherPath(), id).catch((): null => null) : null;
  return config?.orchestrator ?? defaultDispatcherOrchestrator();
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
 * The step between the Dispatcher's report and its chat: triage, then the
 * rewrite for an agent's news shown now. Serialized, so reports reach the chat
 * in the order they were made.
 */
export function createGroupChatDelivery(deps: GroupChatDeps = {}): (report: ChatReport) => Promise<ChatDecision> {
  const now = deps.now ?? Date.now;
  const findAgent = deps.findAgent ?? defaultFindAgent;
  const rewrite = deps.rewrite ?? rewriteAgentNews;
  const provider = deps.provider ?? defaultProvider;
  const isOwnAgent = deps.isOwnAgent ?? isDispatcherIdentityAgentId;
  let chain: Promise<unknown> = Promise.resolve();

  const decide = async (report: ChatReport): Promise<ChatDecision> => {
    const at = now();
    const kind = report.kind ?? 'needs_user';
    let sender = report.from ? findInInbox(report.from) ?? findAgent(report.from) : null;
    if (sender?.agentId && isOwnAgent(sender.agentId)) sender = null;
    const cleaned = sender ? toInterjection(report.message) : cleanAgentNews(report.message);
    const item: NewsItem = {
      kind,
      text: cleaned,
      at,
      ...(sender?.agentId && { fromAgentId: sender.agentId }),
      ...(sender && { fromName: sender.name }),
    };
    const before = readState();
    const decision = triageNews(item, before, at);
    appLog(NS, 'info', 'Dispatcher news triage', { meta: { kind, show: decision.show, reason: 'reason' in decision ? decision.reason : undefined, fromAgent: !!sender } });

    if (decision.show === 'never') {
      writeState(applyTriage(before, item, decision, at));
      return { hold: 'never', reason: NEVER_REASONS[decision.reason] };
    }
    if (decision.show === 'later') {
      writeState(applyTriage(before, item, decision, at));
      // Passed on: the raw message isn't the next one to rewrite.
      if (sender?.agentId) takeAgentMessages(sender.agentId, at);
      return { hold: 'later', reason: LATER_REASONS[decision.reason] };
    }
    if (decision.show === 'check_in') {
      writeState(applyTriage(before, item, decision, at));
      return checkInMessage(cleaned, decision.held);
    }
    if (!sender?.agentId) {
      writeState(applyTriage(before, item, decision, at));
      return ownWords(cleaned);
    }
    const raw = takeAgentMessages(sender.agentId, at);
    const rewritten = await rewrite({ provider: (await provider().catch((): undefined => undefined)) ?? '', agentName: sender.name, raw, fallback: report.message })
      .catch((): RewriteResult => ({ text: cleaned, by: 'fallback', reason: 'run_failed' }));
    const text = rewritten.text || cleaned;
    appLog(NS, 'info', 'Dispatcher news rewrite', { meta: { by: rewritten.by, reason: rewritten.reason } });
    // Remembered as the Dispatcher wrote it, since that is what it would send again. Read
    // fresh: a hand-off may have opened a request while the rewrite ran.
    writeState(applyTriage(readState(), item, decision, at));
    return interjection(sender, text, decision.reason);
  };

  return (report) => {
    const run = chain.then(() => decide(report), () => decide(report));
    chain = run.catch((): void => undefined);
    return run;
  };
}

let uninstall: (() => void) | null = null;

/** Make the Dispatcher's chat a group chat: install the triage and rewrite, and count hand-offs as requests. */
export function installGroupChat(deps: GroupChatDeps = {}): void {
  uninstall?.();
  setChatDelivery(createGroupChatDelivery(deps));
  const stop = onHandOff(() => noteUserRequest((deps.now ?? Date.now)()));
  uninstall = () => { stop(); setChatDelivery(null); };
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
