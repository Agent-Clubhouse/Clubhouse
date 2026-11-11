/**
 * The Dispatcher's background work (#3040): Clubhouse's own hidden Actions
 * for memory upkeep and check-ins, kept in step with the Behavior level.
 *
 * - Which Actions exist, and their triggers, come from the Behavior plan
 *   through backgroundActionSpecs (dispatcher-background-plan.ts), the one
 *   place buckets become triggers. They are synced at start, when the
 *   Behavior changes, and when the Dispatcher is turned on or off or gets
 *   its agent. Light runs no check-ins; an off Dispatcher runs nothing.
 * - They are owned by Clubhouse ('app'), so no list, agent page or history
 *   shows them, and they message the Dispatcher through deliverToDispatcher
 *   like any action (actions/index.ts).
 * - Before an upkeep message goes out, its gate runs the upkeep Clubhouse
 *   does itself (dispatcher-upkeep.ts) and sends only what needs judgment:
 *   pages that changed since the last upkeep, and problems it couldn't fix.
 *   With nothing to check, no message is sent and no tokens are spent.
 * - A check-in's gate sends nothing while no agent is connected. Whether its
 *   summary reaches the chat is the group chat's call (dispatcher-news.ts).
 * - What these turns use counts as background work (dispatcher-usage.ts).
 *
 * D140 holds: nothing here starts a quick agent.
 */
import * as path from 'path';
import type { DispatcherBehaviorPlan } from '../../../shared/dispatcher-behavior';
import { actionsReady, ensureAppAction, ensureAppSubscription, removeAppAction, setAppActionGate, type AppActionGate } from '../actions';
import { getBaseDirPath } from '../base-dir';
import { bindingManager } from '../clubhouse-mcp/binding-manager';
import { appLog } from '../log-service';
import {
  BACKGROUND_ACTION_NAMES,
  CHECK_IN_ACTION,
  CHECK_IN_TEXT,
  UPKEEP_IDLE_ACTION,
  UPKEEP_NIGHTLY_ACTION,
  backgroundActionSpecs,
  type BackgroundActionSpec,
} from './dispatcher-background-plan';
import { getDispatcherBehaviorPlan, onDispatcherBehaviorChanged } from './dispatcher-behavior';
import { observeMemoryPage, readMemoryAccess, readIfExists, writeFileAtomic } from './dispatcher-memory';
import { getDispatcherAgentId, getDispatcherState, onDispatcherChanged } from './dispatcher-service';
import { listMemoryPages, measureMemoryHealth, runMemoryUpkeep, type MemoryPage, type UpkeepReport } from './dispatcher-upkeep';
import { dispatcherTelemetryActive, recordMemoryHealth, recordMemoryUpkeep } from '../../telemetry/dispatcher-telemetry';
import { startDispatcherUsage } from './dispatcher-usage';

const NS = 'core:dispatcher';

/** The most pages or problems one upkeep message lists; the rest are counted. */
export const UPKEEP_LIST_MAX = 15;

export interface BackgroundDeps {
  /** Whether Actions have started. */
  ready(): boolean;
  ensureAction(name: string, input: unknown): void;
  ensureSubscription(name: string, input: Extract<BackgroundActionSpec, { kind: 'subscription' }>['input'] & { enabled: boolean }): void;
  remove(name: string): void;
  setGate(name: string, gate: AppActionGate | null): void;
  enabled(): boolean;
  dispatcherAgentId(): string | null;
  /** How many agents the Dispatcher is connected to now. */
  connectedAgents(): number;
  plan(): DispatcherBehaviorPlan;
  onBehaviorChanged(listener: () => void): () => void;
  onDispatcherChanged(listener: () => void): () => void;
  /** The memory root, or undefined for the Dispatcher's own. */
  memoryRoot(): string | undefined;
  stateFile(): string;
  now(): number;
}

