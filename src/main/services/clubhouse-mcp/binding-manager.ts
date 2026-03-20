/**
 * Binding Manager — manages the mapping between agents and their linked
 * widgets/agents. Bindings are in-memory only (session-scoped).
 */

import type { McpBinding, BindingTargetKind } from './types';

export type BindingChangeListener = (agentId: string) => void;

class BindingManager {
  /** agentId → array of bindings */
  private bindings = new Map<string, McpBinding[]>();
  private listeners = new Set<BindingChangeListener>();

  /** Add a binding for an agent. */
  bind(agentId: string, target: { targetId: string; targetKind: BindingTargetKind; label: string; agentName?: string; targetName?: string }): void {
    let agentBindings = this.bindings.get(agentId);
    if (!agentBindings) {
      agentBindings = [];
      this.bindings.set(agentId, agentBindings);
    }

    // Don't duplicate
    if (agentBindings.some(b => b.targetId === target.targetId)) return;

    agentBindings.push({ agentId, ...target });
    this.notifyChange(agentId);
  }

  /** Remove a specific binding from an agent. */
  unbind(agentId: string, targetId: string): void {
    const agentBindings = this.bindings.get(agentId);
    if (!agentBindings) return;

    const idx = agentBindings.findIndex(b => b.targetId === targetId);
    if (idx === -1) return;

    agentBindings.splice(idx, 1);
    if (agentBindings.length === 0) {
      this.bindings.delete(agentId);
    }
    this.notifyChange(agentId);
  }

  /** Remove all bindings for an agent (agent exited). */
  unbindAgent(agentId: string): void {
    if (!this.bindings.has(agentId)) return;
    this.bindings.delete(agentId);
    this.notifyChange(agentId);
  }

  /** Remove a target from all agents (widget closed or agent exited). */
  unbindTarget(targetId: string): void {
    const affectedAgents: string[] = [];

    for (const [agentId, agentBindings] of this.bindings) {
      const idx = agentBindings.findIndex(b => b.targetId === targetId);
      if (idx !== -1) {
        agentBindings.splice(idx, 1);
        if (agentBindings.length === 0) {
          this.bindings.delete(agentId);
        }
        affectedAgents.push(agentId);
      }
    }

    for (const agentId of affectedAgents) {
      this.notifyChange(agentId);
    }
  }

  /** Get all bindings for a specific agent. */
  getBindingsForAgent(agentId: string): McpBinding[] {
    return this.bindings.get(agentId) || [];
  }

  /** Get all bindings across all agents. */
  getAllBindings(): McpBinding[] {
    const all: McpBinding[] = [];
    for (const agentBindings of this.bindings.values()) {
      all.push(...agentBindings);
    }
    return all;
  }

  /** Register a listener for binding changes. Returns unsubscribe function. */
  onChange(listener: BindingChangeListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notifyChange(agentId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(agentId);
      } catch {
        // Listener threw — ignore
      }
    }
  }

  /** For testing: clear all state. */
  _resetForTesting(): void {
    this.bindings.clear();
    this.listeners.clear();
  }
}

export const bindingManager = new BindingManager();
