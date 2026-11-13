/**
 * A follower's news goes to the lead (#3352). On a computer following
 * another's lead, what this Dispatcher's triage would show in its own chat now
 * (an agent's question for the person, the answer to a request, a check-in)
 * goes to the lead's controller instead, over the controller link (#3345) as a
 * `send_message` carrying the news as fields. The lead's controller is told it,
 * labelled with this computer as its pinned connection names it, never as the
 * text says, and passes it to its chat with tell_user, as with any news. While the lead is offline, or the link isn't there, it
 * stays in this computer's own chat, readable from the follower pane.
 *
 * News never answers anything: it only reaches the person, who answers in the
 * lead's chat, which passes the answer on as any request.
 */

import { formatAgentAddress } from '../../shared/agent-address';
import { appLog } from './log-service';
import { forwardAgentCall, getDelivery, type AgentToolRunResult } from './annex-agent-calls';
import { remoteFederationController } from './dispatcher-federation';
import { isFollowingLead, leadRecord, leadRole } from './dispatcher-federation-lead';
import { getDispatcherAgentId } from './dispatcher/dispatcher-service';
import type { ChatMessage, ForwardedNews } from './dispatcher/dispatcher-news';
import { deliverUpdateToChat } from './dispatcher/dispatcher-channel';
import type { AnnexDeliveryFailure } from '../../shared/annex-delivery';

const NEWS_KINDS = new Set(['needs_user', 'answer', 'check_in']);
const MAX_TEXT = 8_000;
const MAX_NAME = 200;

/** The news fields another computer sent, or undefined when they aren't ones this computer reads. */
export function readForwardedNews(raw: unknown): ForwardedNews | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const n = raw as Record<string, unknown>;
  if (n.v !== 1 || typeof n.kind !== 'string' || !NEWS_KINDS.has(n.kind)) return undefined;
  if (typeof n.text !== 'string' || !n.text.trim() || n.text.length > MAX_TEXT) return undefined;
  if (n.fromName !== undefined && (typeof n.fromName !== 'string' || !n.fromName || n.fromName.length > MAX_NAME)) return undefined;
  if (n.request !== undefined && (typeof n.request !== 'string' || !n.request || n.request.length > MAX_NAME)) return undefined;
  return {
    v: 1, kind: n.kind as ForwardedNews['kind'], text: n.text,
    ...(typeof n.fromName === 'string' && { fromName: n.fromName }),
    ...(typeof n.request === 'string' && { request: n.request }),
  };
}

interface FollowerNewsHooks {
  connected: (machine: string) => boolean;
  machineName: (machine: string) => string | undefined;
}
let hooks: FollowerNewsHooks | undefined;

export function startFollowerNews(h: FollowerNewsHooks): () => void {
  hooks = h;
  return () => { if (hooks === h) hooks = undefined; };
}

/**
 * News a follower kept in its own chat while following (#3352): the lead was
 * offline or couldn't take it. The follower pane says so, since the person is
 * watching the lead's chat there, until it's dismissed.
 */
let localNews = { count: 0, needsUser: false };
const listeners = new Set<() => void>();
export function onLocalNewsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function localNewsState(): { count: number; needsUser: boolean } {
  return { ...localNews };
}
export function dismissLocalNews(): void {
  if (localNews.count === 0) return;
  localNews = { count: 0, needsUser: false };
  for (const listener of [...listeners]) listener();
}
function noteLocalNews(kind: ForwardedNews['kind']): void {
  localNews = { count: localNews.count + 1, needsUser: localNews.needsUser || kind === 'needs_user' };
  for (const listener of [...listeners]) listener();
}

/**
 * News queued for the lead and not delivered yet, by delivery id, so news the
 * lead refuses later can still reach the person here. Kept in memory: after a
 * restart, a refused one is reported as any refused delivery is.
 */
const pending = new Map<string, ChatMessage>();
const PENDING_MAX = 100;

/**
 * Calls to the lead under way, by target. A refusal that comes back at once is
 * reported to this delivery's failure hook before the call returns; the call
 * itself then keeps the news here, so that report isn't shown a second time.
 */
const inFlight = new Map<string, number>();

/** Forgets news the lead has taken. */
function pruneDelivered(callerId: string): void {
  for (const id of [...pending.keys()]) {
    if (getDelivery(callerId, id)?.state === 'delivered') pending.delete(id);
  }
}

/**
 * Sends news to the lead's controller link. True when it went, so this
 * computer's chat doesn't show it too; false to show it here.
 */