const defaultDeps: BackgroundDeps = {
  ready: actionsReady,
  ensureAction: (name, input) => { ensureAppAction(name, input); },
  ensureSubscription: (name, input) => { ensureAppSubscription(name, input); },
  remove: (name) => { removeAppAction(name); },
  setGate: setAppActionGate,
  enabled: () => getDispatcherState().enabled,
  dispatcherAgentId: getDispatcherAgentId,
  connectedAgents: () => {
    const id = getDispatcherAgentId();
    return id ? bindingManager.getBindingsForAgent(id).filter((b) => b.targetKind === 'agent').length : 0;
  },
  plan: getDispatcherBehaviorPlan,
  onBehaviorChanged: (listener) => onDispatcherBehaviorChanged(() => listener()),
  onDispatcherChanged: (listener) => onDispatcherChanged(() => listener()),
  memoryRoot: () => undefined,
  stateFile: () => path.join(getBaseDirPath(), 'dispatcher-upkeep.json'),
  now: () => Date.now(),
};

let deps: BackgroundDeps = defaultDeps;

// ── Sync ───────────────────────────────────────────────────────────────────

/**
 * Make Clubhouse's hidden Actions match the Behavior plan: create or update
 * the ones it calls for, remove the rest. Returns what should exist; empty
 * while Actions are starting, the Dispatcher is off or has no agent yet.
 */
export function syncDispatcherBackground(): BackgroundActionSpec[] {
  if (!deps.ready()) return [];
  const specs = deps.enabled() ? backgroundActionSpecs(deps.plan(), deps.dispatcherAgentId()) : [];
  const wanted = new Set<string>(specs.map((s) => s.name));
  for (const spec of specs) {
    try {
      if (spec.kind === 'action') deps.ensureAction(spec.name, { ...spec.input, enabled: true });
      else deps.ensureSubscription(spec.name, { ...spec.input, enabled: true });
    } catch (err) {
      // telemetry-exempt: logged; the next Behavior or Dispatcher change syncs again
      appLog(NS, 'warn', 'Could not set up a background action for the Dispatcher', { meta: { action: spec.name, error: err instanceof Error ? err.message : String(err) } });
    }
  }
  for (const name of BACKGROUND_ACTION_NAMES) {
    if (wanted.has(name)) continue;
    try {
      deps.remove(name);
    } catch (err) {
      // telemetry-exempt: logged; it is removed at the next sync
      appLog(NS, 'warn', 'Could not remove a background action for the Dispatcher', { meta: { action: name, error: err instanceof Error ? err.message : String(err) } });
    }
  }
  return specs;
}

// ── Upkeep ─────────────────────────────────────────────────────────────────

interface UpkeepState {
  /** When upkeep finished. Pages changed after this are the next run's to check. */
  lastCheckedAt?: number;
}

async function readState(): Promise<UpkeepState> {
  try {
    const raw = JSON.parse((await readIfExists(deps.stateFile())) ?? '{}') as UpkeepState;
    return typeof raw.lastCheckedAt === 'number' ? { lastCheckedAt: raw.lastCheckedAt } : {};
  } catch {
    // telemetry-exempt: an unreadable state file checks everything once
    return {};
  }
}

/** Pages whose changes are worth checking against transcripts: topics and agents' notes. The timeline is the record itself. */
function reviewable(page: MemoryPage): boolean {
  return page.page.startsWith('topics/') || page.page.startsWith('agents/');
}

function capped<T>(items: T[], line: (item: T) => string): string[] {
  const lines = items.slice(0, UPKEEP_LIST_MAX).map((item) => `- ${line(item)}`);
  if (items.length > UPKEEP_LIST_MAX) lines.push(`- and ${items.length - UPKEEP_LIST_MAX} more`);
  return lines;
}

/**
 * What the Dispatcher is asked to check after upkeep, or null when there is
 * nothing: no page changed since the last upkeep and no problem was left.
 * Unconfirmed topics come first.
 */
