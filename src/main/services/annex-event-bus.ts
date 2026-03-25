import type { AgentHookEvent } from '../../shared/types';
import type { StructuredEvent } from '../../shared/structured-events';
import type { GroupProject, BulletinMessage } from '../../shared/group-project-types';

type PtyDataListener = (agentId: string, data: string) => void;
type HookEventListener = (agentId: string, event: AgentHookEvent) => void;
type PtyExitListener = (agentId: string, exitCode: number) => void;
type AgentSpawnedListener = (agentId: string, kind: string, projectId: string, meta: Record<string, unknown>) => void;
type StructuredEventListener = (agentId: string, event: StructuredEvent) => void;
type GroupProjectChangedListener = (action: 'created' | 'updated' | 'deleted', project: GroupProject) => void;
type BulletinMessageListener = (projectId: string, message: BulletinMessage) => void;

let active = false;

const ptyDataListeners = new Set<PtyDataListener>();
const hookEventListeners = new Set<HookEventListener>();
const ptyExitListeners = new Set<PtyExitListener>();
const agentSpawnedListeners = new Set<AgentSpawnedListener>();
const structuredEventListeners = new Set<StructuredEventListener>();
const groupProjectChangedListeners = new Set<GroupProjectChangedListener>();
const bulletinMessageListeners = new Set<BulletinMessageListener>();

export function setActive(flag: boolean): void {
  active = flag;
}

export function isActive(): boolean {
  return active;
}

export function emitPtyData(agentId: string, data: string): void {
  if (!active) return;
  for (const fn of ptyDataListeners) fn(agentId, data);
}

export function emitHookEvent(agentId: string, event: AgentHookEvent): void {
  if (!active) return;
  for (const fn of hookEventListeners) fn(agentId, event);
}

export function emitPtyExit(agentId: string, exitCode: number): void {
  if (!active) return;
  for (const fn of ptyExitListeners) fn(agentId, exitCode);
}

export function emitAgentSpawned(agentId: string, kind: string, projectId: string, meta: Record<string, unknown>): void {
  if (!active) return;
  for (const fn of agentSpawnedListeners) fn(agentId, kind, projectId, meta);
}

export function emitStructuredEvent(agentId: string, event: StructuredEvent): void {
  if (!active) return;
  for (const fn of structuredEventListeners) fn(agentId, event);
}

export function emitGroupProjectChanged(action: 'created' | 'updated' | 'deleted', project: GroupProject): void {
  if (!active) return;
  for (const fn of groupProjectChangedListeners) fn(action, project);
}

export function emitBulletinMessage(projectId: string, message: BulletinMessage): void {
  if (!active) return;
  for (const fn of bulletinMessageListeners) fn(projectId, message);
}

export function onPtyData(fn: PtyDataListener): () => void {
  ptyDataListeners.add(fn);
  return () => { ptyDataListeners.delete(fn); };
}

export function onHookEvent(fn: HookEventListener): () => void {
  hookEventListeners.add(fn);
  return () => { hookEventListeners.delete(fn); };
}

export function onPtyExit(fn: PtyExitListener): () => void {
  ptyExitListeners.add(fn);
  return () => { ptyExitListeners.delete(fn); };
}

export function onAgentSpawned(fn: AgentSpawnedListener): () => void {
  agentSpawnedListeners.add(fn);
  return () => { agentSpawnedListeners.delete(fn); };
}

export function onStructuredEvent(fn: StructuredEventListener): () => void {
  structuredEventListeners.add(fn);
  return () => { structuredEventListeners.delete(fn); };
}

export function onGroupProjectChanged(fn: GroupProjectChangedListener): () => void {
  groupProjectChangedListeners.add(fn);
  return () => { groupProjectChangedListeners.delete(fn); };
}

export function onBulletinMessage(fn: BulletinMessageListener): () => void {
  bulletinMessageListeners.add(fn);
  return () => { bulletinMessageListeners.delete(fn); };
}

/** Remove all listeners. Used during shutdown. */
export function removeAllListeners(): void {
  ptyDataListeners.clear();
  hookEventListeners.clear();
  ptyExitListeners.clear();
  agentSpawnedListeners.clear();
  structuredEventListeners.clear();
  groupProjectChangedListeners.clear();
  bulletinMessageListeners.clear();
}

/** Return current listener counts for diagnostics and leak detection. */
export function getListenerCounts(): { ptyData: number; hookEvent: number; ptyExit: number; agentSpawned: number; structuredEvent: number; groupProjectChanged: number; bulletinMessage: number; total: number } {
  const ptyData = ptyDataListeners.size;
  const hookEvent = hookEventListeners.size;
  const ptyExit = ptyExitListeners.size;
  const agentSpawned = agentSpawnedListeners.size;
  const structuredEvent = structuredEventListeners.size;
  const groupProjectChanged = groupProjectChangedListeners.size;
  const bulletinMessage = bulletinMessageListeners.size;
  return { ptyData, hookEvent, ptyExit, agentSpawned, structuredEvent, groupProjectChanged, bulletinMessage, total: ptyData + hookEvent + ptyExit + agentSpawned + structuredEvent + groupProjectChanged + bulletinMessage };
}
