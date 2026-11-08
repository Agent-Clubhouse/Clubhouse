/**
 * What each Actions step does (#2918). A step that couldn't do its job comes
 * back failed with one line of reason: that is a mechanical failure, the only
 * kind that notifies.
 *
 * - Wake: resumes the agent's last session, as waking by hand or over MCP
 *   does, with the prompt as its first message. An agent already awake gets
 *   the prompt as a message.
 * - Message: a busy chat agent gets it queued for its next turn; an asleep
 *   agent is woken with it.
 * - Quick agent: started through the shared quick agent service, named after
 *   the action, in the project root or another agent's worktree.
 * - Sleep: a chat agent mid-turn is given up to 10 minutes to finish first.
 * - Notify: a Clubhouse notification, following Notifications & alerts.
 * - The Dispatcher as a wake or message target (its own subscriptions,
 *   #3042) goes through deliverToDispatcher, the one path for messages to it
 *   (#3037), which wakes it when it is asleep.
 *
 * A run an event set off says what happened, so a subscriber knows why it
 * was told ("What happened: web is pushed, pulled or fetched (main).").
 */

import { QUICK_STEP_ACCESS, type ActionOwner, type ActionStep, type ActionStepResult } from '../../../shared/actions';
import type { ChatSessionState, RoutedMessagePart } from '../../../shared/chat';
import { setAgentChain } from '../app-event-bus';
import { getAgentRuntime, isAgentStoppingError } from '../agent-runtime';
import type { StepContext, StepRunner } from './engine';
import type { AccessLevel } from '../../../shared/agent-access';

export interface StepDeps {
  agentExists(agentId: string): boolean;
  agentName(agentId: string): string | undefined;
  agentWorktree(agentId: string): string | undefined;
  isRunning(agentId: string): boolean;
  project(projectId: string): { id: string; path: string; orchestrator?: string; name: string } | undefined;
  /** wakeWiredAgent's JSON result: status, and whether a mission was delivered. */
  wake(req: { callerId: string; targetId: string; targetName: string; mission?: string; missionRouted?: RoutedMessagePart[] }): Promise<{ ok: boolean; status?: string; messageDelivered?: boolean; text: string }>;
  sleep(req: { callerId: string; targetId: string; targetName: string }): Promise<{ ok: boolean; status?: string; text: string }>;
  startQuick(req: { project: { id: string; path: string }; cwd: string; prompt: string; orchestrator: string; model?: string; access: AccessLevel; headless: true; name: string }): Promise<{ id: string; name: string }>;
  notify(title: string, body: string): { shown: boolean; reason?: string };
  /** The Dispatcher, reached only through its one delivery path. Unset: no agent is the Dispatcher. */
  dispatcher?: {
    is(agentId: string): boolean;
    deliver(req: DispatcherStepDelivery): Promise<{ delivered: true; woke: boolean } | { delivered: false; text: string }>;
  };
  /**
   * Why the owner may not wake this agent, or null. A message step finds its
   * agent asleep: it wakes it only if the owner may (D131), as send_message
   * never wakes a sleeping agent. Unset: always may.
   */
  wakeRefusal?(owner: ActionOwner, agentId: string): string | null;
  /** For tests: how long sleep waits for a busy turn. */
  sleepWaitMs?: number;
}

export interface DispatcherStepDelivery {
  /** Whose grants the wake follows: the owning agent, or the Dispatcher itself for its own and Clubhouse's actions. */
  senderId: string;
  targetId: string;
  targetName: string;
  actionId: string;
  text: string;
  routed: RoutedMessagePart[];
}

const BUSY: ReadonlySet<ChatSessionState> = new Set(['starting', 'running', 'waiting_permission', 'waiting_input']);
const SLEEP_WAIT_MS = 10 * 60 * 1000;

type Delivered = 'delivered' | 'not_running' | 'stopping';

