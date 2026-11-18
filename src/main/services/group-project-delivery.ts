/**
 * Group project post notices (#3362): members hear about new posts when they
 * happen, as one short notice per burst, instead of spending turns polling.
 *
 * - **Who.** A post notifies the members subscribed to its topic (by default
 *   `general`, `control` and their own inbox; each member can add or remove
 *   topics), members named in it (`@name`), and the lead. Never its sender,
 *   by address when the post came through `post_bulletin`.
 *   Everyone else sees it at their next read.
 * - **Coalescing.** Posts to one member within {@link COALESCE_MS} of the first
 *   become one notice ("4 new messages in general from lead, dev").
 * - **Rate limit.** At most {@link RATE_LIMIT_MAX} notices per member per
 *   {@link RATE_LIMIT_WINDOW_MS}. Posts over the limit wait, merged, and go as
 *   one trailing notice when the window frees: nothing is dropped.
 * - **Sleeping members** resume for direct inbox posts and mentions when
 *   permitted. Unread notices are recovered from persisted board sequence receipts.
 * - **Busy members** (a chat turn running) get the notice queued for the end
 *   of the turn, like an Action message (#3297). A newer notice replaces the
 *   queued one with a merged notice, so the turn ends to one notice. A
 *   terminal agent's turn can't be seen from here, so it gets the notice typed
 *   in as it comes.
 * - **Urgent posts** bypass batching and notice limits, using the same turn-end queue.
 *
 * Every notice is checked again when it goes: the member must still be one,
 * and the group project must still be on notices.
 *
 * Notice text is built from a fixed template. Names that come from agents or
 * people (topics, senders, the group project's name) are cleaned and quoted,
 * and only the fixed template is marked as from Clubhouse in chat.
 *
 * Posts are read from the host's `board` changes: the message a post adds
 * carries that change's sequence number. In memory only: notices held for a
 * sleeping or rate-limited member don't survive a restart (the board does).
 */

import type { BulletinMessage, GroupProject, GroupProjectMembership } from '../../shared/group-project-types';
import { resolveMentions } from '../../shared/group-project-mentions';
import { groupProjectMentionMembers } from './group-project-tool-members';
import { lastNotified, markNotified } from './group-project-notification-store';
import { wakeForGroupPost } from './group-project-wake';
import { groupProjectHost } from './group-project-host';
import { isAgentAlive } from './group-project-lifecycle';
import { getAgentRuntime } from './agent-runtime';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { buildToolName } from './clubhouse-mcp/tool-registry';
import { onAgentMcpConnected } from './clubhouse-mcp/connection-events';
import { groupProjectMay, roleModeOf } from './group-project-roles';
import type { ChatSessionState } from '../../shared/chat';
import { ATTR } from '../../shared/telemetry/attributes';
import { tel } from '../telemetry/facade';
import { appLog } from './log-service';

export const COALESCE_MS = 15_000;
export const RATE_LIMIT_MAX = 6;
export const RATE_LIMIT_WINDOW_MS = 10 * 60_000;
/** After a sleeping member connects, before its summary, so the CLI has started. */
export const WAKE_SUMMARY_DELAY_MS = 3_000;
/** At most this many topics a member subscribes to beyond the defaults. */
export const MAX_SUBSCRIPTIONS = 50;

/** Topics every member hears about unless it unsubscribes. Its inbox is added per member. */
export const DEFAULT_SUBSCRIPTIONS = ['general', 'control'] as const;

/** A name an agent may give a new channel: lowercase letters, digits, dot, dash, underscore. */
export const TOPIC_NAME = /^[a-z0-9._-]{1,64}$/;

/** A turn is running: `starting` sends at once, so it isn't one. */
const BUSY: ReadonlySet<ChatSessionState> = new Set(['running', 'waiting_permission', 'waiting_input']);

interface NoticeMessage {
  id: string;
  topic: string;
  sender: string;
  senderAddress?: string;
  mentioned: boolean;
  seq?: number;
  urgent?: boolean;
  direct?: boolean;
}

