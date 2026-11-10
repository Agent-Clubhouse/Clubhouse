/**
 * The user's requests to the Dispatcher (#3237, #3204). Each start_work gets a
 * request id that stays with it until its outcome reaches the chat:
 *
 * - An answer the Dispatcher reports for it (tell_user with its id, or news
 *   from an agent it reached for it) closes it as done. A question about it
 *   leaves it waiting on the user, and their answer, handed off with the same
 *   id, opens it again.
 * - Its turn failing, being stopped, or the Dispatcher's session ending before
 *   it was read ends it, and the chat is told (dispatcher-request-outcomes).
 *   So is no outcome for too long.
 * - A retry names the request, or repeats its words: it is handed off again
 *   under the same id. The same words while it is still under way aren't
 *   handed off twice.
 *
 * Requests under way show the Dispatcher as working (#3220). This module has
 * no Dispatcher imports, so its service can read it; the caller says which
 * agent's chat events are the Dispatcher's.
 *
 * Kept in `dispatcher-requests.json` beside the Dispatcher's folders, so an
 * answer after a restart still finds its request.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getBaseDirPath } from '../base-dir';
import { appLog } from '../log-service';
import type { ChatEvent, MessageDelivery, TurnStopReason } from '../../../shared/chat';
import type { NewsKind } from './dispatcher-triage';

const NS = 'core:dispatcher';

export type RequestStatus = 'under_way' | 'waiting_user' | 'done' | 'failed' | 'cancelled' | 'timed_out';

/** How a request ended without an answer: what the chat is told. */
export type RequestEnding = 'failed' | 'cancelled' | 'timed_out';

/**
 * Where the Dispatcher's work is on it: still being handed off, waiting for
 * the turn that reads it, in that turn, or past it.
 */
export type RequestTurn = 'sending' | 'awaiting' | 'in_turn' | 'past';

export interface DispatcherRequest {
  id: string;
  /** The request as the chat first handed it off, for spotting a retry. */
  text: string;
  /** When it was first made. */
  at: number;
  /** When it was last handed off: a follow-up or retry starts its clock again. */
  handedOffAt: number;
  status: RequestStatus;
  turn: RequestTurn;
  /** When the turn that read it ended. */
  turnEndedAt?: number;
  /** Agents the Dispatcher messaged or woke while it worked on it: their news is for it. */
  agents: string[];
  /** When it got its outcome. */
  endedAt?: number;
}

/** A request nobody answered in a week is no longer one an answer can be for. */
export const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** No outcome this long after a hand-off: the chat hears there is none yet. */
export const REQUEST_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** Its turn ended and no agent was reached for it: nothing is left to wait on for long. */
export const QUIET_TIMEOUT_MS = 10 * 60 * 1000;
const REQUESTS_MAX = 50;
const TEXT_MAX = 1_000;
const DETAIL_MAX = 300;

/** Request text as compared for a retry: case, spacing and punctuation don't count. */
export function sameRequestKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}#]+/gu, ' ').trim().slice(0, TEXT_MAX);
}

/** When a request under way times out, or null for one that isn't. */
export function requestDeadline(r: DispatcherRequest): number | null {
  if (r.status !== 'under_way') return null;
  if (r.turn === 'past' && r.agents.length === 0) return (r.turnEndedAt ?? r.handedOffAt) + QUIET_TIMEOUT_MS;
  return r.handedOffAt + REQUEST_TIMEOUT_MS;
}

/** What a report says about itself, for finding the request it is for. */
export interface RequestQuery {
  kind: NewsKind;
  /** The id the Dispatcher gave. */
  request?: string;
  /** The agent whose news it is, when Clubhouse found it. */
  fromAgentId?: string;
  /** The name given, found or not. Absent, with no id, for the Dispatcher's own words. */
  fromName?: string;
}

const isOpen = (r: DispatcherRequest) => r.status === 'under_way' || r.status === 'waiting_user' || r.status === 'timed_out';

