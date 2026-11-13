/**
 * A follower's news goes to the lead (#3352). On a computer following
 * another's lead, what this Dispatcher's triage would show in its own chat now
 * (an agent's question for the person, the answer to a request, a check-in)
 * goes to the lead's chat instead, over the controller link (#3345) as a
 * `send_message` carrying the news as fields. The lead puts it in its chat
 * itself, labelled with this computer as its pinned connection names it, never
 * as the text says. While the lead is offline, or the link isn't there, it
 * stays in this computer's own chat, readable from the follower pane.
 *
 * News never answers anything: it only reaches the person, who answers in the
 * lead's chat, which passes the answer on as any request.
 */

import { formatAgentAddress } from '../../shared/agent-address';
import { appLog } from './log-service';
import { forwardAgentCall, type AgentToolRunResult } from './annex-agent-calls';
import { remoteFederationController } from './dispatcher-federation';
import { isFollowingLead, leadRecord, leadRole } from './dispatcher-federation-lead';
import { getDispatcherAgentId } from './dispatcher/dispatcher-service';
import type { ForwardedNews } from './dispatcher/dispatcher-news';
import { deliverForwardedNews } from './dispatcher/dispatcher-channel';

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
 * Sends news to the lead's controller link. True when it went, so this
 * computer's chat doesn't show it too; false to show it here.
 */
export async function forwardNewsToLead(news: ForwardedNews): Promise<boolean> {
  if (!hooks || !isFollowingLead()) return false;
  const lead = leadRecord().lead;
  const local = getDispatcherAgentId();
  if (!lead || !local || !hooks.connected(lead)) return false;
  const controller = remoteFederationController(lead);
  if (!controller?.agentId || !controller.enabled) return false;
  const to = formatAgentAddress({ agentId: controller.agentId, machine: lead });
  const summary = news.fromName ? `News from ${news.fromName}: ${news.text}` : news.text;
  try {
    const result = await forwardAgentCall(local, to, controller.name, 'send_message', { message: summary, news });
    if (result.isError) {
      appLog('core:dispatcher', 'info', 'News stayed on this computer: the lead refused it', { meta: { kind: news.kind } });
      return false;
    }
    return true;
  } catch (err) {
    // telemetry-exempt: logged; the news shows in this computer's chat instead.
    appLog('core:dispatcher', 'warn', 'Could not send news to the lead', { meta: { error: err instanceof Error ? err.message : String(err) } });
    return false;
  }
}

/**
 * On the lead: news a follower's controller sent. Shown in this chat under the
 * follower's name for its computer, from the authenticated connection.
 */
export async function receiveFollowerNews(machine: string, raw: unknown): Promise<AgentToolRunResult> {
  const news = readForwardedNews(raw);
  if (!news) return refused('That news was not in a form this computer reads.');
  if (leadRole() !== 'lead') return refused('This computer’s Dispatcher isn’t the lead, so news goes to its own computer’s chat.');
  const name = hooks?.machineName(machine) ?? 'another computer';
  const result = await deliverForwardedNews(news, name);
  if (result.outcome !== 'delivered' && result.outcome !== 'started') return refused(result.error ?? 'The lead’s chat couldn’t take it.');
  return { content: [{ type: 'text', text: 'The lead’s chat has it.' }] };
}

function refused(text: string): AgentToolRunResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Is this a follower's news, rather than an ordinary message? */
export function isForwardedNewsCall(tool: string, args: Record<string, unknown>): boolean {
  return tool === 'send_message' && args.news !== undefined;
}
