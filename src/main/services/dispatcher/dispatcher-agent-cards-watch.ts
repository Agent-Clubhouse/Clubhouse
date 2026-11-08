/**
 * Agent cards (#3041) wired to the app: the live services behind
 * dispatcher-agent-cards, and what makes it look again.
 *
 * - An agent's config changes (its Connect to Dispatcher switch, its
 *   orchestration, its setup): that project is read again.
 * - The Dispatcher is turned on or off, or a project is added or removed:
 *   every project is read.
 * - An agent's wires change, or a turn of its ends: a request waiting for it
 *   goes out, now that it can answer.
 */

import * as path from 'path';
import { app } from 'electron';
import type { ChatSessionState, RoutedMessagePart } from '../../../shared/chat';
import { getBaseDirPath } from '../base-dir';
import * as projectStore from '../project-store';
import { listDurable, onAgentConfigChanged } from '../agent-config';
import { resolveOrchestrationPolicies } from '../orchestration-policy';
import { getAgentRuntime, isAgentStoppingError } from '../agent-runtime';
import { bindingManager } from '../clubhouse-mcp/binding-manager';
import { onAppEvent } from '../app-event-bus';
import { appLog } from '../log-service';
import {
  DISPATCHER_NAME,
  getDispatcherAgentId,
  isDispatcherEnabled,
  isDispatcherPath,
  onDispatcherChanged,
} from './dispatcher-service';
import { AgentCards, type AgentCardDeps, type CardDelivery } from './dispatcher-agent-cards';
import { notifyAgentCardChanged, setAgentCardSource, type AgentCardSource } from './dispatcher-agent-card-source';

const NS = 'core:dispatcher';

const BUSY: ReadonlySet<ChatSessionState> = new Set(['starting', 'running', 'waiting_permission', 'waiting_input']);

/** Where what was asked and answered is kept: beside the Dispatcher's folder, not in it. */
export function getAgentCardStorePath(): string {
  return path.join(getBaseDirPath(), 'dispatcher-agent-cards.json');
}

function activeDispatcherId(): string | null {
  return isDispatcherEnabled() ? getDispatcherAgentId() : null;
}

/** Whether the agent has its wire to the Dispatcher now. */
export function isWiredToDispatcher(agentId: string): boolean {
  const dispatcherId = activeDispatcherId();
  if (!dispatcherId || agentId === dispatcherId) return false;
  return bindingManager.getBindingsForAgent(agentId).some((b) => b.targetKind === 'agent' && b.targetId === dispatcherId);
}

/**
 * Test/E2E seam: `CLUBHOUSE_TEST_NO_CARD_REQUESTS=1` keeps card requests from
 * being sent, so a fake CLI replaying a script never gets a prompt it doesn't
 * expect. Requests are still recorded; they just never go out. Honored ONLY in
 * unpackaged builds.
 */
export function testCardRequestsDisabled(): boolean {
  return process.env.CLUBHOUSE_TEST_NO_CARD_REQUESTS === '1' && !app.isPackaged;
}

/** Put the text in front of a running agent. A busy chat agent gets it queued for its next turn. */
async function send(agentId: string, text: string, routed: RoutedMessagePart[]): Promise<CardDelivery> {
  if (testCardRequestsDisabled()) return 'not_running';
  const runtime = getAgentRuntime(agentId);
  if (!runtime?.isRunning()) return 'not_running';
  const busy = runtime.kind === 'chat' && BUSY.has(runtime.getState());
  try {
    await runtime.sendMessage(text, { source: 'mcp', routed, taskId: `card_${Date.now().toString(36)}`, ...(busy && { delivery: 'queued' }) });
  } catch (err) {
    if (isAgentStoppingError(err)) return 'stopping';
    throw err;
  }
  return 'delivered';
}

/** Each one reads its service when called, not when this module loads. */
export const liveAgentCardDeps: AgentCardDeps = {
  storePath: () => getAgentCardStorePath(),
  activeDispatcherId: () => activeDispatcherId(),
  dispatcherName: () => DISPATCHER_NAME,
  isDispatcherPath: (projectPath) => isDispatcherPath(projectPath),
  listProjects: async () => (await projectStore.list()).map((p) => ({ path: p.path, name: p.displayName || p.name })),
  listAgents: (projectPath) => listDurable(projectPath),
  connectedIds: async (projectPath, agents) => {
    if (agents.length === 0) return new Set<string>();
    const policies = await resolveOrchestrationPolicies(projectPath, agents);
    return new Set(agents.filter((a) => policies.get(a.id)?.connectToDispatcher).map((a) => a.id));
  },
  isWiredToDispatcher: (agentId) => isWiredToDispatcher(agentId),
  send: (agentId, text, routed) => send(agentId, text, routed),
  log: (level, message, meta) => appLog(NS, level, message, { meta }),
  changed: (agentIds) => { for (const id of agentIds) notifyAgentCardChanged(id); },
};

/** What an agent's Dispatcher card in Details reads and saves (#3049). */
export function agentCardSourceFor(cards: AgentCards): AgentCardSource {
  return {
    status: (agentId) => cards.view(agentId),
    saveUserCard: async (agentId, fields) => {
      const result = await cards.saveUserCard(agentId, fields);
      if (!result.ok) throw new Error((result as { error: string }).error);
      return (await cards.view(agentId)) ?? { state: 'ready', card: result.card };
    },
  };
}

let instance: AgentCards | null = null;

/** The app's agent cards. */
export function getAgentCards(): AgentCards {
  instance ??= new AgentCards(liveAgentCardDeps);
  return instance;
}

/** For tests: use this instance instead, or null for a fresh live one. */
export function _setAgentCardsForTesting(cards: AgentCards | null): void {
  instance = cards;
}

function logFailure(what: string) {
  return (err: unknown): void => {
    // telemetry-exempt: logged; the next change tries again
    appLog(NS, 'warn', `Agent cards: ${what} failed`, { meta: { error: err instanceof Error ? err.message : String(err) } });
  };
}

/**
 * Keep agent cards in step with connections and setups. Syncs once now.
 * Returns the unsubscribe.
 */
export function watchAgentCards(cards: AgentCards = getAgentCards()): () => void {
  setAgentCardSource(agentCardSourceFor(cards));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let all = true;
  const dirty = new Set<string>();

  const run = (): void => {
    timer = null;
    const paths = all ? undefined : new Set(dirty);
    all = false;
    dirty.clear();
    cards.sync(paths).catch(logFailure('sync'));
  };
  // Coalesce a burst of config writes, and stay out of the writer's call stack.
  const schedule = (): void => {
    if (!timer) timer = setTimeout(run, 250);
  };

  const unsubscribers = [
    onAgentConfigChanged((projectPath) => {
      if (isDispatcherPath(projectPath)) return;
      dirty.add(projectPath);
      schedule();
    }),
    onDispatcherChanged(() => { all = true; schedule(); }),
    projectStore.onProjectsChanged(() => { all = true; schedule(); }),
    bindingManager.onChange((agentId) => { cards.deliver(agentId).catch(logFailure('delivery')); }),
    onAppEvent((event) => {
      if (event.type === 'turn.ended') cards.deliver(event.agentId).catch(logFailure('delivery'));
    }),
  ];
  schedule();
  return () => {
    setAgentCardSource(null);
    for (const unsubscribe of unsubscribers) unsubscribe();
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
