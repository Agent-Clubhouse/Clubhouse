/**
 * Group project post notices (#3362): members hear about new posts when they
 * happen, as one short notice per burst, instead of spending turns polling.
 *
 * - **Who.** A post notifies the members subscribed to its topic (by default
 *   `general`, `control` and their own inbox; each member can add or remove
 *   topics), members named in it (`@name`), and the lead. Never its sender.
 *   Everyone else sees it at their next read.
 * - **Coalescing.** Posts to one member within {@link COALESCE_MS} of the first
 *   become one notice ("4 new messages in #release from lead, dev").
 * - **Rate limit.** At most {@link RATE_LIMIT_MAX} notices per member per
 *   {@link RATE_LIMIT_WINDOW_MS}. A notice over the limit is dropped; the next
 *   one says how many messages went unannounced.
 * - **Sleeping members** aren't woken. Their notices are held and merged into
 *   one summary, sent when they next connect.
 * - **Busy members** (a chat turn running) get the notice queued for the end
 *   of the turn, like an Action message (#3297). A newer notice replaces the
 *   queued one with a merged notice, so the turn ends to one notice.
 * - **Polling is legacy.** A group project with `pollingEnabled` keeps polling
 *   and gets no notices.
 *
 * Posts are read from the host's `board` changes: the message a post adds
 * carries that change's sequence number. In memory only: notices held for a
 * sleeping member don't survive a restart (the board does).
 */

import type { BulletinMessage, GroupProject, GroupProjectMembership } from '../../shared/group-project-types';
import { groupProjectHost } from './group-project-host';
import { getBulletinBoard } from './group-project-bulletin';
import { isAgentAlive } from './group-project-lifecycle';
import { getAgentRuntime } from './agent-runtime';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { buildToolName } from './clubhouse-mcp/tool-registry';
import { onAgentMcpConnected } from './clubhouse-mcp/connection-events';
import { isProjectAdmin } from '../../shared/group-project-admin';
import type { ChatSessionState } from '../../shared/chat';
import { ATTR } from '../../shared/telemetry/attributes';
import { tel } from '../telemetry/facade';
import { appLog } from './log-service';

export const COALESCE_MS = 15_000;
export const RATE_LIMIT_MAX = 6;
export const RATE_LIMIT_WINDOW_MS = 10 * 60_000;
/** After a sleeping member connects, before its summary, so the CLI has started. */
export const WAKE_SUMMARY_DELAY_MS = 3_000;

/** Topics every member hears about unless it unsubscribes. Its inbox is added per member. */
export const DEFAULT_SUBSCRIPTIONS = ['general', 'control'] as const;

const BUSY: ReadonlySet<ChatSessionState> = new Set(['starting', 'running', 'waiting_permission', 'waiting_input']);

interface Batch {
  count: number;
  /** Topic → messages, in first-seen order. */
  topics: Map<string, number>;
  senders: string[];
  mentioned: boolean;
}

interface MemberState {
  groupProjectId: string;
  agentId: string;
  window: Batch | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** A notice queued in a busy chat runtime, not delivered yet. */
  queued: Batch | null;
  /** Held while the member sleeps. */
  asleep: Batch | null;
  /** When notices were sent, for the rate limit. */
  sent: number[];
  /** Messages dropped by the rate limit since the last notice sent. */
  unannounced: number;
}

const members = new Map<string, MemberState>();
const keyOf = (groupProjectId: string, agentId: string) => `${groupProjectId}\u0000${agentId}`;

function stateOf(groupProjectId: string, agentId: string): MemberState {
  const key = keyOf(groupProjectId, agentId);
  let state = members.get(key);
  if (!state) {
    state = { groupProjectId, agentId, window: null, timer: null, queued: null, asleep: null, sent: [], unannounced: 0 };
    members.set(key, state);
  }
  return state;
}

function count(result: 'sent' | 'coalesced' | 'held_asleep' | 'rate_limited', n = 1): void {
  if (n > 0) tel.count('clubhouse.group.notices', n, [ATTR.noticeResult(result)]);
}

function emptyBatch(): Batch {
  return { count: 0, topics: new Map(), senders: [], mentioned: false };
}

function addMessage(batch: Batch, message: BulletinMessage, mentioned: boolean): void {
  batch.count++;
  batch.topics.set(message.topic, (batch.topics.get(message.topic) ?? 0) + 1);
  const sender = senderName(message.sender);
  if (!batch.senders.includes(sender)) batch.senders.push(sender);
  batch.mentioned ||= mentioned;
}

export function mergeBatches(a: Batch, b: Batch): Batch {
  const out: Batch = { count: a.count + b.count, topics: new Map(a.topics), senders: [...a.senders], mentioned: a.mentioned || b.mentioned };
  for (const [topic, n] of b.topics) out.topics.set(topic, (out.topics.get(topic) ?? 0) + n);
  for (const s of b.senders) if (!out.senders.includes(s)) out.senders.push(s);
  return out;
}

