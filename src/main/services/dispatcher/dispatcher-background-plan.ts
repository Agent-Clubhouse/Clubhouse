/**
 * The one place that turns the Behavior's named frequency buckets
 * (shared/dispatcher-behavior.ts) into Action triggers (#3040). Pure: it
 * takes a plan and the Dispatcher's agent id and returns the hidden Actions
 * that should exist, so each level's triggers are testable without an engine.
 *
 * Times live only here and can be tuned without touching the Behavior table.
 * No UI text gives any of them: the Behavior picker says "occasionally" and
 * "frequently".
 */

import type { ActionStep, EventTrigger, ScheduleTrigger } from '../../../shared/actions';
import type { CheckInFrequency, DispatcherBehaviorPlan, UpkeepFrequency } from '../../../shared/dispatcher-behavior';

/**
 * The hidden Actions' names. Clubhouse's own actions are looked up by name
 * (ensureAppAction), and the name is the tag an action message carries.
 */
export const UPKEEP_NIGHTLY_ACTION = 'Dispatcher memory upkeep';
export const UPKEEP_IDLE_ACTION = 'Dispatcher memory upkeep after idle time';
export const CHECK_IN_ACTION = 'Dispatcher check-in';

export const BACKGROUND_ACTION_NAMES = [UPKEEP_NIGHTLY_ACTION, UPKEEP_IDLE_ACTION, CHECK_IN_ACTION] as const;
export type BackgroundActionName = (typeof BACKGROUND_ACTION_NAMES)[number];

export type BackgroundWork = 'upkeep' | 'check_in';

/** Nightly upkeep, local time. A night missed while the app was closed runs once at the next launch. */
export const NIGHTLY_UPKEEP_CRON = '30 3 * * *';

/**
 * Check-ins per bucket, local time, or null for none. They run in the day,
 * when someone may read the summary; one missed while the app was closed is
 * skipped, since the next one covers it.
 *   occasionally: every three hours, 9:00 to 21:00
 *   frequently:   every hour, 8:00 to 22:00
 */
export const CHECK_IN_CRON: Readonly<Record<CheckInFrequency, string | null>> = {
  none: null,
  occasionally: '0 9-21/3 * * *',
  frequently: '0 8-22 * * *',
};

/**
 * Upkeep after the Dispatcher has been idle this many minutes, or null for
 * nightly only. "Long idle" is a long break; "each idle" is any pause in the work.
 */
export const IDLE_UPKEEP_MINUTES: Readonly<Record<UpkeepFrequency, number | null>> = {
  nightly: null,
  nightly_and_long_idle: 120,
  nightly_and_each_idle: 20,
};

/**
 * What the upkeep message says when Clubhouse has nothing more specific. The
 * upkeep gate (dispatcher-background.ts) replaces it with the pages to check,
 * or sends nothing when there are none.
 */
export const UPKEEP_FALLBACK_TEXT = 'Memory upkeep: check the notes in memory/ that changed lately against the transcripts they cite, using search_memory. Mark a topic confirmed when a transcript backs it, fix what a transcript contradicts, and fix broken links. Keep index.md short. This is for you, so don’t call tell_user for it. Your memory-upkeep skill has the steps.';

/**
 * A check-in summary shows only when routine news is held for it (dispatcher-triage), so what the
 * check-in finds goes in as routine news first.
 */
export const CHECK_IN_TEXT = 'First call list_remote_requests and triage live remote requests held for check_in, using their authenticated origin and your local grants. Check-in: look at what your connected agents have done since the last check-in, without waking anyone. Report each change the user would want to know with tell_user, kind routine. Then call tell_user once with kind check_in and a one-sentence summary; it shows only when news is waiting for it. Note anything worth keeping in memory. Your check-ins skill has the steps.';

/** A hidden Action that should exist: a scheduled one, or an event subscription that tells the Dispatcher. */
export type BackgroundActionSpec =
  | {
    name: BackgroundActionName;
    work: BackgroundWork;
    kind: 'action';
    input: { trigger: ScheduleTrigger; steps: ActionStep[]; overlap: 'skip' };
  }
  | {
    name: BackgroundActionName;
    work: BackgroundWork;
    kind: 'subscription';
    input: { trigger: EventTrigger; note: string };
  };

function schedule(cron: string, preset: ScheduleTrigger['preset'], missed: ScheduleTrigger['missed']): ScheduleTrigger {
  return { kind: 'schedule', preset, cron, missed };
}

/**
 * The hidden Actions a Behavior plan calls for. Every one tells the
 * Dispatcher (its agent id), so there are none without one. Names not in the
 * list should not exist.
 */
export function backgroundActionSpecs(plan: DispatcherBehaviorPlan, dispatcherAgentId: string | null | undefined): BackgroundActionSpec[] {
  if (!dispatcherAgentId) return [];
  const message = (text: string): ActionStep[] => [{ kind: 'message', agentId: dispatcherAgentId, text }];
  const specs: BackgroundActionSpec[] = [{
    name: UPKEEP_NIGHTLY_ACTION,
    work: 'upkeep',
    kind: 'action',
    input: { trigger: schedule(NIGHTLY_UPKEEP_CRON, 'daily', 'once'), steps: message(UPKEEP_FALLBACK_TEXT), overlap: 'skip' },
  }];
  const idle = IDLE_UPKEEP_MINUTES[plan.upkeep];
  if (idle) {
    specs.push({
      name: UPKEEP_IDLE_ACTION,
      work: 'upkeep',
      kind: 'subscription',
      // #2918's goes-idle trigger, on the agent that does the work and writes memory.
      input: { trigger: { kind: 'event', event: 'agent.idle', source: { kind: 'agent', agentId: dispatcherAgentId }, delayMinutes: idle }, note: UPKEEP_FALLBACK_TEXT },
    });
  }
  const checkIn = CHECK_IN_CRON[plan.checkIns];
  if (checkIn) {
    specs.push({
      name: CHECK_IN_ACTION,
      work: 'check_in',
      kind: 'action',
      input: { trigger: schedule(checkIn, 'cron', 'skip'), steps: message(CHECK_IN_TEXT), overlap: 'skip' },
    });
  }
  return specs;
}

/** Which kind of work a hidden Action does, by its name, or undefined for any other action. */
export function backgroundWorkOf(name: string): BackgroundWork | undefined {
  if (name === UPKEEP_NIGHTLY_ACTION || name === UPKEEP_IDLE_ACTION) return 'upkeep';
  if (name === CHECK_IN_ACTION) return 'check_in';
  return undefined;
}