/** Send text to a running agent. A busy chat agent gets it queued for its next turn. */
async function deliver(targetId: string, text: string, routed: RoutedMessagePart[]): Promise<Delivered> {
  const runtime = getAgentRuntime(targetId);
  if (!runtime?.isRunning()) return 'not_running';
  const busy = runtime.kind === 'chat' && BUSY.has(runtime.getState());
  try {
    await runtime.sendMessage(text, { source: 'action', routed, taskId: `action_${Date.now().toString(36)}`, ...(busy && { delivery: 'queued' }) });
  } catch (err) {
    if (isAgentStoppingError(err)) return 'stopping';
    throw err;
  }
  return 'delivered';
}

/** Wait for a busy chat agent's turn to end, up to `ms`. Terminal agents' turn state is unknown: no wait. */
function waitForIdle(targetId: string, ms: number): Promise<void> {
  const runtime = getAgentRuntime(targetId);
  if (!runtime || runtime.kind !== 'chat' || !BUSY.has(runtime.getState())) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const off = runtime.onStateChange((state) => { if (!BUSY.has(state)) done(); });
    function done() {
      clearTimeout(timer);
      off();
      resolve();
    }
  });
}

/**
 * The text an agent receives, tagged so it knows an action sent it. A run an
 * event set off adds what happened.
 */
export function actionMessage(actionName: string, text: string, happened?: string): { text: string; routed: RoutedMessagePart[] } {
  const what = happened ? `\nWhat happened: ${happened}.` : '';
  return {
    text: `[Clubhouse action “${actionName}”] ${text}${what}`,
    routed: [{ fromClubhouse: true, text: `Action “${actionName}”: ${text}${what}` }],
  };
}

/** The event that set the run off, in plain words, or undefined for schedules and Run now. */
function happenedOf(ctx: StepContext): string | undefined {
  return ctx.trigger?.kind === 'event' ? ctx.trigger.detail : undefined;
}