interface Batch {
  messages: NoticeMessage[];
}

interface MemberState {
  groupProjectId: string;
  agentId: string;
  name: string;
  window: Batch | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** A notice queued in a busy chat runtime, not delivered yet, and its message id there. */
  queued: Batch | null;
  queuedMessageId?: string;
  /** Held while the member sleeps. */
  asleep: Batch | null;
  /** Held by the rate limit, sent when the window frees. */
  deferred: Batch | null;
  deferTimer: ReturnType<typeof setTimeout> | null;
  wakeTimer: ReturnType<typeof setTimeout> | null;
  /** When notices were sent, for the rate limit. */
  sent: number[];
  work: Promise<void>;
}

const members = new Map<string, MemberState>();
const keyOf = (groupProjectId: string, agentId: string) => `${groupProjectId}\u0000${agentId}`;

function stateOf(groupProjectId: string, agentId: string, name: string): MemberState {
  const key = keyOf(groupProjectId, agentId);
  let state = members.get(key);
  if (!state) {
    state = { groupProjectId, agentId, name, window: null, timer: null, queued: null, asleep: null, deferred: null, deferTimer: null, wakeTimer: null, sent: [], work: Promise.resolve() };
    members.set(key, state);
  }
  state.name = name;
  return state;
}

function clearTimers(state: MemberState): void {
  for (const timer of [state.timer, state.deferTimer, state.wakeTimer]) if (timer) clearTimeout(timer);
  state.timer = state.deferTimer = state.wakeTimer = null;
}

function count(result: 'sent' | 'coalesced' | 'held_asleep' | 'rate_limited', n = 1): void {
  if (n > 0) tel.count('clubhouse.group.notices', n, [ATTR.noticeResult(result)]);
}

function merge(a: Batch | null, b: Batch): Batch {
  if (!a) return b;
  const seen = new Set(a.messages.map((m) => m.id));
  return { messages: [...a.messages, ...b.messages.filter((m) => !seen.has(m.id))] };
}

// ── Senders ─────────────────────────────────────────────────────────────────

/** Message id → the agent that posted it through post_bulletin. Kept briefly, for the coalescing window. */
const senderAddresses = new Map<string, { address: string; at: number }>();
const SENDER_TTL_MS = 10 * 60_000;

/** post_bulletin says who posted, so the sender is left out by address, not by name. */
export function noteSenderAddress(messageId: string, address: string): void {
  const now = Date.now();
  for (const [id, entry] of senderAddresses) if (now - entry.at > SENDER_TTL_MS) senderAddresses.delete(id);
  senderAddresses.set(messageId, { address, at: now });
}

/** Whether a message is this member's own post. */
function isOwnPost(message: Pick<NoticeMessage, 'id' | 'sender' | 'senderAddress'>, state: MemberState, gp: GroupProject): boolean {
  if (message.senderAddress) return groupProjectHost.localAgentId(gp, message.senderAddress) === state.agentId;
  const localSender = senderAddresses.get(message.id)?.address;
  if (localSender) return localSender === state.agentId;
  // Old replicas lack author identity. Names cannot disambiguate computers:
  // prefer an occasional duplicate own-post notice to losing a teammate's post.
  if (gp.network?.role === 'replica' || gp.scope?.reach === 'network') return false;
  return senderName(message.sender).toLowerCase() === state.name.toLowerCase();
}

/** `name@Group Project` → `name`; the UI's own posts are the user's. */
function senderName(sender: string): string {
  if (sender === 'user') return 'the user';
  return sender.split('@')[0] || sender;
}

// ── Who hears about a post ──────────────────────────────────────────────────

/** A channel name as stored, or null when it isn't one an agent may create. */
export function validTopic(topic: string): string | null {
  const canonical = topic.trim().toLowerCase();
  return TOPIC_NAME.test(canonical) ? canonical : null;
}

/**
 * A channel an agent may post to or subscribe to, as stored: one that already
 * exists, any inbox, or a new one with a plain name. Null for a new channel
 * whose name isn't plain, since names appear in other members' notices.
 */