export async function forwardNewsToLead(message: ChatMessage): Promise<boolean> {
  const news = message.forward;
  if (!news || !hooks || !isFollowingLead()) return false;
  const kept = (why: string) => {
    appLog('core:dispatcher', 'info', 'News stayed on this computer', { meta: { kind: news.kind, why } });
    noteLocalNews(news.kind);
    return false;
  };
  const lead = leadRecord().lead;
  const local = getDispatcherAgentId();
  if (!lead || !local) return false;
  if (!hooks.connected(lead)) return kept('lead_offline');
  const controller = remoteFederationController(lead);
  if (!controller?.agentId || !controller.enabled) return kept('lead_unavailable');
  const to = formatAgentAddress({ agentId: controller.agentId, machine: lead });
  const summary = news.fromName ? `News from ${news.fromName}: ${news.text}` : news.text;
  pruneDelivered(local);
  inFlight.set(to, (inFlight.get(to) ?? 0) + 1);
  try {
    const result = await forwardAgentCall(local, to, controller.name, 'send_message', { message: summary, news });
    if (result.isError) return kept('refused');
    // Queued for delivery: kept until the lead takes it or refuses it.
    const text = result.content.map((c) => (c as { text?: string }).text ?? '').join(' ');
    const deliveryId = /delivery_id=([A-Za-z0-9_-]+)/.exec(text)?.[1];
    if (deliveryId) {
      pending.set(deliveryId, message);
      if (pending.size > PENDING_MAX) pending.delete(pending.keys().next().value!);
    }
    return true;
  } catch (err) {
    // telemetry-exempt: logged; the news shows in this computer's chat instead.
    appLog('core:dispatcher', 'warn', 'Could not send news to the lead', { meta: { error: err instanceof Error ? err.message : String(err) } });
    return kept('send_failed');
  } finally {
    const left = (inFlight.get(to) ?? 1) - 1;
    if (left > 0) inFlight.set(to, left); else inFlight.delete(to);
  }
}

/**
 * A queued delivery failed (refused, expired, or unknown). When it was news for
 * the lead, it goes to this computer's chat instead. True when it was news, so
 * the failure isn't also reported as a failed message.
 */
export async function newsDeliveryFailed(notice: AnnexDeliveryFailure): Promise<boolean> {
  const message = pending.get(notice.callId);
  if (!message) {
    // Refused while the call to the lead was still under way: that call keeps the news here itself.
    return notice.tool === 'send_message' && notice.callerId === getDispatcherAgentId() && inFlight.has(notice.targetId);
  }
  pending.delete(notice.callId);
  // Unknown: the lead may already have it, and showing it twice beats losing a question.
  const result = await deliverUpdateToChat(message);
  noteLocalNews(message.forward?.kind ?? 'needs_user');
  appLog('core:dispatcher', 'info', 'News the lead didn’t take went to this computer’s chat', { meta: { state: notice.state, outcome: result.outcome } });
  return true;
}

/**
 * On the lead: news a follower's controller sent, for this computer's
 * controller (the controller-to-controller rule, #2834). It reaches the
 * controller as a message from the follower's controller, rewritten from the
 * checked fields and named with the follower's computer as the pinned
 * connection names it, and the controller tells the person with tell_user,
 * as with any agent's news. `deliver` sends that message on as send_message.
 */
export async function receiveFollowerNews(
  machine: string, raw: unknown, deliver: (message: string) => Promise<AgentToolRunResult>,
): Promise<AgentToolRunResult> {
  const news = readForwardedNews(raw);
  if (!news) return refused('That news was not in a form this computer reads.', 'invalid_news');
  if (leadRole() !== 'lead') return refused('This computer’s Dispatcher isn’t the lead, so news goes to its own computer’s chat.', 'not_lead');
  return deliver(followerNewsMessage(news, hooks?.machineName(machine) ?? 'another computer'));
}

/** What the lead's controller is told: the news, who it's from, and how to pass it on. */
export function followerNewsMessage(news: ForwardedNews, machineName: string): string {
  const from = news.fromName ? `${news.fromName} on ${machineName}` : `${machineName}'s Dispatcher`;
  const kind = news.kind === 'check_in' ? 'routine' : news.kind;
  const back = news.kind === 'needs_user'
    ? ` When they answer, send it back to ${machineName}'s Dispatcher with send_message${news.request ? `, naming its request ${news.request}` : ''}.`
    : '';
  const what = news.kind === 'check_in' ? `${machineName}'s Dispatcher's check-in` : `News for the user from ${from}`;
  return `${what}, sent on by ${machineName}'s Dispatcher because this computer leads. `
    + `Tell the user with tell_user, kind ${kind}${news.kind === 'check_in' ? '' : `, from "${from}"`}.${back}\n\n${news.text}`;
}

function refused(text: string, reason: string): AgentToolRunResult {
  return { content: [{ type: 'text', text }], isError: true, annexDelivery: { state: 'refused', reason } };
}

/** Is this a follower's news, rather than an ordinary message? */
export function isForwardedNewsCall(tool: string, args: Record<string, unknown>): boolean {
  return tool === 'send_message' && args.news !== undefined;
}

/** For tests. */
export function _resetFollowerNewsForTesting(): void {
  hooks = undefined;
  localNews = { count: 0, needsUser: false };
  listeners.clear();
  pending.clear();
  inFlight.clear();
}
