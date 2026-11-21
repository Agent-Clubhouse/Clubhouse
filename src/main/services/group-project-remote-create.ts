/**
 * Creating a group project on another computer (#3547).
 *
 * The asking computer saves the request, with its id, before sending it, and
 * every retry sends the same request with the same id. Nothing is queued: a
 * host that doesn't answer gets nothing, and the person retries.
 *
 * The host answers each (computer, request id) once. It never creates on a
 * request alone: a person's request from another computer always waits for
 * approval on the host (#3543 decision 3: the destination's approval applies,
 * a person's request isn't exempt, and pairing doesn't waive it). The approval
 * is an ordinary Ask-first call request in the host's Needs you, on its
 * Dispatcher like an update request from a phone, with the exact create shown.
 * Allow is used once, after the host checks everything again; Decline,
 * expiry, or a host restart before an answer ends the request, and asking
 * again takes a new request id.
 *
 * The host checks everything for itself: its network is on, the name, and
 * that a project scope names one of its projects explicitly linked to the
 * asking computer's (#3546). Membership starts by #3546's rules, through the
 * host's own create.
 */
import { createHash, randomUUID } from 'crypto';
import {
  GROUP_PROJECT_CREATE_CAPABILITIES_PATH, GROUP_PROJECT_CREATE_PATH, GROUP_PROJECT_REMOTE_CREATE_VERSION,
  readRemoteCreateAnswer, readRemoteCreateRequest, supportsRemoteCreate,
  type RemoteCreateAnswer, type RemoteCreateCapabilities, type RemoteCreateRequest,
} from '../../shared/group-project-network';
import type {
  GroupProject, GroupProjectCreateHost, GroupProjectCreateOptions, GroupProjectScope, RemoteCreateOutcome,
} from '../../shared/group-project-types';
import { REMOTE_CREATE_TOOL, type RemoteCreateReview } from '../../shared/grant-requests';
import { canonicalMemberAddress } from '../../shared/group-project-members';
import { parseAgentAddress } from '../../shared/agent-address';
import { readJsonFile, writeJsonFile } from './group-project-json-file';
import { networkCreateAnswersPath, networkCreateRequestsPath } from './group-project-paths';
import { groupProjectHost } from './group-project-host';
import { linkedProjectCopies } from './group-project-linked-agents';
import * as projectStore from './project-store';
import {
  callKey, consumeCallApprovalScope, onGrantRequestsChanged, peekGrantRequest, recordGrantRequest, type ConsumedCallApproval,
} from './grant-requests';
import { appLog } from './log-service';

/** Answers kept per host, at most, and for how long after their last change. */
const ANSWERS_MAX = 500;
const ANSWERS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** New requests one computer may make in a window; retries of a known id don't count. */
const RATE_MAX = 5;
const RATE_WINDOW_MS = 10 * 60 * 1000;
/** Approvals one computer may have waiting here at once. */
const WAITING_PER_MACHINE = 2;
/** Requests the asking computer keeps, and for how long. */
const REQUESTS_MAX = 100;
const REQUESTS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** How this module reaches other computers; group-project-network.ts provides it, tests a fake. */
export interface RemoteCreateLink {
  connected(machine: string): boolean;
  isMember(machine: string): boolean;
  members(): string[];
  machineName(machine: string): string | undefined;
  post(machine: string, path: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
}

/** What the host needs from the rest of the app. */
export interface RemoteCreateHostDeps {
  /** Where the approval shows in Needs you (the Dispatcher's row); null when nothing here can show it. */
  approvalPlace(): { agentId: string; agentName: string; projectPath: string } | null;
  /** After a create here: start membership and tell the app, as a create made here does. */
  afterCreate?(project: GroupProject): Promise<void>;
}

/** What Allow will create: resolved on the host. */
interface Plan {
  name: string;
  scope: GroupProjectScope;
  membership: { autoJoin: boolean; includeLinkedComputers: boolean; excluded: string[] };
}

interface AnswerEntry {
  machine: string;
  requestId: string;
  /** The request as sent: the same id with another body is refused. */
  hash: string;
  at: string;
  answer: RemoteCreateAnswer;
  /** While waiting: the request, its approval and what Allow creates. */
  request?: RemoteCreateRequest;
  grantRequestId?: string;
  key?: string;
  context?: string;
  plan?: Plan;
  /** A created answer whose membership start (afterCreate) hasn't run yet. Absent: it has, or it predates this. */
  started?: false;
}

interface SentRequest {
  host: string;
  request: RemoteCreateRequest;
  savedAt: string;
  /** The last final answer, once there is one. */
  final?: RemoteCreateOutcome['status'];
}

interface StoredList<T> { version: 1; items: T[] }

function validateList<T>(value: unknown): StoredList<T> {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.items)) throw new Error('Remote create state is not a valid version 1 record.');
  return { version: 1, items: value.items as T[] };
}