/** `name@Group Project` → `name`; the UI's own posts are the user's. */
function senderName(sender: string): string {
  if (sender === 'user') return 'the user';
  return sender.split('@')[0] || sender;
}

// ── Who hears about a post ──────────────────────────────────────────────────

/** The topics a member is subscribed to: the defaults and its inbox, with its own changes. */
export function memberSubscriptions(membership: GroupProjectMembership, address: string, inbox: string): Set<string> {
  const own = membership.subscriptions?.[address];
  const topics = new Set<string>([...DEFAULT_SUBSCRIPTIONS, inbox]);
  for (const t of own?.add ?? []) topics.add(t.toLowerCase());
  for (const t of own?.remove ?? []) topics.delete(t.toLowerCase());
  return topics;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether a post names this member as `@name`. */
export function mentions(body: string, name: string): boolean {
  if (!name) return false;
  return new RegExp(`(^|[^\\w@])@${escapeRegExp(name)}(?![\\w-])`, 'i').test(body);
}

/** The lead, until #3360's grants: an admin of the group project. */
function isLead(gp: GroupProject, agentId: string): boolean {
  return isProjectAdmin(gp.metadata, agentId);
}

/** Whether the group project still uses polling, the legacy delivery. */
export function usesPolling(gp: GroupProject): boolean {
  return gp.metadata?.pollingEnabled === true;
}

async function onPost(gp: GroupProject, message: BulletinMessage): Promise<void> {
  if (message.sender === 'system' || message.topic === 'system' || usesPolling(gp)) return;
  const [resolved, membership] = await Promise.all([groupProjectHost.resolveMembers(gp.id), groupProjectHost.getMembership(gp.id)]);
  const from = senderName(message.sender).toLowerCase();
  for (const member of resolved) {
    // Agents on other machines hear about posts over the network (#3363).
    if (member.address.includes('@')) continue;
    if (member.name.toLowerCase() === from) continue;
    const inbox = await groupProjectHost.inboxFor(gp.id, member.name, member.address);
    const mentioned = mentions(message.body, member.name);
    const subscribed = memberSubscriptions(membership, member.address, inbox).has(message.topic);
    if (!subscribed && !mentioned && !isLead(gp, member.address)) continue;
    const state = stateOf(gp.id, member.address);
    if (!state.window) {
      state.window = emptyBatch();
      state.timer = setTimeout(() => { void flush(state); }, COALESCE_MS);
    }
    addMessage(state.window, message, mentioned);
  }
}

// ── Delivery ────────────────────────────────────────────────────────────────

async function flush(state: MemberState): Promise<void> {
  const batch = state.window;
  state.window = null;
  state.timer = null;
  if (!batch) return;
  count('coalesced', batch.count - 1);
  if (!isAgentAlive(state.agentId) || !getAgentRuntime(state.agentId)?.isRunning()) {
    state.asleep = state.asleep ? mergeBatches(state.asleep, batch) : batch;
    count('held_asleep');
    return;
  }
  const now = Date.now();
  state.sent = state.sent.filter((at) => now - at < RATE_LIMIT_WINDOW_MS);
  if (state.sent.length >= RATE_LIMIT_MAX) {
    state.unannounced += batch.count;
    count('rate_limited');
    return;
  }
  await deliver(state, batch);
}

async function deliver(state: MemberState, batch: Batch): Promise<void> {
  const runtime = getAgentRuntime(state.agentId);
  const gp = await groupProjectHost.get(state.groupProjectId);
  if (!runtime || !gp) return;
  const busy = runtime.kind === 'chat' && BUSY.has(runtime.getState());
  // A notice still waiting for the turn to end is replaced by one covering both.
  const replacing = busy && !!state.queued;
  const notice = replacing ? mergeBatches(state.queued!, batch) : batch;
  if (replacing) count('coalesced');
  const text = noticeText(gp, state, notice);
  // Replacing a queued notice sends nothing more to the member: not counted against the limit.
  if (!replacing) state.sent.push(Date.now());
  state.unannounced = 0;
  try {
    if (busy) {
      state.queued = notice;
      await runtime.sendMessage(text, {
        source: 'group_project',
        delivery: 'queued',
        routed: [{ fromClubhouse: true, text }],
        actionQueue: {
          actionId: `group-project:${gp.id}`,
          latestOnly: true,
          onSettled: (settled) => { if (settled !== 'replaced' && state.queued === notice) state.queued = null; },
        },
      });
    } else {
      await runtime.sendMessage(text, { source: 'group_project', routed: [{ fromClubhouse: true, text }] });
    }
    if (!replacing) count('sent');
  } catch (err) {
    // telemetry-exempt: the member reads the board at its next turn; logged for diagnosis
    if (state.queued === notice) state.queued = null;
    appLog('core:group-project', 'warn', 'Group project notice not delivered', {
      meta: { groupProjectId: gp.id, agentId: state.agentId, error: err instanceof Error ? err.message : String(err) },
    });
  }
}

function topicList(batch: Batch): string {
  const topics = [...batch.topics.entries()];
  if (topics.length === 1) return `#${topics[0][0]}`;
  const shown = topics.slice(0, 3).map(([topic, n]) => `#${topic} (${n})`);
  return topics.length > 3 ? `${shown.join(', ')} and ${topics.length - 3} more` : shown.join(', ');
}

function senderList(batch: Batch): string {
  const shown = batch.senders.slice(0, 3).join(', ');
  return batch.senders.length > 3 ? `${shown} and ${batch.senders.length - 3} others` : shown;
}

/** The notice text, e.g. `4 new messages in #release from lead, dev.` */
export function noticeText(gp: GroupProject, state: Pick<MemberState, 'agentId' | 'unannounced'>, batch: Batch): string {
  const binding = bindingManager.getBindingsForAgent(state.agentId).find((b) => b.targetId === gp.id && b.targetKind === 'group-project');
  const readTool = binding ? buildToolName(binding, 'read_topic') : 'read_topic';
  const what = batch.count === 1 ? '1 new message' : `${batch.count} new messages`;
  const lines = [
    `[Group project “${gp.name}”] ${what} in ${topicList(batch)} from ${senderList(batch)}.`,
    ...(batch.mentioned ? ['You were mentioned.'] : []),
    ...(state.unannounced > 0 ? [`${state.unannounced} earlier ${state.unannounced === 1 ? 'message was' : 'messages were'} not announced.`] : []),
    `Read them with ${readTool} when it fits your work.`,
  ];
  return lines.join('\n');
}

/** A sleeping member connected: send what it missed as one summary. */
function onConnected(agentId: string): void {
  for (const state of members.values()) {
    if (state.agentId !== agentId || !state.asleep) continue;
    setTimeout(() => {
      const held = state.asleep;
      state.asleep = null;
      if (held) void deliver(state, held);
    }, WAKE_SUMMARY_DELAY_MS);
  }
}

// ── Wiring ──────────────────────────────────────────────────────────────────

/** The message a board change added: the one carrying the change's sequence number. */
async function postedMessage(groupProjectId: string, seq: number): Promise<BulletinMessage | undefined> {
  const recent = await getBulletinBoard(groupProjectId).getAllMessages(undefined, 50);
  return recent.find((m) => m.seq === seq);
}

let stop: (() => void) | null = null;

/** Start notifying members of posts. Returns the stop. */
export function watchGroupProjectDelivery(): () => void {
  if (stop) return stop;
  const offChange = groupProjectHost.onChange((change) => {
    if (change.part === 'deleted') {
      for (const [key, state] of members) {
        if (state.groupProjectId !== change.groupProjectId) continue;
        if (state.timer) clearTimeout(state.timer);
        members.delete(key);
      }
      return;
    }
    if (change.part !== 'board') return;
    void (async () => {
      const message = await postedMessage(change.groupProjectId, change.seq);
      const gp = message && await groupProjectHost.get(change.groupProjectId);
      if (message && gp) await onPost(gp, message);
    })().catch((err) => {
      // telemetry-exempt: a missed notice leaves the post on the board; logged
      appLog('core:group-project', 'warn', 'Group project notice failed', {
        meta: { groupProjectId: change.groupProjectId, error: err instanceof Error ? err.message : String(err) },
      });
    });
  });
  const offConnected = onAgentMcpConnected(onConnected);
  stop = () => {
    offChange();
    offConnected();
    for (const state of members.values()) if (state.timer) clearTimeout(state.timer);
    members.clear();
    stop = null;
  };
  return stop;
}

// ── Subscriptions ───────────────────────────────────────────────────────────

/** Subscribe a member to a topic's notices, or unsubscribe it. Returns its topics now. */
export async function setTopicSubscription(groupProjectId: string, agentId: string, name: string, topic: string, on: boolean): Promise<string[]> {
  const canonical = topic.trim().toLowerCase();
  const { membership } = await groupProjectHost.updateMembership(groupProjectId, (draft) => {
    const own = { add: [...(draft.subscriptions?.[agentId]?.add ?? [])], remove: [...(draft.subscriptions?.[agentId]?.remove ?? [])] };
    own.add = own.add.filter((t) => t !== canonical);
    own.remove = own.remove.filter((t) => t !== canonical);
    (on ? own.add : own.remove).push(canonical);
    draft.subscriptions = { ...draft.subscriptions, [agentId]: own };
  });
  const inbox = await groupProjectHost.inboxFor(groupProjectId, name, agentId);
  return [...memberSubscriptions(membership, agentId, inbox)].sort();
}

/** A member's subscribed topics. */
export async function listTopicSubscriptions(groupProjectId: string, agentId: string, name: string): Promise<string[]> {
  const [membership, inbox] = await Promise.all([groupProjectHost.getMembership(groupProjectId), groupProjectHost.inboxFor(groupProjectId, name, agentId)]);
  return [...memberSubscriptions(membership, agentId, inbox)].sort();
}

/** For tests. */
export function _resetDeliveryForTesting(): void {
  stop?.();
  members.clear();
}
