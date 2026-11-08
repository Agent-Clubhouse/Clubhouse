/**
 * The app-wide Dispatcher (#2533, #2535): one durable agent in its own folder
 * under the Clubhouse base dir, in no project. Its config lives in the
 * folder's `.clubhouse/agents.json` like any agent's, so the usual agent
 * config store reads and writes it; it is never added to projectStore.
 *
 * Instructions are a file: Clubhouse's own Dispatcher text
 * (`dispatcher-instructions.md`) is written to the provider's instructions
 * file in the folder at create, on app start and whenever its CLI changes.
 * There is no systemPrompt path. The Dispatcher is known by its folder and
 * its agent id (isDispatcherPath, isDispatcherAgentId), never by a persona:
 * one created before #2901 still has `persona: 'dispatcher'` in its config,
 * which nothing reads.
 *
 * On by default in the new layout: a missing switch creates the agent's record
 * and writes its instructions. Nothing here ever starts it, so that costs no
 * tokens. See resolveDispatcherEnablement for the rules.
 *
 * Turning its switch off stops the agent and leaves the folder, `notes/` and the
 * config alone, so turning it back on resumes where it left off. MCP going off
 * at app level derives it off and stops nothing: a running Dispatcher keeps
 * running, loses its connections, and can't be started again until MCP is back,
 * when it returns to what its saved values say without being started.
 */
import { withSavedAccess } from '../free-agent-settings';
import * as fsp from 'fs/promises';
import * as agentConfig from '../agent-config';
import * as agentSystem from '../agent-system';
import { getAllProviders, getProvider, type OrchestratorId } from '../../orchestrators';
import { getSettings as getOrchestratorSettings, whenDefaultsDetected } from '../orchestrator-settings';
import dispatcherInstructions from './dispatcher-instructions.md';
import { appLog } from '../log-service';
import { AGENT_COLORS } from '../../../shared/name-generator';
import type { DispatcherState } from '../../../shared/dispatcher-types';
import type { DurableAgentConfig } from '../../../shared/types';
import { agentRegistry } from '../agent-registry';
import { newChromeEnabled } from '../../window-chrome';
import { DISPATCHER_CLASSIC_MESSAGE } from '../../../shared/dispatcher-types';
import { getDispatcherNotesPath, getDispatcherPath, isDispatcherPath } from './dispatcher-paths';
import { dispatcherEnablement, getSettings as getDispatcherSettings, isDispatcherEnabled, updateSettings } from './dispatcher-settings';

export { getDispatcherPath, getDispatcherNotesPath, isDispatcherPath } from './dispatcher-paths';
export { isDispatcherEnabled, DISPATCHER_FLAG } from './dispatcher-settings';

const NS = 'core:dispatcher';
/** What the Dispatcher's instructions file holds. Clubhouse owns it: there is no project or user copy. */
export const DISPATCHER_INSTRUCTIONS: string = dispatcherInstructions;
export const DISPATCHER_NAME = 'Dispatcher';

/** The last config read from disk; null before the Dispatcher was first created. */
let config: DurableAgentConfig | null = null;
/** The CLI whose instructions file was last written, so a CLI change rewrites it. */
let instructionsWrittenFor: string | null = null;
/** Every change runs after the previous one, so two toggles can't race a create. */
let queue: Promise<unknown> = Promise.resolve();
let lastBroadcast = '';
let stopWatching: (() => void) | null = null;

type DispatcherListener = (state: DispatcherState) => void;
const listeners = new Set<DispatcherListener>();

/** The Dispatcher's agent id, or null before it was first created. Kept while it is off. */
export function getDispatcherAgentId(): string | null {
  return config?.id ?? null;
}

/** True for the Dispatcher's agent id. */
export function isDispatcherAgentId(agentId: string | undefined | null): boolean {
  return !!agentId && agentId === config?.id;
}

export function getDispatcherState(): DispatcherState {
  const { enabled, savedOn, reason } = dispatcherEnablement();
  return {
    enabled,
    flagOn: true,
    savedOn,
    offReason: reason,
    classic: !newChromeEnabled(),
    running: !!config && !!agentRegistry.get(config.id),
    agentId: config?.id ?? null,
    path: config ? getDispatcherPath() : null,
    // Access (#2761) filled in for a Dispatcher saved before it.
    config: config ? withSavedAccess({ ...config }, getDispatcherPath()) : null,
  };
}

/**
 * Called with the new state whenever the gate, the agent id or its config
 * changes. Listeners run synchronously. Returns an unsubscribe function.
 */