export function upkeepReviewText(changed: MemoryPage[], report: UpkeepReport): string | null {
  const problems = [
    ...report.missingSources.map((m) => `${m.page}: the file it cites is gone (${m.source})`),
    ...report.brokenLinks.map((b) => `${b.page}: the link to ${b.target} goes nowhere`),
    ...report.conflictingPages.map((page) => `${page}: dated Conflicting notes need checking against their sources`),
  ];
  if (!changed.length && !problems.length && !report.neglectedPages.length) return null;
  const done: string[] = [];
  if (report.rolledUp.days.length || report.rolledUp.weeks.length) done.push('rolled the timeline up');
  if (report.linksFixed.length) done.push(`fixed ${report.linksFixed.length === 1 ? 'a link' : `${report.linksFixed.length} links`}`);
  if (report.archived.length) done.push(`moved ${report.archived.length === 1 ? 'an unconfirmed topic' : `${report.archived.length} unconfirmed topics`} nothing used into memory/archive/`);
  const parts = ['Memory upkeep.'];
  if (done.length) parts.push(`Clubhouse ${done.join(', ')}.`);
  const order = [...changed].sort((a, b) => Number(b.status === 'unconfirmed') - Number(a.status === 'unconfirmed') || (b.updatedAt ?? b.mtimeMs) - (a.updatedAt ?? a.mtimeMs));
  if (order.length) {
    parts.push(['These pages changed since the last upkeep. Check them against the transcripts they cite, using search_memory:', ...capped(order, (p) => (p.status ? `${p.page} (${p.status})` : p.page))].join('\n'));
  }
  if (problems.length) parts.push(['Clubhouse couldn’t fix these:', ...capped(problems, (p) => p)].join('\n'));
  if (report.neglectedPages.length) parts.push(['These pages have not been read or updated through the tools in 30 days (or have never been read). Read them and decide what to keep, merge or retire:', ...capped(report.neglectedPages, (p) => p)].join('\n'));
  const direct = report.directEdits.filter((page) => changed.some((p) => p.page === page) || report.neglectedPages.includes(page));
  if (direct.length) parts.push(['Direct file edits were observed on these pages. Prefer read_memory and write_memory so access and versions are recorded:', ...capped(direct, (p) => p)].join('\n'));
  parts.push('Mark a topic confirmed when a transcript backs it. Keep a short dated Conflicting: note with both sources when facts disagree, then resolve against transcripts. Fix the links and keep index.md short. This is for you, so don’t call tell_user for it. Your memory-upkeep skill has the steps.');
  return parts.join('\n\n');
}

/** The upkeep run and memory health as telemetry (#3052). Measured only while telemetry records; never fails the upkeep. */
async function recordUpkeepTelemetry(root: string, now: number, report: UpkeepReport, toCheck: number, review: boolean): Promise<void> {
  if (!dispatcherTelemetryActive()) return;
  recordMemoryUpkeep({
    outcome: 'ok',
    rolledDays: report.rolledUp.days.length,
    rolledWeeks: report.rolledUp.weeks.length,
    linksFixed: report.linksFixed.length,
    pruned: report.archived.length,
    toCheck,
    review,
  });
  try {
    recordMemoryHealth(await measureMemoryHealth(new Date(now), report, { root }));
  } catch (err) {
    // telemetry-exempt: memory health is telemetry; an unreadable page only costs this one reading
    appLog(NS, 'warn', 'Could not measure Dispatcher memory health', { meta: { error: err instanceof Error ? err.message : String(err) } });
  }
}

let upkeepChain: Promise<unknown> = Promise.resolve();

/**
 * Run upkeep now and work out what the Dispatcher should check. One run at a
 * time, so the nightly and the idle upkeep never overlap.
 */