export async function usableTopic(groupProjectId: string, topic: string): Promise<string | null> {
  const canonical = topic.trim().toLowerCase();
  if (!canonical) return null;
  if (TOPIC_NAME.test(canonical) || canonical.startsWith('inbox-')) return canonical;
  const existing = await groupProjectHost.readDigest(groupProjectId);
  return existing.some((t) => t.topic === canonical) ? canonical : null;
}

export const NEW_CHANNEL_NAME_MESSAGE = 'New channel names use lowercase letters, digits, dots, dashes and underscores, up to 64 characters.';

/** The topics a member is subscribed to: the defaults and its inbox, with its own changes. */
export function memberSubscriptions(membership: GroupProjectMembership, address: string, inbox: string): Set<string> {
  const own = membership.subscriptions?.[address];
  const topics = new Set<string>([...DEFAULT_SUBSCRIPTIONS, inbox]);
  for (const t of own?.add ?? []) topics.add(t.toLowerCase());
  for (const t of own?.remove ?? []) topics.delete(t.toLowerCase());
  return topics;
}

/** Compatibility helper; all parsing is shared with the board tools. */
export function mentions(body: string, name: string): boolean {
  return resolveMentions(body, [{ name, address: name }]).addresses.has(name);
}

/** The lead: an agent granted lead on this group project, Allow or Ask first (#3360). */
function isLead(gp: GroupProject, agentId: string): boolean {
  return roleModeOf(agentId, gp.id, 'lead') !== 'off';
}

async function onPost(gp: GroupProject, message: BulletinMessage): Promise<void> {
  if (message.sender === 'system' || message.topic === 'system') return;
  // Delivering is the group project's own action, under its own grant (#3360).
  if (!groupProjectMay(gp, 'deliver')) {
    appLog('core:group-project', 'debug', 'Post notices are off for this group project', { meta: { groupProjectId: gp.id } });
    return;
  }
  const [resolved, membership, mentionMembers] = await Promise.all([groupProjectHost.resolveMembers(gp.id), groupProjectHost.getMembership(gp.id), groupProjectMentionMembers(gp.id)]);
  const mentionedAddresses = resolveMentions(message.body, mentionMembers).addresses;
  forgetFormerMembers(gp, resolved);
  for (const member of resolved) {
    // Each computer tells its own agents (#3363): the host's, and on a copy this computer's,
    // which hears of the post when the host tells it the group project changed.
    const agentId = groupProjectHost.localAgentId(gp, member.address);
    if (!agentId) continue;
    const inbox = await groupProjectHost.inboxFor(gp.id, member.name, member.address);
    const mentioned = mentionedAddresses.has(member.address);
    const subscribed = memberSubscriptions(membership, member.address, inbox).has(message.topic);
    if (!subscribed && !mentioned && !isLead(gp, member.address)) continue;
    const state = stateOf(gp.id, agentId, member.name);
    if (isOwnPost(message, state, gp)) continue;
    if ((message.seq ?? 0) <= await lastNotified(gp.id, agentId) && message.seq !== undefined) continue;
    if (!state.window) {
      state.window = { messages: [] };
      state.timer = setTimeout(() => { void flush(state).catch(logReceiptFailure); }, COALESCE_MS);
    }
    state.window.messages.push({ id: message.id, topic: message.topic, sender: message.sender, senderAddress: message.senderAddress, mentioned, seq: message.seq, urgent: message.urgent, direct: mentioned || message.topic === inbox });
    if (message.urgent) {
      if (state.timer) clearTimeout(state.timer);
      void flush(state).catch(logReceiptFailure);
    }
  }
}

// ── Delivery ────────────────────────────────────────────────────────────────

/** Whether a notice may still go: the group project is on notices, and the agent is still a member. */
async function stillMember(state: MemberState): Promise<GroupProject | null> {
  const gp = await groupProjectHost.get(state.groupProjectId);
  if (!gp || !groupProjectMay(gp, 'deliver')) return null;
  const resolved = await groupProjectHost.resolveMembers(gp.id);
  return resolved.some((m) => groupProjectHost.localAgentId(gp, m.address) === state.agentId) ? gp : null;
}

