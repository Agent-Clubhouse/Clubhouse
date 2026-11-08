/**
 * Agent cards (#3041, part of #3034): each agent connected to the Dispatcher
 * keeps a short card about itself (what it's for, when to reach it, what it
 * owns) at the top of its page in the Dispatcher's memory, `agents/<agent>.md`.
 * The Dispatcher's own notes sit under it (dispatcher-memory's two sections,
 * one writer each).
 *
 * Clubhouse asks the agent for its card:
 * - on connect: the first time it is connected, or again after it was off and
 *   has no card, or its setup changed while it was off (a card kept from
 *   before makes turning it back on instant), or its page is gone (memory
 *   was cleared);
 * - on a setup change: the parts that say what it does (instruction blocks,
 *   skills, MCP servers, template, mission, CLI agent file). Model, effort and
 *   the like change how it runs, not what it's for, and ask nothing.
 *
 * The ask is an ordinary Clubhouse message to the agent. It goes only to an
 * agent that is running and already wired to the Dispatcher, so it can answer
 * with update_my_card. An asleep agent is never woken for it: the request
 * waits and goes after its next turn. A request that got no answer within
 * {@link NO_ANSWER_MS} reads as "No description yet", as does one that hasn't
 * gone out.
 *
 * The agent answers, and updates its card any time after, with update_my_card,
 * which writes its own card and nothing else ({@link AgentCards.saveOwnCard}).
 *
 * What was asked and answered is kept in `dispatcher-agent-cards.json` under
 * the Clubhouse base dir, not in memory, which belongs to the Dispatcher.
 *
 * This file has no imports of live services: dispatcher-agent-cards-watch.ts
 * wires it to them, so the rules here are tested with plain fakes.
 */

import * as path from 'path';
import { createHash } from 'crypto';
import type { DurableAgentConfig } from '../../../shared/types';
import type { RoutedMessagePart } from '../../../shared/chat';
import { isDisposedAgent } from '../../../shared/agent-helpers';
import {
  agentPageExists,
  agentPagePath,
  ensureAgentPage,
  memoryPaths,
  memorySlug,
  moveAgentPage,
  readAgentCard,
  readIfExists,
  writeAgentCard,
  writeFileAtomic,
} from './dispatcher-memory';

/** What the agent's Details card and the Dispatcher see for an agent with no card. */
export const NO_DESCRIPTION = 'No description yet';

/** How long after the ask an agent is still "being asked" before it reads as not answering. */
export const NO_ANSWER_MS = 10 * 60 * 1000;

/** The most each field may hold, in characters: a card is a sentence or two, not a document. */
export const MAX_CARD_FIELD = 600;

/** The MCP tool the agent answers with. */
export const UPDATE_CARD_TOOL = 'update_my_card';

export interface AgentCardFields {
  /** What it's for. */
  purpose: string;
  /** When to reach it. */
  contactWhen: string;
  /** What it owns: repositories, areas, decisions. */
  owns: string;
}

const FIELD_LABELS: ReadonlyArray<[keyof AgentCardFields, string]> = [
  ['purpose', 'What it\'s for'],
  ['contactWhen', 'When to reach it'],
  ['owns', 'Owns'],
];

/** One line per field, in the card section of the agent's page. Empty fields are left out. */
export function renderCard(fields: Partial<AgentCardFields>): string {
  return FIELD_LABELS
    .map(([key, label]) => [label, oneLine(fields[key] ?? '')] as const)
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
}

/**
 * The fields of a card's text. Lines without a known label (a hand edit, say)
 * go to `purpose`, so nothing the page says is dropped.
 */
export function parseCard(text: string): Partial<AgentCardFields> {
  const out: Partial<AgentCardFields> = {};
  const loose: string[] = [];
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const field = FIELD_LABELS.find(([, label]) => line.startsWith(`${label}:`));
    if (field) out[field[0]] = line.slice(field[1].length + 1).trim();
    else loose.push(line);
  }
  if (loose.length) out.purpose = [out.purpose, ...loose].filter(Boolean).join(' ');
  return out;
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

/**
 * The parts of an agent's setup that say what it does, as a short hash. A
 * change here asks the agent for its card again.
 */
