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
 * Behavior (#3045) sets each agent's model from the Auto mapping: before each
 * session starts, and at once when the level changes, switching a running
 * chat's model where its CLI allows. A provider with no mapping keeps the
 * model it has. The identity no longer shares a model between the two.
 *
 * Turning its switch off stops both agents and leaves the folders, the memory
 * and the configs alone, so turning it back on resumes where it left off. MCP going off
 * at app level derives it off and stops nothing: a running Dispatcher keeps
 * running, loses its connections, and can't be started again until MCP is back,
 * when it returns to what its saved values say without being started.
 */
import { withSavedAccess } from '../free-agent-settings';
import * as fsp from 'fs/promises';
import * as path from 'path';
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
import { hasChatStartInFlight } from '../agent-runtime/chat-spawn';
import { dispatcherEnablement, getSettings as getDispatcherSettings, isDispatcherEnabled, updateSettings } from './dispatcher-settings';
import { behaviorAuto, getDispatcherBehavior, resolveDispatcherModels, saveDispatcherBehavior } from './dispatcher-behavior';
import { onHelperRoutingChanged } from '../helper-routing';
import type { DispatcherBehavior, DispatcherRole } from '../../../shared/dispatcher-behavior';
import { setDispatcherIdLookup } from '../clubhouse-mcp/dispatcher-gate';
import { DEFAULT_DISPATCHER_NAME } from '../../../shared/dispatcher-name';
import { personalityInstructions } from '../../../shared/dispatcher-personality';
import type { DispatcherSetupInput, DispatcherSetupStatus } from '../../../shared/dispatcher-setup';
import {
  noteDispatcherOrigin,
  getDispatcherPersonality,
  getDispatcherSetup,
  saveDispatcherPersonality,
  saveDispatcherSetupStatus,
} from './dispatcher-setup';

export {
  getDispatcherPath, getDispatcherChatPath, getDispatcherNotesPath, getDispatcherNotesArchivePath, getDispatcherMemoryPath,
  isDispatcherPath, isDispatcherChatPath, isDispatcherCoordinatorPath,
} from './dispatcher-paths';
export { isDispatcherEnabled, DISPATCHER_FLAG } from './dispatcher-settings';
export { getDispatcherBehavior, getDispatcherBehaviorPlan, onDispatcherBehaviorChanged } from './dispatcher-behavior';
export { getDispatcherPersonality, getDispatcherSetup } from './dispatcher-setup';

const NS = 'core:dispatcher';
/** What the Dispatcher's instructions file holds. Clubhouse owns it: there is no project or user copy. */
export const DISPATCHER_INSTRUCTIONS: string = dispatcherInstructions;
/** What the chat's instructions file holds (#3036). Clubhouse owns it too. */
export const DISPATCHER_CHAT_INSTRUCTIONS: string = dispatcherChatInstructions;
/** Its default name; the one constant is in shared/dispatcher-name.ts. */
export const DISPATCHER_NAME = DEFAULT_DISPATCHER_NAME;
/**
 * The Clubhouse MCP tools that join its two agents (#3036). No chat shows a
 * call to them, on any provider, desktop or phone (concealed-tools).
 */
export const DISPATCHER_INTERNAL_TOOLS: ReadonlySet<string> = new Set(['start_work', 'tell_user']);

/** The coordinator's config as last read from disk; null before the Dispatcher was first created. */

let config: DurableAgentConfig | null = null;
/** The chat's config as last read from disk; null before it was first created. */
let chatConfig: DurableAgentConfig | null = null;
/**
 * What each folder's instructions file was last written for (instructionsKey),
 * so a CLI change rewrites it, and for the chat a new name too.
 */
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
// So the tool registry can tell a sleeping Dispatcher target apart (#3108).
setDispatcherIdLookup(isDispatcherAgentId);

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
 * rewrites its instructions file, so the session loads memory as it is now,
 * and gives it its Behavior model (#3045). Resolves with that model, which
 * the start uses over whatever model its caller last saw, or null when
 * Behavior set none. Anything else is left alone.
 */
export async function prepareDispatcherSessionStart(projectPath: string, agentId: string): Promise<AppliedModel | null> {
  if (!isDispatcherEnabled()) return null;
  const agent = isDispatcherChatPath(projectPath) && isDispatcherChatAgentId(agentId) ? chatConfig
    : isDispatcherCoordinatorPath(projectPath) && isDispatcherAgentId(agentId) ? config
      : null;
  if (!agent) return null;
  const dir = isDispatcherChatPath(projectPath) ? getDispatcherChatPath() : getDispatcherPath();
  const role: DispatcherRole = isDispatcherChatPath(projectPath) ? 'chat' : 'work';
  return enqueue(async () => {
    await writeInstructions(agent, dir);
    const applied = await applyBehavior([{ agent, dir, role }], { live: false });
    return applied.get(agent.id) ?? null;
  });
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
    behavior: behaviorState(),
    personality: getDispatcherPersonality(),
    setup: getDispatcherSetup(),
  };
}

function dispatcherProvider(): string | null {
  return config ? config.orchestrator ?? defaultDispatcherOrchestrator() ?? null : null;
}

function behaviorState(): DispatcherState['behavior'] {
  const level = getDispatcherBehavior();
  const provider = dispatcherProvider();
  return { level, provider, auto: behaviorAuto(provider, level) };
}

export interface AppliedModel {
  model: string;
  effort: string | null;
}

interface BehaviorTarget {
  agent: DurableAgentConfig;
  dir: string;
  role: DispatcherRole;
}

function behaviorTargets(): BehaviorTarget[] {
  const targets: BehaviorTarget[] = [];
  if (config) targets.push({ agent: config, dir: getDispatcherPath(), role: 'work' });
  if (chatConfig) targets.push({ agent: chatConfig, dir: getDispatcherChatPath(), role: 'chat' });
  return targets;
}

/**
 * Give each agent the model its role runs on at the current level (#3045).
 * Saved to its record, so the next start uses it. With `live`, a running chat
 * session also switches now where its CLI allows; one that can't picks it up
 * at its next start. Without an Auto mapping nothing is changed. Never throws.
 */
async function applyBehavior(targets: BehaviorTarget[], { live }: { live: boolean }): Promise<Map<string, AppliedModel>> {
  const applied = new Map<string, AppliedModel>();
  if (targets.length === 0) return applied;
  const level = getDispatcherBehavior();
  const before = JSON.stringify(behaviorState());
  for (const { agent, dir, role } of targets) {
    const provider = agent.orchestrator ?? defaultDispatcherOrchestrator();
    if (!provider) continue;
    try {
      const resolved = await resolveDispatcherModels(provider, level);
      if (resolved.ok === false) {
        appLog(NS, 'info', 'Behavior has no Auto models on this provider, so the Dispatcher keeps its model', {
          meta: { agentId: agent.id, provider, level, code: resolved.code },
        });
        continue;
      }
      const { model, effort } = resolved.models[role];
      applied.set(agent.id, { model, effort });
      const current = await agentConfig.getDurableConfig(dir, agent.id) ?? agent;
      const modelChanged = current.model !== model;
      const effortChanged = (current.effort ?? null) !== effort;
      if (modelChanged) await agentConfig.updateDurableConfig(dir, agent.id, { model, effort });
      else if (effortChanged) await agentConfig.updateDurableConfig(dir, agent.id, { effort });
      if (live && (modelChanged || effortChanged)) await switchRunningModel(agent.id, model, effort);
    } catch (err) {
      // telemetry-exempt: logged; the agent keeps the model it had, and the next start tries again
      appLog(NS, 'warn', 'Could not apply the Dispatcher\'s Behavior', {
        meta: { agentId: agent.id, provider, level, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  if (JSON.stringify(behaviorState()) !== before) emitChanged();
  return applied;
}

/** Switch a running chat session's model, where its CLI allows. Loaded here: agent-runtime is heavy. */
async function switchRunningModel(agentId: string, model: string, effort: string | null): Promise<void> {
  if (!agentRegistry.get(agentId)) return;
  const { getAgentRuntime } = await import('../agent-runtime');
  const runtime = getAgentRuntime(agentId);
  if (!runtime || runtime.kind !== 'chat' || !runtime.setModel) return;
  await runtime.setModel(model, effort);
}

/**
 * Change the Behavior from the composer chip, Settings or a phone (#3045).
 * Saves it and resolves with the state; giving both agents their new models
 * runs queued after, so the caller never waits on a CLI switching models.
 */
export async function setDispatcherBehavior(level: DispatcherBehavior): Promise<DispatcherState> {
  const changed = await saveDispatcherBehavior(level);
  if (changed) {
    emitChanged();
    const queuedIn = generation;
    // applyBehavior logs its own failures and never throws.
    void enqueue(async () => {
      if (queuedIn === generation) await applyBehavior(behaviorTargets(), { live: true });
    });
  }
  return getDispatcherState();
}

/**
 * Change its personality from setup, Settings or a phone (#3047). Saves it
 * and rewrites the chat's instructions file, which a session reads when it
 * starts: a running chat picks it up at its next start.
 */
export async function setDispatcherPersonality(value: unknown): Promise<DispatcherState> {
  if (await saveDispatcherPersonality(value)) {
    emitChanged();
    await enqueue(rewriteChatInstructions);
  }
  return getDispatcherState();
}

async function rewriteChatInstructions(): Promise<void> {
  if (chatConfig && isDispatcherEnabled()) await writeInstructions(chatConfig, getDispatcherChatPath());
}

/**
 * Where first-run setup stands (#3047): `later` when the user chose Set up
 * later, so the chat offers it again, or `done` when that offer is put away.
 */
export async function setDispatcherSetupStatus(status: Exclude<DispatcherSetupStatus, 'pending'>): Promise<DispatcherState> {
  if (await saveDispatcherSetupStatus(status)) emitChanged();
  return getDispatcherState();
}

/**
 * Finish first-run setup (#3047): its name, look, provider, Behavior and
 * personality in one go. The name and look go on the record Settings edits,
 * and are copied onto the chat's as any change is. A new provider resets the
 * model, as Settings' CLI change does, and Behavior gives both agents theirs.
 * Starts nothing.
 */
export async function completeDispatcherSetup(input: DispatcherSetupInput): Promise<DispatcherState> {
  if (!isDispatcherEnabled()) throw new Error('Turn on the Dispatcher first, in Settings > Dispatcher.');
  if (!getProvider(input.provider)) throw new Error(`${input.provider} isn’t a provider Clubhouse knows.`);
  await enqueue(async () => {
    const coordinator = config ?? await readConfig();
    if (!coordinator) throw new Error('The Dispatcher isn’t set up on disk yet. Try again in a moment.');
    const dir = getDispatcherPath();
    await agentConfig.updateDurable(dir, coordinator.id, {
      name: input.name,
      color: input.color,
      // An image replaces an emoji; a record has one or the other.
      ...(typeof input.image === 'string' && { emoji: null }),
    });
    if (typeof input.image === 'string') await agentConfig.saveAgentIcon(dir, coordinator.id, input.image);
    else if (input.image === null && coordinator.icon) await agentConfig.removeAgentIcon(dir, coordinator.id);
    if (input.provider !== (coordinator.orchestrator ?? defaultDispatcherOrchestrator())) {
      await agentConfig.updateDurableConfig(dir, coordinator.id, { orchestrator: input.provider as OrchestratorId, model: 'default' });
    }
    await saveDispatcherPersonality(input.personality);
    await saveDispatcherSetupStatus('done');
    // Read both records back, copy the identity onto the chat and write its instructions with the new name and personality.
    await refreshAfterChange(dir);
    await rewriteChatInstructions();
  });
  appLog(NS, 'info', 'Dispatcher setup finished', {
    meta: { provider: input.provider, behavior: input.behavior, preset: input.personality.preset, image: input.image === undefined ? 'kept' : input.image ? 'new' : 'removed' },
  });
  // Saves the level and gives both agents their models for it, on the provider just chosen.
  await saveDispatcherBehavior(input.behavior);
  const queuedIn = generation;
  void enqueue(async () => {
    if (queuedIn === generation) await applyBehavior(behaviorTargets(), { live: true });
  });
  emitChanged();
  return getDispatcherState();
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

/**
 * A marker in its folder, written when Clubhouse creates its agent in a
 * version that has setup (#3047). An agent without it was there before:
 * setup is then an upgrade. In the folder, not dispatcher-settings.json, so
 * a new install writes no settings until the user acts.
 */
function createdMarkerPath(): string {
  return path.join(getDispatcherPath(), '.clubhouse', 'created-with-setup.json');
}

async function markCreatedWithSetup(): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(createdMarkerPath()), { recursive: true });
    await fsp.writeFile(createdMarkerPath(), `${JSON.stringify({ createdAt: new Date().toISOString() })}\n`);
  } catch (err) {
    // telemetry-exempt: logged; setup then reads as an upgrade, which only adds one line to it
    appLog(NS, 'warn', 'Could not mark the Dispatcher as new', { meta: { error: err instanceof Error ? err.message : String(err) } });
  }
}

async function createdWithSetup(): Promise<boolean> {
  try {
    await fsp.access(createdMarkerPath());
    return true;
  } catch {
    // telemetry-exempt: no marker means its agent was there before this version
    return false;
  }
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
  await markCreatedWithSetup();
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
  await provider.writeInstructions(dir, await withDispatcherMemory(isDispatcherChatPath(dir) ? chatInstructions(agent) : DISPATCHER_INSTRUCTIONS));
  instructionsWrittenFor.set(dir, instructionsKey(agent, dir));
}

/**
 * The chat's instructions (#3047): Clubhouse's text, then its name and the
 * personality exactly as the user wrote it. The memory index goes after.
 */
export function chatInstructions(agent: Pick<DurableAgentConfig, 'name'>): string {
  return appendSection(DISPATCHER_CHAT_INSTRUCTIONS, personalityInstructions(agent.name, getDispatcherPersonality()));
}

/** `text` kept whole (a Windows checkout gives the shipped file CRLF line ends), a blank line, then `section`. */
export function appendSection(text: string, section: string): string {
  const base = /\n$/.test(text) ? text : `${text}\n`;
  return `${base}\n${section}\n`;
}

/** What an instructions file depends on besides memory: the CLI, and for the chat its name. */
function instructionsKey(agent: DurableAgentConfig, dir: string): string {
  const provider = agent.orchestrator ?? defaultDispatcherOrchestrator() ?? '';
  return isDispatcherChatPath(dir) ? `${provider}\n${agent.name}` : provider;
}

async function stopAgent(agent: DurableAgentConfig, dir: string = getDispatcherPath()): Promise<void> {
  // A chat start still in progress isn't running yet, but killAgent cancels it (#3110).
  if (!agentSystem.isAgentRunning(agent.id) && !hasChatStartInFlight(agent.id)) return;
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
    // First-run setup (#3047): an upgrade unless Clubhouse created its agent with setup.
    noteDispatcherOrigin(!(await createdWithSetup()));
    chatConfig = await ensureChat(config);
    await writeInstructions(config);
    await writeInstructions(chatConfig, getDispatcherChatPath());
  } else {
    config = await readConfig();
    chatConfig = await readConfig(getDispatcherChatPath());
    noteDispatcherOrigin(config ? !(await createdWithSetup()) : null);
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
      if (agent && instructionsKey(agent, dir) !== instructionsWrittenFor.get(dir)) await writeInstructions(agent, dir);
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
  agentRegistry.onAuthChange((agentId) => { if (agentId === config?.id || agentId === chatConfig?.id) emitChanged(); }),
  // A change to the Auto mapping can fix or break Behavior's models: check again, and apply at once.
  onHelperRoutingChanged(() => {
    const queuedIn = generation;
    void enqueue(async () => {
      if (queuedIn === generation && isDispatcherEnabled()) await applyBehavior(behaviorTargets(), { live: true });
    });
  })];
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
  noteDispatcherOrigin(null);
  chatConfig = null;
  instructionsWrittenFor.clear();
  // The chain is kept, so _whenIdleForTesting still waits for work queued before the reset.
  generation++;
  lastBroadcast = '';
  stopWatching?.();
  stopWatching = null;
  listeners.clear();
}
