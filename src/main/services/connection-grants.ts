/**
 * Connection permissions in the live bindings (D129, #2969, #2972).
 *
 * - A new agent-to-agent binding takes its disabled tools from the store.
 * - A binding a source restores with its own list (a canvas wire saved
 *   before the store) keeps the store's list when it has one, and moves its
 *   own into the store when it doesn't: the migration, pair by pair.
 * - A store write updates the live binding, so calls are checked against the
 *   store by the existing call path (tool-registry's disabled tools).
 * - The user's own links (Make two-way) are a persisted binding source.
 */

import type { AgentAddress, ConnectionDirection } from '../../shared/connection-grants';
import { NEW_CONNECTION_DISABLED_TOOLS } from '../../shared/connection-grants';
import type { BindingTargetKind } from './clubhouse-mcp/types';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import {
  deniedConnectionTools, getConnectionDirection, listLinkedDirections, onConnectionGrantsChanged,
  setConnectionLink, setConnectionTools,
} from './connection-grants-store';
import { appLog } from './log-service';
import * as agentConfig from './agent-config';
import * as projectStore from './project-store';
import { registerPersistedBindingSource, rebuildPersistedBindings, type PersistedBinding, type PersistedBindingSource } from './persisted-bindings';

export const USER_CONNECTION_SOURCE_ID = 'user-connections';

const local = (agentId: string): AgentAddress => ({ agentId });

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Restore: the store wins; a list it doesn't have moves in. */
function restoreTools(agentId: string, targetId: string, targetKind: BindingTargetKind, legacy: string[]): void {
  if (targetKind !== 'agent') {
    bindingManager.setDisabledTools(agentId, targetId, legacy);
    return;
  }
  const saved = deniedConnectionTools(local(agentId), local(targetId));
  if (saved) {
    bindingManager.setDisabledTools(agentId, targetId, saved);
    return;
  }
  bindingManager.setDisabledTools(agentId, targetId, legacy);
  void setConnectionTools(local(agentId), local(targetId), legacy).catch((err) => {
    // telemetry-exempt: logged; the live binding already has the list, and the next restore tries again
    appLog('core:mcp', 'warn', 'Could not move a wire’s disabled tools into the connection store', { meta: { agentId, targetId, error: errorText(err) } });
  });
}

/**
 * Set one direction's disabled tools: the store for an agent-to-agent
 * direction (an edit from the canvas popover or the Connections card), the
 * binding alone for any other target. `restore`: a canvas wire bound again,
 * whose list only fills a store that has none.
 */
export async function applyConnectionTools(agentId: string, targetId: string, disabledTools: string[], options: { restore?: boolean } = {}): Promise<void> {
  const binding = bindingManager.getBindingsForAgent(agentId).find((b) => b.targetId === targetId);
  const targetKind = binding?.targetKind;
  if (targetKind && targetKind !== 'agent') {
    bindingManager.setDisabledTools(agentId, targetId, disabledTools);
    return;
  }
  if (options.restore && binding) {
    restoreTools(agentId, targetId, 'agent', disabledTools);
    return;
  }
  // An edit, or a sleeping agent's wire with no live binding: the store, then the binding follows.
  await setConnectionTools(local(agentId), local(targetId), disabledTools);
}

/** The user's links: one binding per direction with a link. */
const userConnectionSource: PersistedBindingSource = {
  id: USER_CONNECTION_SOURCE_ID,
  prune: true,
  async collect() {
    const linked = allLinked();
    if (linked.length === 0) return [];
    const names = await agentNames();
    return linked.map((d): PersistedBinding => ({
      agentId: d.from.agentId,
      targetId: d.to.agentId,
      targetKind: 'agent',
      label: names.get(d.to.agentId) ?? d.to.agentId,
      ...(names.get(d.from.agentId) && { agentName: names.get(d.from.agentId) }),
      ...(names.get(d.to.agentId) && { targetName: names.get(d.to.agentId) }),
      ...(d.disabledTools.length > 0 && { disabledTools: d.disabledTools }),
    }));
  },
};

/** Every direction with the user's link, on this machine. */
function allLinked(): ConnectionDirection[] {
  return listLinkedDirections().filter((d) => !d.from.machineId && !d.to.machineId);
}

async function agentNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const projects = await Promise.resolve().then(() => projectStore.peekProjects()).catch((): Array<{ path: string }> => []);
  for (const p of projects) {
    const agents = await Promise.resolve().then(() => agentConfig.peekDurableConfigs(p.path)).catch((): ReadonlyArray<{ id: string; name: string }> => []);
    for (const a of agents) names.set(a.id, a.name);
  }
  return names;
}

/**
 * Make a one-way connection two-way (#2972): the user's own link for the
 * other direction, starting like any new connection (read and message).
 */
export async function makeTwoWay(fromAgentId: string, toAgentId: string): Promise<void> {
  const existing = getConnectionDirection(local(fromAgentId), local(toAgentId));
  await setConnectionLink(local(fromAgentId), local(toAgentId), true, existing ? existing.disabledTools : NEW_CONNECTION_DISABLED_TOOLS);
  await rebuildPersistedBindings();
}

/** Remove the user's own link for one direction. */
export async function removeUserLink(fromAgentId: string, toAgentId: string): Promise<void> {
  await setConnectionLink(local(fromAgentId), local(toAgentId), false);
  await rebuildPersistedBindings();
}

/** Wire the store into the live bindings. Returns the undo, for tests. */
export function startConnectionGrants(): () => void {
  bindingManager.setConnectionToolsSource(
    (agentId, targetId, targetKind) => (targetKind === 'agent' ? deniedConnectionTools(local(agentId), local(targetId)) : undefined),
    restoreTools,
  );
  const unregister = registerPersistedBindingSource(userConnectionSource);
  const unsubscribe = onConnectionGrantsChanged((from, to) => {
    if (from.machineId || to.machineId) return;
    const entry = getConnectionDirection(from, to);
    bindingManager.setDisabledTools(from.agentId, to.agentId, entry?.disabledTools ?? []);
  });
  return () => {
    bindingManager.setConnectionToolsSource(null, null);
    unregister();
    unsubscribe();
  };
}