function forget(state: MemberState): void {
  clearTimers(state);
  members.delete(keyOf(state.groupProjectId, state.agentId));
  // A notice still waiting for an ex-member's turn to end is taken back.
  if (state.queued && state.queuedMessageId) {
    void getAgentRuntime(state.agentId)?.removeQueued?.([state.queuedMessageId]).catch((err: unknown) => {
      // telemetry-exempt: the notice stays queued and is harmless; logged
      appLog('core:group-project', 'warn', 'Could not take back a queued notice', { meta: { agentId: state.agentId, error: err instanceof Error ? err.message : String(err) } });
    });
  }
  state.queued = null;
}

/** Drop what's held for agents no longer in the group project, taking back a queued notice. */
function forgetFormerMembers(gp: GroupProject, resolved: ReadonlyArray<{ address: string }>): void {
  const current = new Set(resolved.map((m) => groupProjectHost.localAgentId(gp, m.address)));
  for (const state of [...members.values()]) {
    if (state.groupProjectId === gp.id && !current.has(state.agentId)) forget(state);
  }
}

function serialize(state: MemberState, task: () => Promise<void>): Promise<void> {
  const next = state.work.catch(logReceiptFailure).then(task);
  state.work = next;
  return next;
}

function flush(state: MemberState): Promise<void> {
  return serialize(state, () => flushNow(state));
}

async function flushNow(state: MemberState): Promise<void> {
  const window = state.window;
  state.window = null;
  state.timer = null;
  if (!window) return;
  const gp = await stillMember(state);
  if (!gp) { forget(state); return; }
  let batch: Batch = merge(state.asleep, { messages: window.messages.filter((m) => !isOwnPost(m, state, gp)) });
  state.asleep = null;
  if (batch.messages.length === 0) return;
  if (!(await stillMember(state))) { forget(state); return; }
  count('coalesced', batch.messages.length - 1);
  if (!isAgentAlive(state.agentId) || !getAgentRuntime(state.agentId)?.isRunning()) {
    batch = merge(merge(state.queued, state.deferred ?? { messages: [] }), batch);
    state.queued = state.deferred = null;
    if (state.deferTimer) clearTimeout(state.deferTimer);
    state.deferTimer = null;
    state.asleep = merge(state.asleep, batch);
    if (batch.messages.some((m) => m.direct)) {
      const { text, routed } = noticeParts(gp, state, batch);
      if (await wakeForGroupPost(gp.id, state.agentId, state.name, text, routed, batch.messages.filter((m) => m.direct).map((m) => m.senderAddress))) {
        state.asleep = null;
        await acknowledge(state, batch);
        return;
      }
    }
    count('held_asleep');
    return;
  }
  await send(state, batch);
}

/** Send now, or hold for the rate limit's window to free. */
async function send(state: MemberState, batch: Batch): Promise<void> {
  if (batch.messages.some((m) => m.urgent)) {
    const all = merge(merge(state.deferred, state.window ?? { messages: [] }), batch);
    state.deferred = state.window = null;
    if (state.timer) clearTimeout(state.timer);
    if (state.deferTimer) clearTimeout(state.deferTimer);
    state.timer = state.deferTimer = null;
    await deliver(state, all);
    return;
  }
  const now = Date.now();
  state.sent = state.sent.filter((at) => now - at < RATE_LIMIT_WINDOW_MS);
  // A notice still queued for the turn's end is replaced, not added: no new notice for the limit.
  const replacing = !!state.queued && isBusy(state.agentId);
  if (!replacing && (state.deferred || state.sent.length >= RATE_LIMIT_MAX)) {
    state.deferred = merge(state.deferred, batch);
    count('rate_limited');
    if (!state.deferTimer) {
      const frees = Math.max(0, (state.sent[0] ?? now) + RATE_LIMIT_WINDOW_MS - now);
      state.deferTimer = setTimeout(() => {
        state.deferTimer = null;
        const held = state.deferred;
        state.deferred = null;
        if (held) void serialize(state, () => deliver(state, held)).catch(logReceiptFailure);
      }, frees);
    }
    return;
  }
  await deliver(state, batch);
}