export function setupSignature(agent: DurableAgentConfig): string {
  const managed = agent.managed;
  const setup = {
    blocks: managed?.blocks ?? [],
    skills: [...(managed?.skills ?? [])].sort(),
    mcps: [...(managed?.mcps ?? [])].sort(),
    templateId: managed?.templateId ?? null,
    mcpIds: [...(agent.mcpIds ?? [])].sort(),
    mission: agent.mission ?? null,
    agentFile: agent.agentFile ?? null,
    agentSource: agent.agentSource ?? null,
  };
  return createHash('sha256').update(JSON.stringify(setup)).digest('hex').slice(0, 16);
}

export type CardRequestReason = 'connect' | 'setup';

interface CardRequest {
  reason: CardRequestReason;
  /** When Clubhouse decided to ask (ISO). */
  at: string;
  /** When the ask reached the agent (ISO). Unset: waiting for it to be running and wired. */
  deliveredAt?: string;
}

/** What Clubhouse knows about one agent's card. */
export interface CardRecord {
  projectPath: string;
  /** The page's name in memory: `agents/<memorySlug(page)>.md`. */
  page: string;
  setup: string;
  connected: boolean;
  request?: CardRequest;
  /** When the agent last saved its card (ISO). */
  answeredAt?: string;
}

interface CardStore {
  version: 1;
  agents: Record<string, CardRecord>;
}

export type AgentCardState = 'ready' | 'asking' | 'none';

export interface AgentCardStatus {
  /** `ready`: it has a card. `asking`: asked and still in time to answer. `none`: no card. */
  state: AgentCardState;
  /** Whether a request is open, even with a card from before (a setup change). */
  asking: boolean;
  /** The page, relative to memory, as read_memory names it. */
  page: string;
  card: Partial<AgentCardFields> | null;
  /** The card as text, or {@link NO_DESCRIPTION}. */
  text: string;
}

export type CardDelivery = 'delivered' | 'not_running' | 'stopping';

export interface AgentCardDeps {
  /** The memory root; the Dispatcher's when left out. */
  memoryRoot?: string;
  storePath(): string;
  /** The Dispatcher's id while it is on; null while it is off or was never created. */
  activeDispatcherId(): string | null;
  dispatcherName(): string;
  isDispatcherPath(projectPath: string): boolean;
  listProjects(): Promise<Array<{ path: string; name?: string }>>;
  listAgents(projectPath: string): Promise<DurableAgentConfig[]>;
  /** Of these agents, the ones with Connect to Dispatcher on (resolved). */
  connectedIds(projectPath: string, agents: DurableAgentConfig[]): Promise<ReadonlySet<string>>;
  /** Whether the agent has its wire to the Dispatcher now, so update_my_card is in its tools. */
  isWiredToDispatcher(agentId: string): boolean;
  /** Put the text in front of a running agent; a busy one gets it after its turn. */
  send(agentId: string, text: string, routed: RoutedMessagePart[]): Promise<CardDelivery>;
  log(level: 'info' | 'warn', message: string, meta: Record<string, unknown>): void;
  now?(): number;
}

export type SaveCardResult =
  | { ok: true; card: Partial<AgentCardFields>; page: string }
  | { ok: false; error: string };

export const NOT_CONNECTED_MESSAGE =
  'You aren\'t connected to the Dispatcher, so you have no card to update. The user can turn on Connect to Dispatcher in your settings.';

