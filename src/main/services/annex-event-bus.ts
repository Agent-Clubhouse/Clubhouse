import type { AgentHookEvent } from '../../shared/types';

type PtyDataListener = (agentId: string, data: string) => void;
type HookEventListener = (agentId: string, event: AgentHookEvent) => void;
type PtyExitListener = (agentId: string, exitCode: number) => void;

let active = false;

const ptyDataListeners = new Set<PtyDataListener>();
const hookEventListeners = new Set<HookEventListener>();
const ptyExitListeners = new Set<PtyExitListener>();

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

/** Remove all listeners. Used during shutdown. */
export function removeAllListeners(): void {
  ptyDataListeners.clear();
  hookEventListeners.clear();
  ptyExitListeners.clear();
}