/**
 * The request a report is for, if any. Only answers and questions are for a
 * request. In order:
 * 1. The id the Dispatcher gave, when it names a request.
 * 2. An agent's news: the latest request that agent was reached for. News
 *    from an agent reached for none is for none (#3204).
 * 3. The Dispatcher's own words in the turn reading a request: that request.
 *    Its own words in any other turn, such as a failed Action or a missing
 *    permission, are for none (#3204).
 * 4. An answer, when exactly one request is under way and nothing else could
 *    be meant: that one.
 */
export function matchRequest(requests: readonly DispatcherRequest[], q: RequestQuery, now: number): DispatcherRequest | undefined {
  if (q.kind !== 'answer' && q.kind !== 'needs_user') return undefined;
  const live = requests.filter((r) => now - r.handedOffAt < REQUEST_TTL_MS);
  if (q.request) {
    const named = live.find((r) => r.id === q.request);
    if (named) return named;
  }
  if (q.fromAgentId) {
    const reached = live.filter((r) => r.agents.includes(q.fromAgentId!));
    if (reached.length) {
      return [...reached].sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || b.handedOffAt - a.handedOffAt)[0];
    }
  }
  const underWay = live.filter((r) => r.status === 'under_way');
  const ownWords = !q.fromAgentId && !q.fromName;
  if (ownWords) {
    const reading = underWay.find((r) => r.turn === 'in_turn');
    if (reading) return reading;
  }
  if (q.kind === 'answer' && underWay.length === 1 && (ownWords || underWay[0].agents.length === 0)) return underWay[0];
  return undefined;
}

// ── State ─────────────────────────────────────────────────────────────────

let requests: DispatcherRequest[] | null = null;
let saving: Promise<void> = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

export type RequestEndedHandler = (request: DispatcherRequest, ending: RequestEnding, detail?: string) => void;
let endedHandler: RequestEndedHandler | null = null;

export function getRequestsPath(): string {
  return path.join(getBaseDirPath(), 'dispatcher-requests.json');
}

function validRequest(r: unknown): r is DispatcherRequest {
  const v = r as DispatcherRequest | null;
  return !!v && typeof v.id === 'string' && typeof v.text === 'string' && typeof v.at === 'number'
    && typeof v.handedOffAt === 'number' && typeof v.status === 'string' && Array.isArray(v.agents);
}

function load(now = Date.now()): DispatcherRequest[] {
  if (requests) return requests;
  let saved: DispatcherRequest[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(getRequestsPath(), 'utf8')) as { requests?: unknown };
    saved = Array.isArray(parsed.requests) ? parsed.requests.filter(validRequest) : [];
  } catch {
    // telemetry-exempt: no file yet, or one that can't be read: start empty.
  }
  requests = saved.filter((r) => now - r.handedOffAt < REQUEST_TTL_MS).map((r) => {
    // The turns it waited on ended with the last run. One that ran out meanwhile is too stale to tell the user about.
    const next: DispatcherRequest = { ...r, agents: r.agents.filter((a) => typeof a === 'string') };
    if (next.turn !== 'past') {
      next.turn = 'past';
      next.turnEndedAt = now;
    }
    const deadline = requestDeadline(next);
    if (deadline !== null && deadline <= now) {
      next.status = 'timed_out';
      next.endedAt = now;
    }
    return next;
  });
  schedule();
  return requests;
}

function save(): void {
  const body = JSON.stringify({ requests }, null, 2);
  const file = getRequestsPath();
  saving = saving.then(async () => {
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, body, 'utf8');
    } catch (err) {
      // telemetry-exempt: the requests stay in memory for this run; logged
      appLog(NS, 'warn', 'Dispatcher requests not saved', { meta: { error: err instanceof Error ? err.message : String(err) } });
    }
  });
}