function isBusy(agentId: string): boolean {
  const runtime = getAgentRuntime(agentId);
  return !!runtime && runtime.kind === 'chat' && BUSY.has(runtime.getState());
}

async function acknowledge(state: MemberState, batch: Batch): Promise<void> {
  const seq = Math.max(0, ...batch.messages.map((m) => m.seq ?? 0));
  if (seq) await markNotified(state.groupProjectId, state.agentId, seq);
}

async function deliver(state: MemberState, batch: Batch): Promise<void> {
  const gp = await stillMember(state);
  if (!gp) { forget(state); return; }
  const runtime = getAgentRuntime(state.agentId);
  if (!runtime?.isRunning()) {
    state.asleep = merge(state.asleep, batch);
    count('held_asleep');
    return;
  }
  const busy = isBusy(state.agentId);
  const replacing = busy && !!state.queued;
  const notice = replacing ? merge(state.queued, batch) : batch;
  if (replacing) count('coalesced');
  const { text, routed } = noticeParts(gp, state, notice);
  if (!replacing) state.sent.push(Date.now());
  try {
    if (busy) {
      state.queued = notice;
      const result = await runtime.sendMessage(text, {
        source: 'group_project',
        delivery: 'queued',
        routed,
        actionQueue: {
          actionId: `group-project:${gp.id}`,
          latestOnly: true,
          onSettled: (settled) => {
            if (settled === 'delivered') void acknowledge(state, notice).catch(logReceiptFailure);
            else if ((settled === 'expired' || settled === 'dropped') && members.get(keyOf(gp.id, state.agentId)) === state) state.asleep = merge(state.asleep, notice);
            if (settled !== 'replaced' && state.queued === notice) state.queued = null;
          },
        },
      });
      // The turn ended first: the runtime sent it now, and no receipt will come.
      if (result.delivery !== 'queued' && state.queued === notice) { state.queued = null; await acknowledge(state, notice); }
      else if (state.queued === notice) state.queuedMessageId = result.messageId;
    } else {
      state.queued = null;
      await runtime.sendMessage(text, { source: 'group_project', routed });
      await acknowledge(state, notice);
    }
    if (!replacing) count('sent');
  } catch (err) {
    // telemetry-exempt: held unread for retry and logged for diagnosis
    state.asleep = merge(state.asleep, notice);
    if (state.queued === notice) state.queued = null;
    appLog('core:group-project', 'warn', 'Group project notice not delivered', {
      meta: { groupProjectId: gp.id, agentId: state.agentId, error: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── Text ────────────────────────────────────────────────────────────────────

/** A name from an agent or person, safe inside a notice: one line, short, quoted. */
export function quoted(value: string, max = 60): string {
  const flat = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, ' ').trim();
  const short = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return JSON.stringify(short);
}

function topicList(batch: Batch): string {
  const byTopic = new Map<string, number>();
  for (const m of batch.messages) byTopic.set(m.topic, (byTopic.get(m.topic) ?? 0) + 1);
  const topics = [...byTopic.entries()];
  if (topics.length === 1) return quoted(topics[0][0]);
  const shown = topics.slice(0, 3).map(([topic, n]) => `${quoted(topic)} (${n})`);
  return topics.length > 3 ? `${shown.join(', ')} and ${topics.length - 3} more` : shown.join(', ');
}

function senderList(batch: Batch): string {
  const senders: string[] = [];
  for (const m of batch.messages) {
    const name = senderName(m.sender);
    if (!senders.includes(name)) senders.push(name);
  }
  const shown = senders.slice(0, 3).map((s) => quoted(s, 40)).join(', ');
  return senders.length > 3 ? `${shown} and ${senders.length - 3} others` : shown;
}

/**
 * What the member gets, and what chat shows. Only the fixed sentence is
 * marked as from Clubhouse; the details (with names cleaned and quoted) are
 * shown as plain text beside it.
 */
export function noticeParts(gp: GroupProject, state: Pick<MemberState, 'agentId'>, batch: Batch): { text: string; routed: Array<{ fromClubhouse?: boolean; text: string }> } {
  const binding = bindingManager.getBindingsForAgent(state.agentId).find((b) => b.targetId === gp.id && b.targetKind === 'group-project');
  const readTool = binding ? buildToolName(binding, 'read_topic') : 'read_topic';
  const n = batch.messages.length;
  const what = n === 1 ? '1 new message' : `${n} new messages`;
  const details = [
    `${what} in ${topicList(batch)} from ${senderList(batch)}, in group project ${quoted(gp.name)}.`,
    ...(batch.messages.some((m) => m.mentioned) ? ['You were mentioned.'] : []),
    `Read them with ${readTool} when it fits your work.`,
  ].join('\n');
  const header = batch.messages.some((m) => m.urgent) ? 'Urgent Clubhouse group project notice.' : 'Clubhouse group project notice.';
  return { text: `${header}\n${details}`, routed: [{ fromClubhouse: true, text: header }, { text: details }] };
}

/** A sleeping member connected: send what it missed as one summary. */
function logReceiptFailure(err: unknown): void {
  // telemetry-exempt: the board remains unread and a later connection retries
  appLog('core:group-project', 'warn', 'Could not save group project notice receipt', { meta: { error: String(err) } });
}

function onConnected(agentId: string): void {
  void (async () => {
    for (const gp of await groupProjectHost.list()) {
      if (!groupProjectMay(gp, 'deliver')) continue;
      const resolved = await groupProjectHost.resolveMembers(gp.id);
      const member = resolved.find((m) => groupProjectHost.localAgentId(gp, m.address) === agentId);
      if (!member) continue;
      const state = stateOf(gp.id, agentId, member.name);
      if (state.wakeTimer) continue;
      state.wakeTimer = setTimeout(() => {
        state.wakeTimer = null;
        void serialize(state, async () => {
          const cursor = await lastNotified(gp.id, agentId);
          const [posts, membership, inbox, mentionMembers] = await Promise.all([
            groupProjectHost.readAll(gp.id, undefined, Number.MAX_SAFE_INTEGER), groupProjectHost.getMembership(gp.id),
            groupProjectHost.inboxFor(gp.id, member.name, member.address), groupProjectMentionMembers(gp.id),
          ]);
          const subscriptions = memberSubscriptions(membership, member.address, inbox);
          const messages = posts.filter((m) => m.seq !== undefined && m.seq > cursor && m.sender !== 'system' && m.topic !== 'system')
            .map((m) => ({ ...m, mentioned: resolveMentions(m.body, mentionMembers).addresses.has(member.address) }))
            .filter((m) => !isOwnPost(m, state, gp) && (subscriptions.has(m.topic) || m.mentioned || isLead(gp, member.address)));
          state.asleep = null;
          // Replace unflushed memory with the authoritative unread board snapshot.
          if (state.timer) clearTimeout(state.timer);
          state.timer = null;
          const through = Math.max(0, ...posts.map((m) => m.seq ?? 0));
          const newer = state.window?.messages.filter((m) => (m.seq ?? 0) > through) ?? [];
          state.window = newer.length ? { messages: newer } : null;
          if (state.window) state.timer = setTimeout(() => { void flush(state).catch(logReceiptFailure); }, COALESCE_MS);
          if (messages.length) await send(state, { messages });
        }).catch(logReceiptFailure);
      }, WAKE_SUMMARY_DELAY_MS);
    }
  })().catch(logReceiptFailure);
}

// ── Wiring ──────────────────────────────────────────────────────────────────

/** The message a board change added: the one carrying the change's sequence number. */
async function postedMessage(groupProjectId: string, seq: number): Promise<BulletinMessage | undefined> {
  const recent = await groupProjectHost.readAll(groupProjectId, undefined, Number.MAX_SAFE_INTEGER);
  return recent.find((m) => m.seq === seq);
}

let stop: (() => void) | null = null;
let changes: Promise<void> = Promise.resolve();

/** Start notifying members of posts. Returns the stop. */
export function watchGroupProjectDelivery(): () => void {
  if (stop) return stop;
  const offChange = groupProjectHost.onChange((change) => {
    if (change.part === 'deleted') {
      for (const state of [...members.values()]) if (state.groupProjectId === change.groupProjectId) forget(state);
      return;
    }
    if (change.part === 'membership' || change.part === 'record') {
      // Members left, or the group project stopped delivering.
      void (async () => {
        const gp = await groupProjectHost.get(change.groupProjectId);
        const resolved = gp && groupProjectMay(gp, 'deliver') ? await groupProjectHost.resolveMembers(gp.id) : [];
        if (gp) forgetFormerMembers(gp, resolved);
        else for (const state of [...members.values()]) if (state.groupProjectId === change.groupProjectId) forget(state);
      })().catch((err) => {
        // telemetry-exempt: held notices are re-checked when they go anyway; logged
        appLog('core:group-project', 'warn', 'Could not re-check group project notice recipients', { meta: { groupProjectId: change.groupProjectId, error: err instanceof Error ? err.message : String(err) } });
      });
      return;
    }
    if (change.part !== 'board') return;
    changes = changes.catch(logReceiptFailure).then(async () => {
      const message = await postedMessage(change.groupProjectId, change.seq);
      const gp = message && await groupProjectHost.get(change.groupProjectId);
      if (message && gp) await onPost(gp, message);
    }).catch((err) => {
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
    for (const state of members.values()) clearTimers(state);
    members.clear();
    senderAddresses.clear();
    stop = null;
    changes = Promise.resolve();
  };
  return stop;
}

// ── Subscriptions ───────────────────────────────────────────────────────────

/**
 * The key a member's subscriptions have in the record: its host-relative
 * address, like the delivery above. On a copy this computer's agents are
 * `id@<self>`, which is the only key the host accepts from this computer (#3516).
 */
async function subscriptionKey(groupProjectId: string, agentId: string): Promise<string> {
  const gp = await groupProjectHost.get(groupProjectId);
  return gp ? groupProjectHost.addressOf(gp, agentId) : agentId;
}

/** Subscribe a member to a topic's notices, or unsubscribe it. Returns its topics now. */
export async function setTopicSubscription(groupProjectId: string, agentId: string, name: string, topic: string, on: boolean): Promise<string[]> {
  const canonical = await usableTopic(groupProjectId, topic);
  if (!canonical) throw new Error(NEW_CHANNEL_NAME_MESSAGE);
  const key = await subscriptionKey(groupProjectId, agentId);
  const { membership } = await groupProjectHost.updateMembership(groupProjectId, (draft) => {
    const own = { add: [...(draft.subscriptions?.[key]?.add ?? [])], remove: [...(draft.subscriptions?.[key]?.remove ?? [])] };
    own.add = own.add.filter((t) => t !== canonical);
    own.remove = own.remove.filter((t) => t !== canonical);
    (on ? own.add : own.remove).push(canonical);
    if (own.add.length + own.remove.length > MAX_SUBSCRIPTIONS) throw new Error(`At most ${MAX_SUBSCRIPTIONS} channel changes per member.`);
    draft.subscriptions = { ...draft.subscriptions, [key]: own };
  });
  const inbox = await groupProjectHost.inboxFor(groupProjectId, name, agentId);
  return [...memberSubscriptions(membership, key, inbox)].sort();
}

/** A member's subscribed topics. */
export async function listTopicSubscriptions(groupProjectId: string, agentId: string, name: string): Promise<string[]> {
  const [membership, inbox, key] = await Promise.all([
    groupProjectHost.getMembership(groupProjectId), groupProjectHost.inboxFor(groupProjectId, name, agentId), subscriptionKey(groupProjectId, agentId),
  ]);
  return [...memberSubscriptions(membership, key, inbox)].sort();
}

/** For tests. */
export function _resetDeliveryForTesting(): void {
  stop?.();
  members.clear();
  senderAddresses.clear();
}