/** The ask, as the agent reads it. */
export function cardRequestText(reason: CardRequestReason, dispatcherName: string): string {
  const fields = 'what you\'re for, when to reach you, and what you own (repositories, areas or decisions)';
  return reason === 'connect'
    ? `You're connected to ${dispatcherName}, which helps the user keep track of their agents. Call ${UPDATE_CARD_TOOL} with a short card about you: ${fields}. A sentence or two each. Call it again whenever that changes.`
    : `Your setup changed. Call ${UPDATE_CARD_TOOL} with your card as it is now: ${fields}. Send it even if nothing changed.`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AgentCards {
  private store: CardStore | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: AgentCardDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  /** One store change at a time: syncs, deliveries and saves never interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch((): void => undefined);
    return run;
  }

  private async load(): Promise<CardStore> {
    if (this.store) return this.store;
    let store: CardStore = { version: 1, agents: {} };
    try {
      const text = await readIfExists(this.deps.storePath());
      if (text) {
        const parsed = JSON.parse(text) as Partial<CardStore>;
        if (parsed && typeof parsed.agents === 'object' && parsed.agents) store = { version: 1, agents: parsed.agents };
      }
    } catch (err) {
      // telemetry-exempt: logged; an unreadable store starts over, which at worst asks again
      this.deps.log('warn', 'Agent cards: could not read the store; starting over', { error: errorText(err) });
    }
    this.store = store;
    return store;
  }

  private async save(): Promise<void> {
    if (!this.store) return;
    await writeFileAtomic(this.deps.storePath(), `${JSON.stringify(this.store, null, 2)}\n`);
  }

  private pageRelative(page: string): string {
    const paths = memoryPaths(this.deps.memoryRoot);
    return path.relative(paths.root, agentPagePath(page, this.deps.memoryRoot)).split(path.sep).join('/');
  }

  /**
   * Bring the records up to date with who is connected, and ask for the cards
   * that are due. With `projectPaths`, only those projects are read. Does
   * nothing while the Dispatcher is off: turning it on syncs everything.
   */
  sync(projectPaths?: ReadonlySet<string>): Promise<void> {
    return this.serial(async () => {
      await this.syncNow(projectPaths);
      await this.deliverNow();
    });
  }

  private async syncNow(projectPaths?: ReadonlySet<string>): Promise<void> {
    const dispatcherId = this.deps.activeDispatcherId();
    if (!dispatcherId) return;
    const store = await this.load();
    const listed = (await this.deps.listProjects()).filter((p) => !this.deps.isDispatcherPath(p.path));
    const listedPaths = new Set(listed.map((p) => p.path));
    const projects = projectPaths ? listed.filter((p) => projectPaths.has(p.path)) : listed;

    // Page names already taken, so two agents never share a page.
    const taken = new Map<string, string>();
    for (const [id, rec] of Object.entries(store.agents)) taken.set(memorySlug(rec.page), id);

    const seen = new Set<string>();
    const read = new Set<string>();
    let changed = false;
    for (const project of projects) {
      let agents: DurableAgentConfig[];
      let connected: ReadonlySet<string>;
      try {
        agents = (await this.deps.listAgents(project.path)).filter((a) => a.id !== dispatcherId && !isDisposedAgent(a));
        connected = await this.deps.connectedIds(project.path, agents);
      } catch (err) {
        // telemetry-exempt: logged; that project's records stay as they are until it can be read
        this.deps.log('warn', 'Agent cards: could not read a project', { projectPath: project.path, error: errorText(err) });
        continue;
      }
      read.add(project.path);
      for (const agent of agents) {
        if (!connected.has(agent.id)) continue;
        seen.add(agent.id);
        if (await this.syncAgent(store, agent, project, taken)) changed = true;
      }
    }

    // Records of agents no longer connected: in a project just read, or in one that isn't registered now.
    for (const [id, rec] of Object.entries(store.agents)) {
      if (seen.has(id) || !rec.connected) continue;
      if (!read.has(rec.projectPath) && listedPaths.has(rec.projectPath)) continue;
      rec.connected = false;
      delete rec.request;
      changed = true;
    }
    if (changed) await this.save();
  }

  /** Returns whether the record changed. */
  private async syncAgent(
    store: CardStore,
    agent: DurableAgentConfig,
    project: { path: string; name?: string },
    taken: Map<string, string>,
  ): Promise<boolean> {
    const root = this.deps.memoryRoot;
    const current = store.agents[agent.id];
    const page = this.pageName(agent, project.name, taken);
    if (current && current.page !== page) {
      await moveAgentPage(current.page, page, root);
      if (taken.get(memorySlug(current.page)) === agent.id) taken.delete(memorySlug(current.page));
    }
    taken.set(memorySlug(page), agent.id);

    const setup = setupSignature(agent);
    let reason: CardRequestReason | null = null;
    if (!current || !current.connected) {
      const keep = current?.setup === setup && (await readAgentCard(page, root)) !== null;
      if (!keep) reason = 'connect';
    } else if (current.setup !== setup) {
      reason = 'setup';
    } else if (!(await agentPageExists(page, root))) {
      reason = 'connect';
    }

    const next: CardRecord = { ...current, projectPath: project.path, page, setup, connected: true };
    if (reason) {
      next.request = { reason, at: this.iso() };
      await ensureAgentPage(page, root);
      this.deps.log('info', 'Agent cards: asking for a card', { agentId: agent.id, reason });
    }
    store.agents[agent.id] = next;
    return JSON.stringify(current) !== JSON.stringify(next);
  }

  /** `<agent> (<project>)`, with a piece of the id when another agent has that page. */
  private pageName(agent: DurableAgentConfig, projectName: string | undefined, taken: ReadonlyMap<string, string>): string {
    const base = projectName ? `${agent.name} (${projectName})` : agent.name;
    const owner = taken.get(memorySlug(base));
    if (!owner || owner === agent.id) return base;
    const short = agent.id.replace(/^durable_/, '').slice(-6);
    return projectName ? `${agent.name} (${projectName}, ${short})` : `${agent.name} (${short})`;
  }

  /**
   * Send the requests that are due to agents that can take them now: running
   * and wired to the Dispatcher. With `agentId`, only that agent's.
   */
  deliver(agentId?: string): Promise<void> {
    return this.serial(() => this.deliverNow(agentId));
  }

  private async deliverNow(only?: string): Promise<void> {
    if (!this.deps.activeDispatcherId()) return;
    const store = await this.load();
    let changed = false;
    for (const [id, rec] of Object.entries(store.agents)) {
      if (only && id !== only) continue;
      if (!rec.connected || !rec.request || rec.request.deliveredAt) continue;
      if (!this.deps.isWiredToDispatcher(id)) continue;
      const text = cardRequestText(rec.request.reason, this.deps.dispatcherName());
      let delivery: CardDelivery;
      try {
        delivery = await this.deps.send(id, `[Clubhouse] ${text}`, [{ fromClubhouse: true, text }]);
      } catch (err) {
        // telemetry-exempt: logged; the request stays and goes with the agent's next turn
        this.deps.log('warn', 'Agent cards: could not send the request', { agentId: id, error: errorText(err) });
        continue;
      }
      if (delivery !== 'delivered') continue;
      rec.request.deliveredAt = this.iso();
      changed = true;
    }
    if (changed) await this.save();
  }

  /**
   * The agent's own card, from update_my_card. Fields left out keep what the
   * card said. Only the caller's own card can be written: there is no way to
   * name another agent.
   */
  saveOwnCard(agentId: string, fields: Partial<AgentCardFields>): Promise<SaveCardResult> {
    return this.serial(async () => {
      if (!this.deps.activeDispatcherId()) return { ok: false, error: NOT_CONNECTED_MESSAGE };
      let rec = (await this.load()).agents[agentId];
      if (!rec?.connected && this.deps.isWiredToDispatcher(agentId)) {
        // Wired before the records caught up: sync once and look again.
        await this.syncNow();
        rec = (await this.load()).agents[agentId];
      }
      if (!rec?.connected) return { ok: false, error: NOT_CONNECTED_MESSAGE };
      const root = this.deps.memoryRoot;
      const existing = await readAgentCard(rec.page, root);
      const card: Partial<AgentCardFields> = { ...(existing ? parseCard(existing) : {}) };
      for (const [key] of FIELD_LABELS) {
        const value = fields[key];
        if (value !== undefined) card[key] = oneLine(value);
      }
      const text = renderCard(card);
      if (!text) return { ok: false, error: 'The card is empty. Say what you\'re for, when to reach you, or what you own.' };
      await writeAgentCard(rec.page, text, root);
      rec.answeredAt = this.iso();
      delete rec.request;
      await this.save();
      return { ok: true, card: parseCard(text), page: this.pageRelative(rec.page) };
    });
  }

  /** The agent's card as its Details card and list_agents show it, or null when it has no record. */
  async status(agentId: string): Promise<AgentCardStatus | null> {
    await this.queue;
    const rec = (await this.load()).agents[agentId];
    if (!rec) return null;
    const text = await readAgentCard(rec.page, this.deps.memoryRoot);
    const delivered = rec.request?.deliveredAt ? Date.parse(rec.request.deliveredAt) : NaN;
    const asking = rec.connected && !!rec.request && (!rec.request.deliveredAt || this.now() - delivered < NO_ANSWER_MS);
    const waiting = !!rec.request?.deliveredAt && this.now() - delivered < NO_ANSWER_MS;
    return {
      state: text ? 'ready' : waiting && rec.connected ? 'asking' : 'none',
      asking,
      page: this.pageRelative(rec.page),
      card: text ? parseCard(text) : null,
      text: text ?? NO_DESCRIPTION,
    };
  }

  /** For tests: drop the cached store so the next read comes from disk. */
  _forgetCacheForTesting(): void {
    this.store = null;
  }
}