export function onDispatcherChanged(listener: DispatcherListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function emitChanged(): void {
  const state = getDispatcherState();
  const key = JSON.stringify(state);
  if (key === lastBroadcast) return;
  lastBroadcast = key;
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (err) {
      // telemetry-exempt: logged; one listener must not stop the others
      appLog(NS, 'warn', 'Dispatcher change listener failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch((): void => undefined);
  return run;
}

/**
 * The CLI a new Dispatcher starts on: the app's default, picked the way the
 * New agent page picks it (the first enabled provider in registration order).
 */
export function defaultDispatcherOrchestrator(): OrchestratorId | undefined {
  const enabled = getOrchestratorSettings().enabled ?? [];
  const providers = getAllProviders();
  return (providers.find((p) => enabled.includes(p.id)) ?? providers[0])?.id;
}

async function readConfig(): Promise<DurableAgentConfig | null> {
  const dir = getDispatcherPath();
  try {
    await fsp.access(dir);
  } catch {
    // telemetry-exempt: no folder means it was never turned on
    return null;
  }
  const agents = await agentConfig.listDurable(dir);
  return agents[0] ?? null;
}

/** Create the Dispatcher the first time. Idempotent: an existing record is kept as it is. */
async function ensureCreated(): Promise<DurableAgentConfig> {
  const dir = getDispatcherPath();
  await fsp.mkdir(getDispatcherNotesPath(), { recursive: true });
  const existing = await readConfig();
  if (existing) return existing;
  // On by default means this can run at first launch: wait for what the probe finds, so it isn't pinned to a CLI the user doesn't have.
  await whenDefaultsDetected();
  const orchestrator = defaultDispatcherOrchestrator();
  const created = await agentConfig.createDurable(
    dir,
    DISPATCHER_NAME,
    AGENT_COLORS[0].id,
    undefined, // the CLI's default model
    false,
    orchestrator,
    true, // free agent mode
  );
  await agentConfig.updateDurableConfig(dir, created.id, { idleSleep: 'never', runtimeMode: 'chat' });
  appLog(NS, 'info', 'Dispatcher created', { meta: { agentId: created.id, orchestrator } });
  return (await agentConfig.getDurableConfig(dir, created.id)) ?? created;
}

/** Write the Dispatcher's instructions to the CLI's instructions file in the folder. */
async function writeInstructions(agent: DurableAgentConfig): Promise<void> {
  const dir = getDispatcherPath();
  const providerId = agent.orchestrator ?? defaultDispatcherOrchestrator();
  const provider = providerId ? getProvider(providerId) : undefined;
  if (!provider) {
    appLog(NS, 'warn', 'No provider to write Dispatcher instructions for', { meta: { orchestrator: providerId } });
    return;
  }
  await provider.writeInstructions(dir, DISPATCHER_INSTRUCTIONS);
  instructionsWrittenFor = provider.id;
}

async function stopAgent(agent: DurableAgentConfig): Promise<void> {
  if (!agentSystem.isAgentRunning(agent.id)) return;
  appLog(NS, 'info', 'Stopping the Dispatcher', { meta: { agentId: agent.id } });
  await agentSystem.killAgent(agent.id, getDispatcherPath(), agent.orchestrator);
}

/**
 * Bring the agent in line with the gate: create and write instructions when on.
 * Only its saved values going off stop it, never MCP. Starts nothing.
 */
async function reconcile(): Promise<void> {
  watchChanges();
  const { enabled, savedOn } = dispatcherEnablement();
  if (enabled) {
    config = await ensureCreated();
    await writeInstructions(config);
  } else {
    config = await readConfig();
    if (config && !savedOn) await stopAgent(config);
  }
  emitChanged();
}

function watchChanges(): void {
  if (stopWatching) return;
  const unsubscribers = [agentConfig.onAgentConfigChanged((projectPath) => {
    if (!isDispatcherPath(projectPath)) return;
    void enqueue(async () => {
      const next = await readConfig();
      config = next;
      // A CLI change gets the new provider's instructions file.
      if (next && isDispatcherEnabled() && (next.orchestrator ?? defaultDispatcherOrchestrator()) !== instructionsWrittenFor) {
        await writeInstructions(next);
      }
      emitChanged();
    }).catch((err) => {
      appLog(NS, 'warn', 'Dispatcher config refresh failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    });
  }),
  // Its row and view stay while it runs.
  agentRegistry.onAuthChange((agentId) => { if (agentId === config?.id) emitChanged(); })];
  stopWatching = () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
}

/**
 * At app start: read the existing record, and when the Dispatcher is on,
 * create it if needed and rewrite its instructions so a new app version's text reaches it.
 * Creates nothing while it is off, and never starts it.
 */
export function initDispatcher(): Promise<void> {
  return enqueue(reconcile).catch((err) => {
    appLog(NS, 'error', 'Dispatcher start-up failed', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  });
}

/**
 * Turn the Dispatcher on or off from Settings > Dispatcher or a phone. Resolves
 * with the new state. Off always works. On is refused, with nothing saved, where
 * it couldn't take effect: in the classic layout unless its saved value is
 * already on (#2565).
 */
export async function setDispatcherEnabled(on: boolean): Promise<DispatcherState> {
  if (on && getDispatcherSettings().enabled !== true) {
    if (!newChromeEnabled()) throw new Error(DISPATCHER_CLASSIC_MESSAGE);
  }
  await updateSettings((current) => ({ ...current, enabled: on }));
  await enqueue(reconcile);
  return getDispatcherState();
}

/** The experimental flags changed; a saved `dispatcher` may have flipped. */
export function onExperimentalSettingsChanged(): Promise<void> {
  return enqueue(reconcile).catch((err) => {
    appLog(NS, 'error', 'Dispatcher update after a flag change failed', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  });
}

/** For tests: resolves once every queued change has run. */
export async function _whenIdleForTesting(): Promise<void> {
  let seen: Promise<unknown> | null = null;
  while (seen !== queue) {
    seen = queue;
    await queue;
  }
}

/** For tests. */
export function _resetDispatcherForTesting(): void {
  config = null;
  instructionsWrittenFor = null;
  queue = Promise.resolve();
  lastBroadcast = '';
  stopWatching?.();
  stopWatching = null;
  listeners.clear();
}
