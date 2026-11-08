/**
 * One main-process path for starting a quick agent (#2951). Annex's phone and
 * controller starts and Actions (#2918) use it. The agent shows in the
 * desktop sidebar like any quick agent, and observers (Annex, for phones)
 * hear about it as it starts.
 */

import { IPC } from '../../shared/ipc-channels';
import { generateQuickAgentId } from '../../shared/agent-id';
import { generateQuickName } from '../../shared/name-generator';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { isChatAgent } from './agent-runtime';
import { isHeadlessAgent, spawnAgent } from './agent-system';

export interface QuickAgentEntry {
  id: string;
  name: string;
  kind: 'quick';
  status: string;
  prompt: string;
  model: string | null;
  orchestrator: string | null;
  freeAgentMode: boolean;
  parentAgentId: string | null;
  projectId: string;
  spawnedAt: number;
}

export interface QuickAgentObserver {
  /** Before the spawn, with status 'starting'. */
  starting?(entry: QuickAgentEntry): void;
  /** After a successful spawn. The entry is the same object, now 'running'. */
  started?(entry: QuickAgentEntry): void;
  /** The spawn failed. */
  failed?(entry: QuickAgentEntry, err: unknown): void;
}

const observers = new Set<QuickAgentObserver>();

/** Hear about every quick agent started through this service. Returns the unsubscribe. */
export function observeQuickAgents(observer: QuickAgentObserver): () => void {
  observers.add(observer);
  return () => { observers.delete(observer); };
}

function tell<K extends keyof QuickAgentObserver>(method: K, ...args: Parameters<NonNullable<QuickAgentObserver[K]>>): void {
  for (const o of observers) {
    try {
      (o[method] as ((...a: unknown[]) => void) | undefined)?.(...args);
    } catch {
      // telemetry-exempt: an observer's failure must not fail the start
    }
  }
}

export interface StartQuickAgentParams {
  project: { id: string; path: string };
  /** Defaults to the project root. */
  cwd?: string;
  prompt: string;
  orchestrator: string;
  model?: string;
  freeAgentMode?: boolean;
  systemPrompt?: string;
  parentAgentId?: string | null;
  /** Defaults to a generated quick-agent name. */
  name?: string;
  /** A run someone will follow and talk to: chat or terminal, never headless. */
  interactive?: boolean;
}

/** Start a quick agent. Resolves once it has spawned; rejects if it couldn't. */
export async function startQuickAgent(p: StartQuickAgentParams): Promise<QuickAgentEntry> {
  const entry: QuickAgentEntry = {
    id: generateQuickAgentId(),
    name: p.name ?? generateQuickName(),
    kind: 'quick',
    status: 'starting',
    prompt: p.prompt,
    model: p.model || null,
    orchestrator: p.orchestrator || null,
    freeAgentMode: p.freeAgentMode ?? false,
    parentAgentId: p.parentAgentId || null,
    projectId: p.project.id,
    spawnedAt: Date.now(),
  };
  tell('starting', entry);
  try {
    await spawnAgent({
      agentId: entry.id,
      projectPath: p.project.path,
      cwd: p.cwd || p.project.path,
      kind: 'quick',
      model: p.model,
      mission: p.prompt,
      ...(p.systemPrompt && { systemPrompt: p.systemPrompt }),
      orchestrator: p.orchestrator,
      freeAgentMode: entry.freeAgentMode,
      ...(p.interactive && { interactive: true }),
    });
  } catch (err) {
    entry.status = 'failed';
    tell('failed', entry, err);
    throw err;
  }
  entry.status = 'running';
  tell('started', entry);
  // The desktop sidebar picks it up from this.
  broadcastToAllWindows(IPC.ANNEX.AGENT_SPAWNED, {
    ...entry,
    headless: !isChatAgent(entry.id) && isHeadlessAgent(entry.id),
  });
  return entry;
}