function changed(now = Date.now()): void {
  if (!requests) return;
  requests = requests.filter((r) => now - r.handedOffAt < REQUEST_TTL_MS).slice(-REQUESTS_MAX);
  save();
  schedule();
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      // telemetry-exempt: logged; one listener must not stop the others
      appLog(NS, 'warn', 'Dispatcher request listener failed', { meta: { error: err instanceof Error ? err.message : String(err) } });
    }
  }
}

function copy(r: DispatcherRequest): DispatcherRequest {
  return { ...r, agents: [...r.agents] };
}

function find(id: string): DispatcherRequest | undefined {
  return load().find((r) => r.id === id);
}

/** Every request kept, oldest first. */
export function getRequests(): DispatcherRequest[] {
  return load().map(copy);
}

export function getRequest(id: string): DispatcherRequest | undefined {
  const r = find(id);
  return r && copy(r);
}

/** How many requests are under way: handed off, with no outcome back yet. */
export function requestsUnderWay(): number {
  return load().filter((r) => r.status === 'under_way').length;
}

/** Hear of every change to the requests. Returns a function that stops listening. */
export function onRequestsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Who tells the chat that a request ended without an answer. Null stops telling. */
export function setRequestEndedHandler(handler: RequestEndedHandler | null): void {
  endedHandler = handler;
}

function end(r: DispatcherRequest, ending: RequestEnding, now: number, detail?: string): void {
  r.status = ending;
  r.turn = 'past';
  r.endedAt = now;
  appLog(NS, 'info', 'Dispatcher request ended', { meta: { request: r.id, ending } });
  const clean = detail?.trim().slice(0, DETAIL_MAX) || undefined;
  try {
    endedHandler?.(copy(r), ending, clean);
  } catch (err) {
    // telemetry-exempt: logged; the request is ended either way
    appLog(NS, 'warn', 'Dispatcher request outcome not passed on', { meta: { request: r.id, error: err instanceof Error ? err.message : String(err) } });
  }
}

// ── Starting a request ────────────────────────────────────────────────────

export type BeginResult =
  /** A new request. */
  | { kind: 'new'; request: DispatcherRequest }
  /** An earlier request handed off again: a follow-up, or a retry of one that ended without an answer. */
  | { kind: 'again'; request: DispatcherRequest; previous: DispatcherRequest }
  /** The same request is already under way: it isn't handed off twice. */
  | { kind: 'already'; request: DispatcherRequest }
  /** The id named no request. */
  | { kind: 'unknown' };