export function runDispatcherUpkeep(): Promise<{ send: string } | { skip: string }> {
  const run = upkeepChain.then(async (): Promise<{ send: string } | { skip: string }> => {
    const root = deps.memoryRoot();
    const now = deps.now();
    const state = await readState();
    const since = state.lastCheckedAt ?? 0;
    let report: UpkeepReport;
    let changed: MemoryPage[];
    try {
      report = await runMemoryUpkeep(new Date(now), { root });
      const checkedAt = deps.now();
      const pages = await listMemoryPages(root, checkedAt);
      for (const { page } of pages) await observeMemoryPage(page, root, checkedAt);
      const access = await readMemoryAccess(root);
      changed = pages.filter((p) => {
        const entry = access[p.page];
        const updated = entry?.lastAgentWrite ?? (entry?.lastClubhouseWrite ? 0 : p.updatedAt ?? p.mtimeMs);
        return updated > since && reviewable(p);
      });
      await writeFileAtomic(deps.stateFile(), `${JSON.stringify({ lastCheckedAt: checkedAt } satisfies UpkeepState)}\n`);
    } catch (err) {
      recordMemoryUpkeep({ outcome: 'error' });
      throw err;
    }
    appLog(NS, 'info', 'Dispatcher memory upkeep', {
      meta: {
        rolledDays: report.rolledUp.days.length,
        rolledWeeks: report.rolledUp.weeks.length,
        linksFixed: report.linksFixed.length,
        archived: report.archived.length,
        brokenLinks: report.brokenLinks.length,
        missingSources: report.missingSources.length,
        directEdits: report.directEdits.length,
        neglectedPages: report.neglectedPages.length,
        toCheck: changed.length,
      },
    });
    const text = upkeepReviewText(changed, report);
    await recordUpkeepTelemetry(root, now, report, changed.length, text !== null);
    return text ? { send: text } : { skip: 'Memory is up to date; nothing needed checking.' };
  });
  upkeepChain = run.catch((): void => undefined);
  return run;
}

const upkeepGate: AppActionGate = () => runDispatcherUpkeep();

const checkInGate: AppActionGate = async () => {
  if (!deps.enabled()) return { skip: 'The Dispatcher is off.' };
  if (deps.connectedAgents() === 0) return { skip: 'No agents are connected, so there was nothing to check on.' };
  return { send: CHECK_IN_TEXT };
};

// ── Start ──────────────────────────────────────────────────────────────────

let stop: (() => void) | null = null;

/**
 * Start the Dispatcher's background work: usage counting, the gates, and the
 * hidden Actions, synced now and on every Behavior or Dispatcher change.
 * Call after Actions start. Returns a stop function.
 */
export function startDispatcherBackground(): () => void {
  if (stop) return stop;
  startDispatcherUsage();
  deps.setGate(UPKEEP_NIGHTLY_ACTION, upkeepGate);
  deps.setGate(UPKEEP_IDLE_ACTION, upkeepGate);
  deps.setGate(CHECK_IN_ACTION, checkInGate);
  let last = '';
  const resyncIfMoved = () => {
    // Its agent starting or stopping changes nothing here; on/off and its agent id do.
    const key = JSON.stringify({ enabled: deps.enabled(), id: deps.dispatcherAgentId() });
    if (key === last) return;
    last = key;
    syncDispatcherBackground();
  };
  resyncIfMoved();
  const unsubs = [deps.onBehaviorChanged(() => { syncDispatcherBackground(); }), deps.onDispatcherChanged(resyncIfMoved)];
  stop = () => {
    for (const u of unsubs) u();
    for (const name of BACKGROUND_ACTION_NAMES) deps.setGate(name, null);
    stop = null;
  };
  return stop;
}

/** For tests: replace any of the wiring. */
export function _setBackgroundDepsForTesting(next: Partial<BackgroundDeps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
}

export function _resetDispatcherBackgroundForTesting(): void {
  stop?.();
  stop = null;
  deps = defaultDeps;
  upkeepChain = Promise.resolve();
}