class RefusedError extends Error {}

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class GroupProjectRemoteCreate {
  private link: RemoteCreateLink | null = null;
  private deps: RemoteCreateHostDeps | null = null;
  private answers: AnswerEntry[] | null = null;
  private sent: SentRequest[] | null = null;
  private chains = new Map<string, Promise<unknown>>();
  private rate = new Map<string, number[]>();
  private offRequests: (() => void) | null = null;
  private capabilityCache = new Map<string, { at: number; supported: boolean }>();

  setLink(link: RemoteCreateLink | null): void {
    this.link = link;
    this.capabilityCache.clear();
  }

  /** Set at startup; without it this computer refuses remote creates. */
  setHostDeps(deps: RemoteCreateHostDeps | null): void {
    this.deps = deps;
    this.offRequests?.();
    this.offRequests = deps ? onGrantRequestsChanged((change) => {
      if (change.kind !== 'closed') return;
      // Allow is taken now, with the answer: nothing later (a permissions change) can turn it into a decline.
      const approvals = new Map<string, ConsumedCallApproval | null>();
      if (change.reason === 'answered' && change.allowed) {
        for (const entry of this.answers ?? []) {
          if (entry.answer.status === 'waiting' && entry.grantRequestId && entry.key && change.requestIds.includes(entry.grantRequestId)) {
            approvals.set(entry.grantRequestId, consumeCallApprovalScope(entry.key));
          }
        }
      }
      void this.closed(change.requestIds, change.reason, change.allowed === true, approvals).catch((err) => {
        // telemetry-exempt: the answer is kept for a retry once the store can be written
        appLog('core:group-project', 'warn', 'Could not record an answer to a remote create', { meta: { error: errorText(err) } });
      });
    }) : null;
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settle = (): void => undefined;
    const tail: Promise<void> = next.then(settle, settle);
    this.chains.set(key, tail);
    void tail.then(() => { if (this.chains.get(key) === tail) this.chains.delete(key); });
    return next;
  }

  private nameOf(machine: string): string {
    return this.link?.machineName(machine) || 'another computer';
  }

  // ── The host ────────────────────────────────────────────────────────────

  private async loadAnswers(): Promise<AnswerEntry[]> {
    if (!this.answers) {
      const items = (await readJsonFile(networkCreateAnswersPath(), (): StoredList<AnswerEntry> => ({ version: 1, items: [] }), validateList<AnswerEntry>)).items;
      // Approvals live in memory: one waiting from before a restart can't be answered any more,
      // unless it was allowed and created just before the restart, which its mark shows.
      const answers: AnswerEntry[] = [];
      for (const entry of items) {
        if (entry.answer.status !== 'waiting' || (entry.grantRequestId && peekGrantRequest(entry.grantRequestId))) { answers.push(entry); continue; }
        const made = await this.madeFor(entry.machine, entry.requestId, entry.hash);
        answers.push(made
          ? this.finalEntry(entry, { status: 'created', groupProjectId: made })
          : this.finalEntry(entry, { status: 'expired', reason: 'This computer restarted before anyone answered. Nothing was created. Ask again.' }));
      }
      this.answers = answers;
      // A group recovered by its mark is started once, after the store is ready.
      if (answers.some((e) => e.started === false)) void Promise.resolve().then(() => this.startPending());
    }
    return this.answers;
  }

  /** Save `entry` in place of any for its request, pruning old final answers. A waiting one is never pruned. */
  private saveAnswer(entry: AnswerEntry): Promise<void> {
    return this.serial('answers-file', async () => {
      const now = Date.now();
      const others = (await this.loadAnswers()).filter((e) => !(e.machine === entry.machine && e.requestId === entry.requestId));
      const kept = others.filter((e) => e.answer.status === 'waiting' || now - Date.parse(e.at) < ANSWERS_TTL_MS);
      const waiting = kept.filter((e) => e.answer.status === 'waiting');
      const finals = kept.filter((e) => e.answer.status !== 'waiting').slice(-Math.max(0, ANSWERS_MAX - 1 - waiting.length));
      const items = [...waiting, ...finals, entry];
      await writeJsonFile(networkCreateAnswersPath(), { version: 1, items } satisfies StoredList<AnswerEntry>);
      this.answers = items;
    });
  }

  private finalEntry(entry: AnswerEntry, answer: { status: 'created'; groupProjectId: string } | { status: 'refused' | 'declined' | 'expired'; reason: string }): AnswerEntry {
    return {
      machine: entry.machine, requestId: entry.requestId, hash: entry.hash, at: new Date().toISOString(), answer: { v: 1, requestId: entry.requestId, ...answer },
      ...(answer.status === 'created' && { started: false as const }),
    };
  }

  /**
   * Start a group made here for another computer (membership, the created
   * notice): once, whichever path found it made. Call inside its computer's chain.
   */
  private async start(machine: string, requestId: string): Promise<void> {
    const entry = (await this.loadAnswers()).find((e) => e.machine === machine && e.requestId === requestId);
    if (!entry || entry.started !== false || entry.answer.status !== 'created') return;
    let project: GroupProject | null;
    try { project = await groupProjectHost.get(entry.answer.groupProjectId); }
    catch (err) {
      // A failed lookup is not an absent group: stay pending so the next request, startPending or a restart starts it (#3592 L1).
      appLog('core:group-project', 'warn', 'Could not look up a remote create to start it', { meta: { error: errorText(err) } });
      return;
    }
    // A group that is gone has nothing to start; its answer stays created and the start is settled, as before.
    if (project) {
      await this.deps?.afterCreate?.(project).catch((err: unknown) => {
        // telemetry-exempt: the group exists; membership catches up on its next reconcile
        appLog('core:group-project', 'warn', 'Could not start membership of a remote create', { meta: { id: project.id, error: errorText(err) } });
      });
    }
    const { started: _pending, ...done } = entry;
    await this.saveAnswer(done);
  }

  private async startPending(): Promise<void> {
    for (const entry of (this.answers ?? []).filter((e) => e.started === false)) {
      await this.serial(`machine:${entry.machine}`, () => this.start(entry.machine, entry.requestId)).catch((err: unknown) => {
        // telemetry-exempt: tried again on the next request for it
        appLog('core:group-project', 'warn', 'Could not start a recovered remote create', { meta: { error: errorText(err) } });
      });
    }
  }

  /** The group a request made here, by the mark its create left: the computer, the request id and the request's hash. */
  private async madeFor(machine: string, requestId: string, hash: string): Promise<string | null> {
    const made = (await groupProjectHost.list()).find((p) => {
      const mark = p.metadata?.remoteCreate as { machine?: unknown; requestId?: unknown; hash?: unknown } | undefined;
      return mark?.machine === machine && mark.requestId === requestId && mark.hash === hash && !groupProjectHost.isReplica(p);
    });
    return made?.id ?? null;
  }

  /** What the host answers: `machine` is the authenticated computer that sent it. */
  receive(machine: string, raw: unknown): Promise<RemoteCreateAnswer> {
    const request = readRemoteCreateRequest(raw);
    const sender = machine.toLowerCase();
    return this.serial(`machine:${sender}`, () => this.answer(sender, request));
  }

  capabilities(): RemoteCreateCapabilities {
    return { v: 1, remoteCreate: GROUP_PROJECT_REMOTE_CREATE_VERSION };
  }

  private async answer(machine: string, request: RemoteCreateRequest): Promise<RemoteCreateAnswer> {
    const hash = hashOf(request);
    const { requestId } = request;
    const transient = (status: 'refused' | 'busy', reason: string): RemoteCreateAnswer => ({ v: 1, requestId, status, reason });
    const earlier = (await this.loadAnswers()).find((e) => e.machine === machine && e.requestId === requestId);
    if (earlier && earlier.hash !== hash) return transient('refused', 'This request id was already used for a different group project. Nothing was created.');
    const entry: AnswerEntry = { machine, requestId, hash, at: new Date().toISOString(), answer: { v: 1, requestId, status: 'refused', reason: '' } };
    // A group it made answers first: a crash may have lost the answer, or left an older one.
    if (earlier?.answer.status !== 'created') {
      const made = await this.madeFor(machine, requestId, hash);
      if (made) {
        const created = this.finalEntry(earlier ?? entry, { status: 'created', groupProjectId: made });
        await this.saveAnswer(created);
        await this.start(machine, requestId);
        return created.answer;
      }
    }
    if (earlier?.started === false) await this.start(machine, requestId);
    if (earlier) {
      if (earlier.answer.status === 'waiting' && Date.parse(earlier.answer.expiresAt) <= Date.now()) {
        const expired = this.finalEntry(earlier, { status: 'expired', reason: 'Nobody answered the approval in time. Nothing was created. Ask again.' });
        await this.saveAnswer(expired);
        return expired.answer;
      }
      return earlier.answer;
    }

    // A new request: limited per computer, so a paired computer can't flood Needs you.
    const now = Date.now();
    const recent = (this.rate.get(machine) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_MAX) return transient('busy', 'Too many create requests from your computer. Wait a few minutes, then retry.');
    const waiting = (await this.loadAnswers()).filter((e) => e.machine === machine && e.answer.status === 'waiting').length;
    if (waiting >= WAITING_PER_MACHINE) return transient('busy', 'Your earlier create requests are still waiting for approval here. Wait for an answer, then retry.');
    recent.push(now);
    this.rate.set(machine, recent);

    let plan: Plan;
    try {
      plan = await this.resolvePlan(machine, request);
    } catch (err) {
      if (!(err instanceof RefusedError)) throw err;
      const refused = this.finalEntry(entry, { status: 'refused', reason: `${err.message} Nothing was created.` });
      await this.saveAnswer(refused);
      return refused.answer;
    }
    const place = this.deps?.approvalPlace() ?? null;
    if (!place) return transient('busy', 'That computer can\'t show the approval while its Dispatcher is off. Nothing was created. Retry once it is on.');

    const key = callKey(place.agentId, REMOTE_CREATE_TOOL, { machine, requestId });
    const context = `${REMOTE_CREATE_TOOL}\0${machine}\0${requestId}\0${hashOf(plan)}`;
    const review: RemoteCreateReview = {
      machine, machineName: this.nameOf(machine), name: plan.name,
      scopeLabel: await this.scopeLabel(plan.scope), membershipLabel: membershipLabel(plan), excluded: plan.membership.excluded,
    };
    const details = [
      `Create the group project "${plan.name}" on this computer, as ${review.machineName} asked.`,
      `Covers: ${review.scopeLabel}.`, `Starting members: ${review.membershipLabel}.`,
      ...(plan.membership.excluded.length ? [`Kept out: ${plan.membership.excluded.join(', ')}.`] : []),
    ].join('\n');
    const recorded = recordGrantRequest(key, {
      kind: 'call', agentId: place.agentId, agentName: place.agentName, projectPath: place.projectPath,
      actions: ['connection.manage'], where: 'a new group project on this computer', toolName: REMOTE_CREATE_TOOL,
      detail: details.split('\n')[0], details, argumentsText: JSON.stringify({ machine, requestId }), remoteCreateReview: review,
    }, Date.now(), { context, asks: [{ action: 'connection.manage', where: 'a new group project on this computer' }], snapshot: plan });
    if (!recorded.ok) return transient('busy', 'Too many approvals are waiting on this computer. Nothing was created. Retry after they are answered.');
    const pending: AnswerEntry = {
      ...entry, answer: { v: 1, requestId, status: 'waiting', expiresAt: recorded.request.expiresAt },
      request, grantRequestId: recorded.request.requestId, key, context, plan,
    };
    await this.saveAnswer(pending);
    appLog('core:group-project', 'info', 'A remote create waits for approval', { meta: { machine, requestId, grantRequestId: recorded.request.requestId } });
    return pending.answer;
  }

  /** The create the host would make: everything checked here, nothing taken from the sender's view. */
  private async resolvePlan(machine: string, request: RemoteCreateRequest): Promise<Plan> {
    const self = groupProjectHost.selfMachine();
    const network = groupProjectHost.scopeOptions().network;
    if (!self || !network.available) throw new RefusedError(network.reason ?? 'This computer isn\'t in an Annex Network.');
    if (!this.link?.isMember(machine)) throw new RefusedError('Your computer isn\'t in this computer\'s Annex Network.');
    let scope: GroupProjectScope = { level: 'app', reach: 'network' };
    if (request.scope.level === 'project') {
      const registered = new Set((await projectStore.list()).map((p) => p.id));
      const here = [...new Set(linkedProjectCopies(machine, request.scope.projectId).filter((p) => p.machine === self).map((p) => p.projectId))]
        .filter((id) => registered.has(id));
      if (here.length === 0) throw new RefusedError('That project isn\'t linked to a project on this computer. Link them first.');
      if (here.length > 1) throw new RefusedError('That project is linked to more than one project on this computer.');
      scope = { level: 'project', projectId: here[0], reach: 'network' };
    }
    const excluded = [...new Set(request.membership.excluded.map((reference) => {
      // Relative to the sender: a bare id is one of its agents.
      const parsed = parseAgentAddress(reference.trim());
      return canonicalMemberAddress(parsed.machine ? reference : `${parsed.agentId}@${machine}`, self);
    }))].sort();
    const projectGroup = scope.level === 'project';
    return {
      name: request.name, scope,
      membership: {
        autoJoin: projectGroup && request.membership.autoJoin,
        includeLinkedComputers: projectGroup && request.membership.includeLinkedComputers,
        excluded: projectGroup ? excluded : [],
      },
    };
  }

  private async scopeLabel(scope: GroupProjectScope): Promise<string> {
    if (scope.level === 'app') return 'the whole app, shared with your network';
    const project = (await projectStore.list()).find((p) => p.id === scope.projectId) as { name?: string; displayName?: string } | undefined;
    return `${project?.displayName || project?.name || scope.projectId} on this computer, shared with your network`;
  }

  /** Approvals answered, expired or withdrawn in Needs you. */
  private async closed(requestIds: string[], reason: 'answered' | 'expired' | 'withdrawn', allowed: boolean, approvals: ReadonlyMap<string, ConsumedCallApproval | null>): Promise<void> {
    const entries = (await this.loadAnswers()).filter((e) => e.answer.status === 'waiting' && e.grantRequestId && requestIds.includes(e.grantRequestId));
    for (const entry of entries) {
      await this.serial(`machine:${entry.machine}`, async () => {
        const current = (await this.loadAnswers()).find((e) => e.machine === entry.machine && e.requestId === entry.requestId);
        if (!current || current.answer.status !== 'waiting') return;
        if (reason === 'answered' && allowed) {
          await this.approved(current, approvals.get(current.grantRequestId!) ?? null);
          return;
        }
        const final = reason === 'answered'
          ? this.finalEntry(current, { status: 'declined', reason: 'A person there declined it. Nothing was created.' })
          : this.finalEntry(current, { status: 'expired', reason: reason === 'expired'
            ? 'Nobody answered the approval in time. Nothing was created. Ask again.'
            : 'The approval was withdrawn there. Nothing was created. Ask again.' });
        await this.saveAnswer(final);
      });
    }
  }

  /** Allowed: used once, checked again, then created. */
  private async approved(entry: AnswerEntry, approval: ConsumedCallApproval | null): Promise<void> {
    const refuse = async (reason: string) => { await this.saveAnswer(this.finalEntry(entry, { status: 'refused', reason })); };
    if (!approval || approval.scope.context !== entry.context || !entry.request || !entry.plan) {
      await refuse('The approval didn\'t match this request. Nothing was created.');
      return;
    }
    let plan: Plan;
    try {
      plan = await this.resolvePlan(entry.machine, entry.request);
    } catch (err) {
      if (!(err instanceof RefusedError)) throw err;
      await refuse(`It was approved, but ${err.message.charAt(0).toLowerCase()}${err.message.slice(1)} Nothing was created.`);
      return;
    }
    if (hashOf(plan) !== hashOf(entry.plan)) {
      await refuse('Something it depends on changed after it was approved. Nothing was created. Ask again.');
      return;
    }
    let project: GroupProject;
    try {
      project = await groupProjectHost.create(plan.name, { scope: plan.scope, membership: plan.membership }, {
        metadata: { remoteCreate: { machine: entry.machine, requestId: entry.requestId, hash: entry.hash } },
      });
    } catch (err) {
      // telemetry-exempt: answered to the asking computer, which shows it
      await refuse(`It was approved, but creating it failed: ${errorText(err)} Nothing was created.`);
      return;
    }
    try {
      // Saved before it's answered: a crash after this finds the group by its mark.
      await groupProjectHost.flushRegistry();
    } catch (err) {
      // telemetry-exempt: the group exists; no answer is recorded, so a retry finds it by its mark
      appLog('core:group-project', 'warn', 'A remote create was made but not yet saved', { meta: { id: project.id, error: errorText(err) } });
      return;
    }
    await this.saveAnswer(this.finalEntry(entry, { status: 'created', groupProjectId: project.id }));
    appLog('core:group-project', 'info', 'Group project created for another computer', { meta: { id: project.id, machine: entry.machine } });
    await this.start(entry.machine, entry.requestId);
  }

  // ── The asking computer ─────────────────────────────────────────────────

  private async loadSent(): Promise<SentRequest[]> {
    if (!this.sent) this.sent = (await readJsonFile(networkCreateRequestsPath(), (): StoredList<SentRequest> => ({ version: 1, items: [] }), validateList<SentRequest>)).items;
    return this.sent;
  }

  private saveSent(next: SentRequest): Promise<void> {
    return this.serial('requests-file', async () => {
      const now = Date.now();
      const items = [...(await this.loadSent()).filter((s) => s.request.requestId !== next.request.requestId && now - Date.parse(s.savedAt) < REQUESTS_TTL_MS), next]
        .slice(-REQUESTS_MAX);
      await writeJsonFile(networkCreateRequestsPath(), { version: 1, items } satisfies StoredList<SentRequest>);
      this.sent = items;
    });
  }

  /** The computers a group project can be created on: this one, and each network computer, with why not. */
  async listHosts(): Promise<GroupProjectCreateHost[]> {
    const network = groupProjectHost.scopeOptions().network;
    const hosts: GroupProjectCreateHost[] = [{ machine: null, name: 'This computer', state: 'online' }];
    if (!network.available || !this.link) return hosts;
    const self = groupProjectHost.selfMachine();
    for (const machine of this.link.members().map((m) => m.toLowerCase()).filter((m) => m !== self)) {
      const name = this.nameOf(machine);
      if (!this.link.connected(machine)) { hosts.push({ machine, name, state: 'offline', reason: `${name} is offline.` }); continue; }
      const supported = await this.supports(machine);
      if (supported === null) hosts.push({ machine, name, state: 'unavailable', reason: `${name} didn't answer. Try again.` });
      else if (!supported) hosts.push({ machine, name, state: 'needs_update', reason: `${name} needs a Clubhouse update to host group projects created here.` });
      else hosts.push({ machine, name, state: 'online' });
    }
    return hosts;
  }

  /** Whether a host takes remote create; null when it couldn't be asked. */
  private async supports(machine: string): Promise<boolean | null> {
    const cached = this.capabilityCache.get(machine);
    if (cached && Date.now() - cached.at < 60_000) return cached.supported;
    try {
      const response = await this.link!.post(machine, GROUP_PROJECT_CREATE_CAPABILITIES_PATH, {});
      const supported = response.status === 200 && supportsRemoteCreate(response.body);
      if (response.status !== 200 && response.status !== 404) return null;
      this.capabilityCache.set(machine, { at: Date.now(), supported });
      return supported;
    } catch {
      // telemetry-exempt: shown as not answering; the person can retry
      return null;
    }
  }

  /**
   * Ask `host` to create a group project. A new request is saved before it's
   * sent; `retryOf` sends a saved one again exactly as it was, whatever the
   * form says now.
   */
  async createOn(host: string, name: string, options: GroupProjectCreateOptions | undefined, retryOf?: string): Promise<RemoteCreateOutcome> {
    const machine = host.toLowerCase();
    const hostName = this.nameOf(machine);
    let saved: SentRequest | undefined;
    if (retryOf) {
      saved = (await this.loadSent()).find((s) => s.request.requestId === retryOf);
      if (!saved || saved.host !== machine) throw new Error('That create request is no longer saved here. Start a new one.');
    } else {
      saved = { host: machine, request: this.buildRequest(name, options), savedAt: new Date().toISOString() };
      await this.saveSent(saved);
    }
    const { request } = saved;
    const base = { requestId: request.requestId, host: machine, hostName };
    const unreachable = (reason: string): RemoteCreateOutcome => ({ ...base, status: 'unreachable', reason });
    if (!this.link?.isMember(machine)) return { ...base, status: 'refused', reason: `${hostName} isn't in your Annex Network. Nothing was created.` };
    if (!this.link.connected(machine)) return unreachable(`${hostName} is offline. Nothing was created and nothing is queued.`);
    let response: { status: number; body: unknown };
    try {
      response = await this.link.post(machine, GROUP_PROJECT_CREATE_PATH, request as unknown as Record<string, unknown>);
    } catch (err) {
      // telemetry-exempt: shown with Retry, which sends the same request id
      appLog('core:group-project', 'info', 'A remote create got no answer', { meta: { host: machine, requestId: request.requestId, error: errorText(err) } });
      return unreachable(`${hostName} didn't answer. It may or may not have the request; Retry is safe and can't create two.`);
    }
    if (response.status === 404) return { ...base, status: 'unsupported', reason: `${hostName} needs a Clubhouse update to host group projects created here. Nothing was created.` };
    if (response.status !== 200) return unreachable(`${hostName} couldn't take the request (${response.status}). Nothing was created. Retry is safe.`);
    let answer: RemoteCreateAnswer;
    try {
      answer = readRemoteCreateAnswer(response.body, request.requestId);
    } catch {
      // telemetry-exempt: an unreadable answer reads as no answer; the retry is safe
      return unreachable(`${hostName} sent an answer this computer couldn't read. Retry is safe.`);
    }
    if (answer.status === 'waiting') return { ...base, status: 'waiting', expiresAt: answer.expiresAt };
    if (answer.status !== 'created') {
      if (answer.status !== 'busy') await this.saveSent({ ...saved, final: answer.status });
      return { ...base, status: answer.status, reason: answer.reason };
    }
    await this.saveSent({ ...saved, final: 'created' });
    await groupProjectHost.syncFrom(machine).catch((err: unknown) => {
      // telemetry-exempt: the copy arrives with the host's next notice
      appLog('core:group-project', 'warn', 'Could not fetch a group project created on another computer', { meta: { host: machine, error: errorText(err) } });
    });
    const project = await groupProjectHost.get(answer.groupProjectId).catch((): null => null);
    return { ...base, status: 'created', groupProjectId: answer.groupProjectId, project };
  }

  private buildRequest(name: string, options: GroupProjectCreateOptions | undefined): RemoteCreateRequest {
    const scope = options?.scope;
    if (!scope || scope.reach !== 'network') throw new Error('A group project hosted on another computer must be shared with your network.');
    const self = groupProjectHost.selfMachine();
    if (!self) throw new Error('This computer has no Annex Network identity.');
    // Exclusions travel relative to this computer: a bare id is one of its agents.
    const excluded = (options?.membership?.excluded ?? []).map((reference) => {
      const parsed = parseAgentAddress(reference.trim());
      return parsed.machine ? `${parsed.agentId}@${parsed.machine}` : `${parsed.agentId}@${self}`;
    });
    return readRemoteCreateRequest({
      v: 1, requestId: `rc_${randomUUID().replace(/-/g, '')}`, name,
      scope: scope.level === 'project' ? { level: 'project', projectId: scope.projectId } : { level: 'app' },
      membership: {
        autoJoin: options?.membership?.autoJoin ?? true,
        includeLinkedComputers: options?.membership?.includeLinkedComputers ?? true,
        excluded,
      },
    });
  }

  _resetForTesting(): void {
    this.offRequests?.();
    this.offRequests = null;
    this.link = null;
    this.deps = null;
    this.answers = null;
    this.sent = null;
    this.chains.clear();
    this.rate.clear();
    this.capabilityCache.clear();
  }
}

function membershipLabel(plan: Plan): string {
  if (plan.scope.level === 'app') return 'none; app-wide group projects start with no members';
  if (!plan.membership.autoJoin) return 'none; agents are added by hand';
  return plan.membership.includeLinkedComputers
    ? 'every agent in the project here and on linked computers, now and later'
    : 'every agent in the project here, now and later';
}

export const groupProjectRemoteCreate = new GroupProjectRemoteCreate();
