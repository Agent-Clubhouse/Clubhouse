import { useCallback, useEffect, useRef, useState } from 'react';
import type { DurableAgentConfig, DurableConfigUpdates } from '../../../../shared/types';

export interface DurableConfigState {
  /** The saved config; null until loaded, or when the agent has none. */
  config: DurableAgentConfig | null;
  loaded: boolean;
  /**
   * Save `updates` through `agent.updateDurableConfig`. The change shows at
   * once; on failure the config goes back to what it was and this throws, so
   * the row can say it couldn't save.
   */
  update: (updates: DurableConfigUpdates) => Promise<void>;
}

/**
 * `updates` applied to a config as main saves them (agent-config.ts): null
 * clears a field, and so do the values main stores as "unset" ('inherit'
 * auto-sleep, the 'default' model, false flags, no MCP ids).
 */
export function applyUpdates(config: DurableAgentConfig | null, updates: DurableConfigUpdates): DurableAgentConfig {
  const next: Record<string, unknown> = { ...(config ?? {}) };
  for (const [key, value] of Object.entries(updates)) {
    const unset = value === null || value === undefined || value === false || value === 'inherit'
      || (key === 'model' && (value === '' || value === 'default'))
      || (key === 'mcpIds' && Array.isArray(value) && value.length === 0);
    if (unset) delete next[key];
    else next[key] = value;
  }
  return next as unknown as DurableAgentConfig;
}

/**
 * The agent's durable config for the Settings card (#2280), read once per
 * agent and shared by its rows so each doesn't fetch it again. No folder (an
 * agent on another machine) means nothing to read.
 */
export function useDurableConfig(projectPath: string | undefined, agentId: string): DurableConfigState {
  const key = projectPath ? `${projectPath}\n${agentId}` : null;
  const [state, setState] = useState<{ key: string | null; config: DurableAgentConfig | null; loaded: boolean }>({ key: null, config: null, loaded: false });

  useEffect(() => {
    if (!projectPath || !key) return;
    let alive = true;
    Promise.resolve().then(() => window.clubhouse.agent.getDurableConfig(projectPath, agentId)).then(
      (config) => { if (alive) setState({ key, config: (config as DurableAgentConfig | null) ?? null, loaded: true }); },
      // telemetry-exempt: the rows show defaults and the full settings page still works.
      () => { if (alive) setState({ key, config: null, loaded: true }); },
    );
    return () => { alive = false; };
  }, [projectPath, agentId, key]);

  const current = state.key === key ? state : null;
  // What the rows show, read synchronously when a write starts.
  const configRef = useRef<DurableAgentConfig | null>(null);
  configRef.current = current?.config ?? null;

  const update = useCallback(async (updates: DurableConfigUpdates) => {
    if (!projectPath || !key) throw new Error('No project folder for this agent');
    // Only the fields this write touches roll back, so a failure doesn't undo another row's save.
    const saved = (configRef.current ?? {}) as unknown as Record<string, unknown>;
    const before = Object.fromEntries(Object.keys(updates).map((k) => [k, saved[k] ?? null])) as DurableConfigUpdates;
    const apply = (u: DurableConfigUpdates) => setState((s) => {
      // A config that failed to load still shows what was saved.
      if (s.key !== key) return s;
      return { ...s, config: applyUpdates(s.config, u) };
    });
    apply(updates);
    try {
      await window.clubhouse.agent.updateDurableConfig(projectPath, agentId, updates);
    } catch (err) {
      apply(before);
      throw err;
    }
  }, [projectPath, agentId, key]);

  return { config: current?.config ?? null, loaded: current?.loaded ?? false, update };
}
