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
 * Two agents, one identity (#3036): the agent in this folder keeps the id,
 * connections, links and grants it always had, and does the work. It is never
 * shown or named. The user talks to a chat agent in a sibling folder
 * (getDispatcherChatPath), created on top of it, which reads agents' state and
 * memory and hands every action to it (dispatcher-channel). Name, look and
 * settings are shared (dispatcher-identity). Code calls the first the
 * coordinator; no user-facing text does.
 *
 * Its memory (#3038) is plain markdown in the folder's `memory/`. The index is
 * added to both agents' instructions files each time Clubhouse writes them,
 * and before each of their sessions starts, and an old `notes/` folder is
 * sorted into memory first (dispatcher-memory-migration.ts).
 *
 * Turning its switch off stops both agents and leaves the folders, the memory
 * and the configs alone, so turning it back on resumes where it left off. MCP going off
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
import dispatcherChatInstructions from './dispatcher-chat-instructions.md';
import { withMemoryIndex } from './dispatcher-memory-migration';
import { appLog } from '../log-service';
import { AGENT_COLORS } from '../../../shared/name-generator';
import type { DispatcherState } from '../../../shared/dispatcher-types';
import type { DurableAgentConfig } from '../../../shared/types';
import { agentRegistry } from '../agent-registry';
import { newChromeEnabled } from '../../window-chrome';
import { DISPATCHER_CLASSIC_MESSAGE } from '../../../shared/dispatcher-types';
import { getDispatcherChatPath, getDispatcherPath, isDispatcherChatPath, isDispatcherCoordinatorPath } from './dispatcher-paths';
import { isEmptyMirror, mirrorUpdates } from './dispatcher-identity';
import { registerConcealedTools } from '../agent-runtime/concealed-tools';
import { dispatcherEnablement, getSettings as getDispatcherSettings, isDispatcherEnabled, updateSettings } from './dispatcher-settings';

export {
  getDispatcherPath, getDispatcherChatPath, getDispatcherNotesPath, getDispatcherNotesArchivePath, getDispatcherMemoryPath,
  isDispatcherPath, isDispatcherChatPath, isDispatcherCoordinatorPath,
} from './dispatcher-paths';
export { isDispatcherEnabled, DISPATCHER_FLAG } from './dispatcher-settings';

const NS = 'core:dispatcher';
/** What the Dispatcher's instructions file holds. Clubhouse owns it: there is no project or user copy. */
export const DISPATCHER_INSTRUCTIONS: string = dispatcherInstructions;
/** What the chat's instructions file holds (#3036). Clubhouse owns it too. */
export const DISPATCHER_CHAT_INSTRUCTIONS: string = dispatcherChatInstructions;
export const DISPATCHER_NAME = 'Dispatcher';
/**
 * The Clubhouse MCP tools that join its two agents (#3036). No chat shows a
 * call to them, on any provider, desktop or phone (concealed-tools).
 */
export const DISPATCHER_INTERNAL_TOOLS: ReadonlySet<string> = new Set(['start_work', 'tell_user']);

/** The coordinator's config as last read from disk; null before the Dispatcher was first created. */
let config: DurableAgentConfig | null = null;
/** The chat's config as last read from disk; null before it was first created. */
let chatConfig: DurableAgentConfig | null = null;
/** The CLI whose instructions file was last written in each folder, so a CLI change rewrites it. */
const instructionsWrittenFor = new Map<string, string>();
/** Every change runs after the previous one, so two toggles can't race a create. */
let queue: Promise<unknown> = Promise.resolve();
/** Bumped by _resetDispatcherForTesting, so a refresh queued before it does nothing after. */
let generation = 0;
let lastBroadcast = '';
let stopWatching: (() => void) | null = null;

type DispatcherListener = (state: DispatcherState) => void;
const listeners = new Set<DispatcherListener>();

/**
 * The Dispatcher's agent id: the one its connections, links and grants are
 * on, or null before it was first created. Kept while it is off.
 */
export function getDispatcherAgentId(): string | null {
  return config?.id ?? null;
}

/** True for the Dispatcher's agent id (the coordinator's). Not for the chat's: see isDispatcherIdentityAgentId. */
export function isDispatcherAgentId(agentId: string | undefined | null): boolean {
  return !!agentId && agentId === config?.id;
}

/** The id of the agent the user talks to as the Dispatcher, or null before it was first created. */
export function getDispatcherChatAgentId(): string | null {
  return chatConfig?.id ?? null;
}

/** The chat's config as last read, or null before it was first created. */
export function getDispatcherChatConfig(): DurableAgentConfig | null {
  return chatConfig ? withSavedAccess({ ...chatConfig }, getDispatcherChatPath()) : null;
}

/** True for the chat's agent id. */
export function isDispatcherChatAgentId(agentId: string | undefined | null): boolean {
  return !!agentId && agentId === chatConfig?.id;
}

/** True for either of the Dispatcher's agents. */
export function isDispatcherIdentityAgentId(agentId: string | undefined | null): boolean {
  return isDispatcherAgentId(agentId) || isDispatcherChatAgentId(agentId);
}

registerConcealedTools((agentId) => (isDispatcherIdentityAgentId(agentId) ? DISPATCHER_INTERNAL_TOOLS : null));

/**
 * What either agent's instructions file holds: its instructions, then the
 * memory index (#3038), cut to its cap. Runs at every write, and before every
 * session start (prepareDispatcherSessionStart), so each session starts with
 * memory as it is now. Memory trouble leaves the instructions without the index.
 */
export function withDispatcherMemory(instructions: string): Promise<string> {
  return withMemoryIndex(instructions);
}

/**
 * Called on the spawn path before either of the Dispatcher's agents starts:
 * rewrites its instructions file, so the session loads memory as it is now.
 * Anything else is left alone.
 */
export async function prepareDispatcherSessionStart(projectPath: string, agentId: string): Promise<void> {
  if (!isDispatcherEnabled()) return;
  const agent = isDispatcherChatPath(projectPath) && isDispatcherChatAgentId(agentId) ? chatConfig
    : isDispatcherCoordinatorPath(projectPath) && isDispatcherAgentId(agentId) ? config
      : null;
  if (!agent) return;
  const dir = isDispatcherChatPath(projectPath) ? getDispatcherChatPath() : getDispatcherPath();
  await enqueue(() => writeInstructions(agent, dir));
}

/**
 * Where a change to the Dispatcher's settings goes: the chat's id names the
 * coordinator's record, which holds its grants. Anything else is unchanged.
 */
export function resolveDispatcherIdentity(projectPath: string, agentId: string): { projectPath: string; agentId: string } {
  if (config && isDispatcherChatAgentId(agentId)) return { projectPath: getDispatcherPath(), agentId: config.id };
  return { projectPath, agentId };
}

export function getDispatcherState(): DispatcherState {
  const { enabled, savedOn, reason } = dispatcherEnablement();
  const chatRunning = !!chatConfig && !!agentRegistry.get(chatConfig.id);
  return {
    enabled,
    flagOn: true,
    savedOn,
    offReason: reason,
    classic: !newChromeEnabled(),
    running: (!!config && !!agentRegistry.get(config.id)) || chatRunning,
    agentId: config?.id ?? null,
    path: config ? getDispatcherPath() : null,
    // Access (#2761) filled in for a Dispatcher saved before it.
    config: config ? withSavedAccess({ ...config }, getDispatcherPath()) : null,
    chatAgentId: chatConfig?.id ?? null,
    chatPath: chatConfig ? getDispatcherChatPath() : null,
    chatRunning,
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

async function readConfig(dir: string = getDispatcherPath()): Promise<DurableAgentConfig | null> {
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
  await fsp.mkdir(dir, { recursive: true });
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

/**
 * Copy what the identity shares from one record onto the other (see
 * dispatcher-identity). Returns the target as it is now.
 */
async function mirror(from: DurableAgentConfig, to: DurableAgentConfig, toDir: string): Promise<DurableAgentConfig> {
  const updates = mirrorUpdates(from, to);
  if (isEmptyMirror(updates)) return to;
  try {
    if (Object.keys(updates.identity).length > 0) await agentConfig.updateDurable(toDir, to.id, updates.identity);
    if (Object.keys(updates.config).length > 0) await agentConfig.updateDurableConfig(toDir, to.id, updates.config);
  } catch (err) {
    // telemetry-exempt: logged; the two records differ until the next change, and the Dispatcher keeps working
    appLog(NS, 'warn', 'Could not copy a Dispatcher setting between its records', {
      meta: { agentId: to.id, fields: [...Object.keys(updates.identity), ...Object.keys(updates.config)], error: err instanceof Error ? err.message : String(err) },
    });
  }
  return (await agentConfig.getDurableConfig(toDir, to.id)) ?? to;
}

/**
 * Create the chat the first time, on top of the coordinator (#3036): a new
 * agent with the coordinator's name, look and settings. The coordinator keeps
 * its id, connections and links. Idempotent; an existing chat is brought in
 * line with the coordinator, whose record is the one kept from before.
 */
async function ensureChat(coordinator: DurableAgentConfig): Promise<DurableAgentConfig> {
  const dir = getDispatcherChatPath();
  await fsp.mkdir(dir, { recursive: true });
  const existing = await readConfig(dir);
  if (existing) return mirror(coordinator, existing, dir);
  const created = await agentConfig.createDurable(
    dir,
    coordinator.name,
    coordinator.color,
    coordinator.model,
    false,
    coordinator.orchestrator ?? defaultDispatcherOrchestrator(),
    true, // free agent mode
  );
  await agentConfig.updateDurableConfig(dir, created.id, { idleSleep: 'never', runtimeMode: 'chat' });
  appLog(NS, 'info', 'Dispatcher chat created', { meta: { agentId: created.id, dispatcherId: coordinator.id } });
  const fresh = (await agentConfig.getDurableConfig(dir, created.id)) ?? created;
  return mirror(coordinator, fresh, dir);
}

/** Write each agent's instructions to its CLI's instructions file in its folder. */
async function writeInstructions(agent: DurableAgentConfig, dir: string = getDispatcherPath()): Promise<void> {
  const providerId = agent.orchestrator ?? defaultDispatcherOrchestrator();
  const provider = providerId ? getProvider(providerId) : undefined;
  if (!provider) {
    appLog(NS, 'warn', 'No provider to write Dispatcher instructions for', { meta: { orchestrator: providerId } });
    return;
  }
  await provider.writeInstructions(dir, await withDispatcherMemory(isDispatcherChatPath(dir) ? DISPATCHER_CHAT_INSTRUCTIONS : DISPATCHER_INSTRUCTIONS));
  instructionsWrittenFor.set(dir, provider.id);
}

async function stopAgent(agent: DurableAgentConfig, dir: string = getDispatcherPath()): Promise<void> {
  if (!agentSystem.isAgentRunning(agent.id)) return;
  appLog(NS, 'info', 'Stopping the Dispatcher', { meta: { agentId: agent.id } });
  await agentSystem.killAgent(agent.id, dir, agent.orchestrator);
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
    chatConfig = await ensureChat(config);
    await writeInstructions(config);
    await writeInstructions(chatConfig, getDispatcherChatPath());
  } else {
    config = await readConfig();
    chatConfig = await readConfig(getDispatcherChatPath());
    if (!savedOn) {
      if (chatConfig) await stopAgent(chatConfig, getDispatcherChatPath());
      if (config) await stopAgent(config);
    }
  }
  emitChanged();
}

/**
 * One of the two records changed on disk: read both, copy what the identity
 * shares from the changed one onto the other, and rewrite an instructions file
 * whose CLI changed.
 */
async function refreshAfterChange(changedDir: string): Promise<void> {
  const chatDir = getDispatcherChatPath();
  let coordinator = await readConfig();
  let chat = await readConfig(chatDir);
  if (coordinator && chat && isDispatcherEnabled()) {
    if (isDispatcherChatPath(changedDir)) coordinator = await mirror(chat, coordinator, getDispatcherPath());
    else chat = await mirror(coordinator, chat, chatDir);
  }
  config = coordinator;
  chatConfig = chat;
  if (isDispatcherEnabled()) {
    for (const [agent, dir] of [[coordinator, getDispatcherPath()], [chat, chatDir]] as const) {
      if (agent && (agent.orchestrator ?? defaultDispatcherOrchestrator()) !== instructionsWrittenFor.get(dir)) await writeInstructions(agent, dir);
    }
  }
  emitChanged();
}

function watchChanges(): void {
  if (stopWatching) return;
  const unsubscribers = [agentConfig.onAgentConfigChanged((projectPath) => {
    if (!isDispatcherCoordinatorPath(projectPath) && !isDispatcherChatPath(projectPath)) return;
    // A CLI change gets the new provider's instructions file.
    const queuedIn = generation;
    void enqueue(() => (queuedIn === generation ? refreshAfterChange(projectPath) : Promise.resolve())).catch((err) => {
      appLog(NS, 'warn', 'Dispatcher config refresh failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    });
  }),
  // Its row and view stay while it runs.
  agentRegistry.onAuthChange((agentId) => { if (agentId === config?.id || agentId === chatConfig?.id) emitChanged(); })];
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
  chatConfig = null;
  instructionsWrittenFor.clear();
  // The chain is kept, so _whenIdleForTesting still waits for work queued before the reset.
  generation++;
  lastBroadcast = '';
  stopWatching?.();
  stopWatching = null;
  listeners.clear();
}