function newId(now: number): string {
  return `req_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function reopen(r: DispatcherRequest, now: number): BeginResult {
  const previous = copy(r);
  r.status = 'under_way';
  r.turn = 'sending';
  r.handedOffAt = now;
  delete r.endedAt;
  delete r.turnEndedAt;
  changed(now);
  return { kind: 'again', request: copy(r), previous };
}

/**
 * The chat hands a request off. With an id, that request is handed off again.
 * Without one, the same words as a request under way are that request, and
 * the same words as one that ended without an answer retry it.
 */
export function beginRequest(text: string, now = Date.now(), id?: string): BeginResult {
  const all = load(now);
  if (id) {
    const named = all.find((r) => r.id === id);
    return named ? reopen(named, now) : { kind: 'unknown' };
  }
  const key = sameRequestKey(text);
  const same = all.filter((r) => sameRequestKey(r.text) === key);
  const underWay = same.find((r) => r.status === 'under_way');
  if (underWay) return { kind: 'already', request: copy(underWay) };
  const ended = same.filter((r) => r.status === 'failed' || r.status === 'cancelled' || r.status === 'timed_out').pop();
  if (ended) return reopen(ended, now);
  const request: DispatcherRequest = {
    id: newId(now), text: text.slice(0, TEXT_MAX), at: now, handedOffAt: now, status: 'under_way', turn: 'sending', agents: [],
  };
  all.push(request);
  changed(now);
  return { kind: 'new', request: copy(request) };
}

/** The hand-off didn't go: forget a new request, and put back one handed off again. */
export function withdrawRequest(begun: BeginResult, now = Date.now()): void {
  if (begun.kind !== 'new' && begun.kind !== 'again') return;
  const all = load(now);
  const i = all.findIndex((r) => r.id === begun.request.id);
  if (i < 0) return;
  if (begun.kind === 'new') all.splice(i, 1);
  else all[i] = copy(begun.previous);
  changed(now);
}

// ── The Dispatcher's turns ────────────────────────────────────────────────

/** Counts of the Dispatcher's turns, so a hand-off can tell which turn reads it. */
interface TurnMark { started: number; ended: number }

const turns = {
  started: 0,
  ended: 0,
  open: false,
  /** `started` when the open turn began. */
  openSeq: 0,
  /** The error the open turn reported, for the chat. */
  error: undefined as string | undefined,
  last: null as null | { startSeq: number; endSeq: number; ending: RequestEnding | null; detail?: string; at: number },
};

/** Take before handing off; give to noteHandedOff after. */
export function workTurnMark(): TurnMark {
  return { started: turns.started, ended: turns.ended };
}

function endingFor(stop: TurnStopReason): RequestEnding | null {
  switch (stop) {
    case 'end_turn': return null;
    case 'cancelled': return 'cancelled';
    case 'timeout': return 'timed_out';
    default: return 'failed';
  }
}

/** Its turn is over: past it, or ended with the turn. */
function afterTurn(r: DispatcherRequest, ending: RequestEnding | null, now: number, detail?: string): void {
  if (ending && r.status === 'under_way') {
    end(r, ending, now, detail);
    return;
  }
  r.turn = 'past';
  r.turnEndedAt = now;
}

/**
 * The hand-off reached the Dispatcher: which turn reads it. A steer joins the
 * turn running now; a prompt or a wake starts one; a queued message waits for
 * the turn after this one.
 */
export function noteHandedOff(id: string, delivery: MessageDelivery | 'woke', mark: TurnMark, now = Date.now()): void {
  const r = find(id);
  if (!r || r.turn !== 'sending') return;
  const last = turns.last;
  if (delivery === 'steer') {
    if (last && last.endSeq > mark.ended) afterTurn(r, last.ending, now, last.detail);
    else r.turn = turns.open ? 'in_turn' : 'awaiting';
  } else if (delivery !== 'queued' && last && last.startSeq > mark.started) {
    // Its turn started and ended while it was being handed off.
    afterTurn(r, last.ending, now, last.detail);
  } else if (delivery !== 'queued' && turns.open && turns.openSeq > mark.started) {
    r.turn = 'in_turn';
  } else {
    r.turn = 'awaiting';
  }
  changed(now);
}

/** One of the Dispatcher's own chat events. The caller filters to its agent. */
export function noteWorkEvent(event: ChatEvent, now = Date.now()): void {
  const all = load(now);
  switch (event.type) {
    case 'turn_started': {
      turns.started++;
      turns.open = true;
      turns.openSeq = turns.started;
      turns.error = undefined;
      let moved = false;
      for (const r of all) {
        if (r.status === 'under_way' && r.turn === 'awaiting') { r.turn = 'in_turn'; moved = true; }
      }
      if (moved) changed(now);
      return;
    }
    case 'error':
      if (!event.data.willRetry) turns.error = event.data.message;
      return;
    case 'turn_ended': {
      turns.ended++;
      const ending = endingFor(event.data.stopReason);
      turns.last = { startSeq: turns.openSeq, endSeq: turns.ended, ending, detail: turns.error, at: now };
      turns.open = false;
      const reading = all.filter((r) => r.turn === 'in_turn');
      for (const r of reading) afterTurn(r, ending, now, turns.error);
      turns.error = undefined;
      if (reading.length) changed(now);
      return;
    }
    case 'session_ended':
    case 'session_state': {
      if (event.type === 'session_state' && event.data.state !== 'error') return;
      const wasOpen = turns.open;
      turns.open = false;
      if (wasOpen) {
        turns.ended++;
        turns.last = { startSeq: turns.openSeq, endSeq: turns.ended, ending: 'failed', detail: turns.error, at: now };
      }
      const ending: RequestEnding = event.type === 'session_ended' && event.data.reason === 'stopped' ? 'cancelled' : 'failed';
      const detail = turns.error ?? (event.type === 'session_ended' ? event.data.message : undefined);
      const waiting = all.filter((r) => r.status === 'under_way' && (r.turn === 'awaiting' || r.turn === 'in_turn'));
      for (const r of waiting) end(r, ending, now, detail);
      turns.error = undefined;
      if (waiting.length) changed(now);
      return;
    }
    default:
      return;
  }
}

/** The Dispatcher messaged or woke an agent: that agent's news is for the requests its turn is reading. */
export function noteAgentReached(agentId: string, now = Date.now()): void {
  const reading = load(now).filter((r) => r.status === 'under_way' && r.turn === 'in_turn' && !r.agents.includes(agentId));
  for (const r of reading) r.agents.push(agentId);
  if (reading.length) changed(now);
}

// ── Outcomes ──────────────────────────────────────────────────────────────

/** The request a report is for, among those kept. */
export function findRequestFor(q: RequestQuery, now = Date.now()): DispatcherRequest | undefined {
  const r = matchRequest(load(now), q, now);
  return r && copy(r);
}

/**
 * A report for a request reached the chat: an answer closes it, a question
 * about one under way leaves it waiting on the user. Returns the request as
 * it was, for restoreRequest when the report doesn't reach the chat after
 * all, or null when nothing changed.
 */
export function settleRequest(id: string, reason: 'answer' | 'needs_user', now = Date.now()): DispatcherRequest | null {
  const r = find(id);
  if (!r) return null;
  const previous = copy(r);
  if (reason === 'answer' && r.status !== 'done') {
    r.status = 'done';
    r.endedAt = now;
  } else if (reason === 'needs_user' && r.status === 'under_way') {
    r.status = 'waiting_user';
  } else {
    return null;
  }
  changed(now);
  return previous;
}

/** Put a request back as settleRequest found it. */
export function restoreRequest(previous: DispatcherRequest, now = Date.now()): void {
  const all = load(now);
  const i = all.findIndex((r) => r.id === previous.id);
  if (i < 0) return;
  all[i] = copy(previous);
  changed(now);
}

/** End the requests that ran out of time. The timer calls this; tests may too. */
export function checkRequestTimeouts(now = Date.now()): void {
  const due = load(now).filter((r) => {
    const deadline = requestDeadline(r);
    return deadline !== null && deadline <= now;
  });
  for (const r of due) end(r, 'timed_out', now);
  if (due.length) changed(now);
  else schedule();
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const deadlines = (requests ?? []).map(requestDeadline).filter((d): d is number => d !== null);
  if (!deadlines.length) return;
  const delay = Math.min(Math.max(0, Math.min(...deadlines) - Date.now()), 2 ** 31 - 1);
  timer = setTimeout(() => { timer = null; checkRequestTimeouts(); }, delay);
  timer.unref?.();
}

/** For tests. */
export async function _resetDispatcherRequestsForTesting(): Promise<void> {
  await saving;
  if (timer) clearTimeout(timer);
  timer = null;
  requests = null;
  saving = Promise.resolve();
  listeners.clear();
  endedHandler = null;
  Object.assign(turns, { started: 0, ended: 0, open: false, openSeq: 0, error: undefined, last: null });
}

/** For tests: wait for the file to be written. */
export function _whenRequestsSavedForTesting(): Promise<void> {
  return saving;
}