export function createStepRunner(deps: StepDeps): StepRunner {
  const fail = (step: ActionStep, detail: string, agentId?: string): ActionStepResult => ({ kind: step.kind, outcome: 'failed', detail, ...(agentId && { agentId }) });
  const done = (step: ActionStep, detail: string, extra: { agentId?: string; projectId?: string } = {}): ActionStepResult => ({ kind: step.kind, outcome: 'done', detail, ...extra });

  async function wakeOrMessage(step: ActionStep & { agentId: string }, ctx: StepContext, text: string | undefined): Promise<ActionStepResult> {
    const id = step.agentId;
    const name = deps.agentName(id) ?? 'The agent';
    if (!deps.agentExists(id)) return fail(step, `${name} is gone.`, id);
    const callerId = `action:${ctx.action.id}`;
    // Its next events count as caused by this run, for loop protection.
    setAgentChain(id, ctx.chain);
    const msg = text ? actionMessage(ctx.action.name, text, happenedOf(ctx)) : undefined;
    if (deps.dispatcher?.is(id)) return toDispatcher(step, ctx, id, name, msg);
    if (deps.isRunning(id)) {
      if (!msg) return done(step, `${name} was already awake`, { agentId: id });
      const delivery = await deliver(id, msg.text, msg.routed);
      if (delivery === 'delivered') return done(step, `Sent the message to ${name}`, { agentId: id });
      if (delivery === 'stopping') return fail(step, `Couldn’t deliver the message: ${name} was going to sleep.`, id);
      // It went to sleep in between: wake it with the message below.
    }
    const refused = step.kind === 'message' ? deps.wakeRefusal?.(ctx.action.owner, id) : null;
    if (refused) return fail(step, `${name} is asleep, so the message wasn\u2019t sent. ${refused}`, id);
    const result = await deps.wake({ callerId, targetId: id, targetName: name, ...(msg && { mission: msg.text, missionRouted: msg.routed }) });
    if (!result.ok) return fail(step, `Couldn’t wake ${name}: ${result.text}`, id);
    if (result.status === 'stopping') return fail(step, `Couldn’t wake ${name}: it was still going to sleep.`, id);
    if (result.status === 'starting' && msg) return fail(step, `Couldn’t deliver the message: ${name} was already starting.`, id);
    if (msg && result.messageDelivered === false) return fail(step, `Couldn’t deliver the message to ${name}.`, id);
    return done(step, msg ? `Woke ${name} with the message` : `Woke ${name}`, { agentId: id });
  }

  /** A wake or message for the Dispatcher, through its one delivery path (#3037). */
  async function toDispatcher(step: ActionStep, ctx: StepContext, id: string, name: string, msg: { text: string; routed: RoutedMessagePart[] } | undefined): Promise<ActionStepResult> {
    if (!msg && deps.isRunning(id)) return done(step, `${name} was already awake`, { agentId: id });
    const owner = ctx.action.owner;
    const body = msg ?? actionMessage(ctx.action.name, 'This action woke you.', happenedOf(ctx));
    try {
      const delivery = await deps.dispatcher!.deliver({
        // An agent's action wakes the Dispatcher only as far as that agent may (#2921).
        senderId: owner.kind === 'agent' ? owner.agentId : id,
        targetId: id,
        targetName: name,
        actionId: ctx.action.id,
        text: body.text,
        routed: body.routed,
      });
      if (delivery.delivered === false) return fail(step, `Couldn’t deliver the message: ${delivery.text}`, id);
      if (!msg) return done(step, `Woke ${name}`, { agentId: id });
      return done(step, delivery.woke ? `Woke ${name} with the message` : `Sent the message to ${name}`, { agentId: id });
    } catch (err) {
      // telemetry-exempt: the reason is the step's result, shown and toasted
      if (isAgentStoppingError(err)) return fail(step, `Couldn’t deliver the message: ${name} was going to sleep.`, id);
      return fail(step, `Couldn’t deliver the message to ${name}: ${err instanceof Error ? err.message : String(err)}`, id);
    }
  }

  return {
    async run(step, ctx) {
      switch (step.kind) {
        case 'wake':
          return wakeOrMessage(step, ctx, step.prompt);
        case 'message':
          return wakeOrMessage(step, ctx, step.text);
        case 'sleep': {
          const id = step.agentId;
          const name = deps.agentName(id) ?? 'The agent';
          if (!deps.agentExists(id)) return fail(step, `${name} is gone.`, id);
          if (!deps.isRunning(id)) return done(step, `${name} was already asleep`, { agentId: id });
          // Its sleep event counts as caused by this run, for loop protection.
          setAgentChain(id, ctx.chain);
          await waitForIdle(id, deps.sleepWaitMs ?? SLEEP_WAIT_MS);
          const result = await deps.sleep({ callerId: `action:${ctx.action.id}`, targetId: id, targetName: name });
          if (!result.ok) return fail(step, `Couldn’t put ${name} to sleep: ${result.text}`, id);
          return done(step, `Put ${name} to sleep`, { agentId: id });
        }
        case 'quick': {
          const project = deps.project(step.projectId);
          if (!project) return fail(step, 'Its project is no longer in Clubhouse.');
          let cwd = project.path;
          if (step.worktreeAgentId) {
            const worktree = deps.agentWorktree(step.worktreeAgentId);
            const owner = deps.agentName(step.worktreeAgentId) ?? 'The agent';
            if (!deps.agentExists(step.worktreeAgentId)) return fail(step, `${owner} is gone, so its worktree is too.`);
            if (worktree) cwd = worktree;
          }
          try {
            const orchestrator = step.orchestrator || project.orchestrator || 'claude-code';
            const started = await deps.startQuick({
              project: { id: project.id, path: project.path },
              cwd,
              prompt: actionMessage(ctx.action.name, step.prompt).text,
              orchestrator,
              ...(step.model && { model: step.model }),
              // Headless at Full access, whatever the project's spawn mode, so an
              // unattended run never waits at a prompt (#3033).
              access: QUICK_STEP_ACCESS,
              headless: true,
              name: ctx.action.name,
            });
            // Commits it makes in a worktree carry this run's chain on.
            setAgentChain(started.id, ctx.chain);
            return done(step, `Started a quick agent in ${project.name}`, { agentId: started.id, projectId: project.id });
          } catch (err) {
            // telemetry-exempt: the reason is the step's result, shown and toasted
            return fail(step, `Couldn’t start a quick agent: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        case 'notify': {
          const shown = deps.notify(ctx.action.name, step.text);
          return done(step, shown.shown ? 'Notified you' : `Not shown: ${shown.reason ?? 'notifications are off'}`);
        }
      }
    },
  };
}
