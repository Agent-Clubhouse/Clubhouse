/**
 * Data for the orchestration UI (#2232): an agent's orchestration policy and
 * access ceiling, the app-wide helper cap, and the project's agent configs
 * (the source for helpers, disposed rows and parent links). Main owns all of
 * it; these hooks read it, write through the preload API and re-read when the
 * project's agent configs change.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, DurableAgentConfig, HelperStartDecisionResult, HelperStartRequest } from '../../../../shared/types';
import {
  DEFAULT_GLOBAL_HELPER_CAP,
  MAX_HELPER_LIMIT,
  type HelperAccessResolution,
  type OrchestrationPolicyPatch,
  type ResolvedOrchestrationPolicy,
} from '../../../../shared/orchestration-policy';
import { useAgentStore } from '../../../stores/agentStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useUIStore } from '../../../stores/uiStore';
import { startRequestsFor, useHelperStartRequestStore } from '../../../stores/helperStartRequestStore';
import { sameProjectPath } from '../../../utils/project-path';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── App-wide cap ────────────────────────────────────────────────────────

/** The app-wide cap on live helpers, kept current across windows. */
export function useGlobalHelperCap(): { cap: number; loaded: boolean } {
  const [cap, setCap] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => window.clubhouse.app.getOrchestrationSettings()).then(
      (s) => { if (alive) setCap(s?.globalHelperCap ?? DEFAULT_GLOBAL_HELPER_CAP); },
      // telemetry-exempt: the default cap shows; saving still reports its own error.
      () => { if (alive) setCap(DEFAULT_GLOBAL_HELPER_CAP); },
    );
    const off = window.clubhouse.app.onOrchestrationSettingsChanged?.((s) => setCap(s.globalHelperCap));
    return () => { alive = false; off?.(); };
  }, []);
  return { cap: cap ?? DEFAULT_GLOBAL_HELPER_CAP, loaded: cap !== null };
}

/** The most helpers one agent may have: the app cap, and never above the hard limit. */
export function maxHelpersCeiling(globalCap: number): number {
  return Math.max(1, Math.min(MAX_HELPER_LIMIT, globalCap));
}

/** Parse a "helpers at once" entry, or explain why it can't be used. */
export function parseHelperCount(raw: string, ceiling: number): { value: number } | { error: string } {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return { error: `Enter a whole number from 1 to ${ceiling}.` };
  const value = Number(trimmed);
  if (value < 1 || value > ceiling) return { error: `Enter a whole number from 1 to ${ceiling}.` };
  return { value };
}

/** Open Settings → Helpers, where the app-wide cap is set. */
export function openHelpersSettings(): void {
  const ui = useUIStore.getState();
  if (ui.explorerTab !== 'settings') ui.toggleSettings();
  ui.setSettingsContext('app');
  ui.setSettingsSubPage('helpers');
}

// ── Project agent configs ───────────────────────────────────────────────

export { sameProjectPath };

/**
 * Every durable config in a project, disposed ones included. Re-read when
 * main says the project's configs changed (a parent link, creation, disposal
 * or handoff, from any window or an external edit), when the rail's agents in
 * that project change (a helper starts, wakes, sleeps, goes or is kept as a
 * normal agent), and on `reload`.
 */
export function useProjectAgentConfigs(projectPath: string | undefined, projectId: string | undefined): {
  configs: DurableAgentConfig[] | null;
  reload: () => void;
} {
  // A string, so the hook re-reads only when an id, status or parent link changes.
  const railKey = useAgentStore((s) => Object.values(s.agents)
    .filter((a) => a.projectId === projectId && a.kind === 'durable')
    .map((a) => `${a.id}:${a.status}:${a.parentAgentId ?? ''}:${a.creationFailed ? 'f' : ''}`)
    .join(','));
  const [configs, setConfigs] = useState<DurableAgentConfig[] | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!projectPath) return;
    return window.clubhouse.agent.onConfigsChanged?.((changed) => {
      if (sameProjectPath(changed, projectPath)) setNonce((n) => n + 1);
    });
  }, [projectPath]);
  useEffect(() => {
    if (!projectPath) { setConfigs(null); return; }
    let alive = true;
    Promise.resolve().then(() => window.clubhouse.agent.listDurable(projectPath)).then(
      (list) => { if (alive) setConfigs(Array.isArray(list) ? list as DurableAgentConfig[] : []); },
      // telemetry-exempt: the cards say there are no helpers rather than break details.
      () => { if (alive) setConfigs([]); },
    );
    return () => { alive = false; };
  }, [projectPath, railKey, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { configs, reload };
}

/**
 * The agent's parent link, from the rail's agent when it carries one (#2231)
 * or its config. Null for a top-level agent and until loaded.
 */
export function useHelperLink(agent: Agent, projectPath: string | undefined): { parentAgentId: string; disposable: boolean } | null {
  const [link, setLink] = useState<{ id: string; parentAgentId?: string; disposable: boolean } | null>(null);
  const local = agent.kind === 'durable' && !!projectPath;
  useEffect(() => {
    if (!local || !projectPath) { setLink(null); return; }
    let alive = true;
    Promise.resolve().then(() => window.clubhouse.agent.getDurableConfig(projectPath, agent.id)).then(
      (config: DurableAgentConfig | null | undefined) => {
        if (alive) setLink({ id: agent.id, parentAgentId: config?.parentAgentId, disposable: !!config?.disposable });
      },
      // telemetry-exempt: no helper header; the agent's view still works.
      () => { if (alive) setLink(null); },
    );
    return () => { alive = false; };
  }, [local, projectPath, agent.id, agent.parentAgentId]);
  const parentAgentId = (link?.id === agent.id ? link.parentAgentId : undefined) ?? (local ? agent.parentAgentId : undefined);
  if (!parentAgentId) return null;
  return { parentAgentId, disposable: link?.id === agent.id ? link.disposable : false };
}

// ── Orchestration policy ────────────────────────────────────────────────

export interface OrchestrationState {
  /** Null while loading, or for an agent main doesn't know. */
  policy: ResolvedOrchestrationPolicy | null;
  /** What helpers would get if started now; the ceiling is the orchestrator's live level. */
  access: HelperAccessResolution | null;
  globalCap: number;
  saving: boolean;
  /** Why the last change didn't save. */
  error: string | null;
  /** Set after turning orchestration on for an agent that isn't running. */
  note: string | null;
  /** Helpers that must be kept or disposed before orchestration can go off. */
  turnOff: { helperIds: string[] } | null;
  setPolicy: (patch: OrchestrationPolicyPatch) => Promise<boolean>;
  setOrchestrate: (on: boolean) => Promise<void>;
  /** The turn-off dialog finished; `policy` is the new one when it went off. */
  finishTurnOff: (policy?: ResolvedOrchestrationPolicy) => void;
  reload: () => void;
}

/**
 * An agent's orchestration policy and the controls' state, for the Orchestrate
 * card and both Helpers settings pages.
 */
export function useOrchestration(projectPath: string | undefined, agent: Pick<Agent, 'id' | 'name' | 'status'>): OrchestrationState {
  const [policy, setPolicyState] = useState<ResolvedOrchestrationPolicy | null>(null);
  const [access, setAccess] = useState<HelperAccessResolution | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [turnOff, setTurnOff] = useState<{ helperIds: string[] } | null>(null);
  const [nonce, setNonce] = useState(0);
  const { cap: globalCap } = useGlobalHelperCap();
  const running = agent.status === 'running';
  const agentRef = useRef(agent);
  agentRef.current = agent;

  useEffect(() => {
    if (!projectPath) { setPolicyState(null); return; }
    let alive = true;
    Promise.resolve().then(() => window.clubhouse.agent.getOrchestrationPolicy(projectPath, agent.id)).then(
      (p) => { if (alive) setPolicyState(p ?? null); },
      // telemetry-exempt: the card shows orchestration as unavailable.
      () => { if (alive) setPolicyState(null); },
    );
    return () => { alive = false; };
  }, [projectPath, agent.id, nonce]);

  // The ceiling follows the orchestrator's live level, so re-read as it starts and stops.
  useEffect(() => {
    if (!projectPath) { setAccess(null); return; }
    let alive = true;
    Promise.resolve().then(() => window.clubhouse.agent.resolveHelperAccess(projectPath, agent.id)).then(
      (r) => { if (alive) setAccess(r ?? null); },
      // telemetry-exempt: the access row shows no ceiling line.
      () => { if (alive) setAccess(null); },
    );
    return () => { alive = false; };
  }, [projectPath, agent.id, running, policy?.access, nonce]);

  // Another agent's note or error never shows on this one.
  useEffect(() => { setNote(null); setError(null); setTurnOff(null); }, [agent.id]);

  const setPolicy = useCallback(async (patch: OrchestrationPolicyPatch): Promise<boolean> => {
    if (!projectPath) return false;
    setSaving(true);
    setError(null);
    try {
      const result = await window.clubhouse.agent.setOrchestrationPolicy(projectPath, agent.id, patch);
      if (result.needsHelperChoice) {
        setTurnOff({ helperIds: result.needsHelperChoice.helperIds });
        return false;
      }
      if (!result.ok) {
        setError(result.message || 'Couldn’t save. Try again.');
        return false;
      }
      if (result.policy) setPolicyState(result.policy);
      return true;
    } catch (err) {
      // telemetry-exempt: shown in the card or settings row, which keep the saved value.
      setError(errorText(err) || 'Couldn’t save. Try again.');
      return false;
    } finally {
      setSaving(false);
    }
  }, [projectPath, agent.id]);

  const setOrchestrate = useCallback(async (on: boolean) => {
    setNote(null);
    const ok = await setPolicy({ orchestrate: on });
    if (ok && on && agentRef.current.status !== 'running') {
      setNote(`Saved. The helper tools appear the next time ${agentRef.current.name} starts.`);
    }
  }, [setPolicy]);

  const finishTurnOff = useCallback((next?: ResolvedOrchestrationPolicy) => {
    setTurnOff(null);
    if (next) setPolicyState(next);
    else setNonce((n) => n + 1);
  }, []);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return useMemo(() => ({
    policy, access, globalCap, saving, error, note, turnOff, setPolicy, setOrchestrate, finishTurnOff, reload,
  }), [policy, access, globalCap, saving, error, note, turnOff, setPolicy, setOrchestrate, finishTurnOff, reload]);
}

// ── Start approvals (#2234) ─────────────────────────────────────────────

export interface StartApprovals {
  /** The orchestrator's helper starts waiting on the user, oldest first. */
  pending: HelperStartRequest[];
  onApprove: (requestId: string) => Promise<HelperStartDecisionResult>;
  onDecline: (requestId: string) => Promise<HelperStartDecisionResult>;
}

/**
 * An orchestrator's waiting helper starts, and approve or decline for each.
 * Main uses a request up whatever the answer, so it leaves the list once
 * main replies; `onStarted` runs after an approved start began.
 */
export function useHelperStartApprovals(orchestratorId: string, projectPath: string | undefined, onStarted: () => void): StartApprovals {
  const requests = useHelperStartRequestStore((s) => s.requests);
  const pending = useMemo(() => startRequestsFor(requests, orchestratorId), [requests, orchestratorId]);
  const onStartedRef = useRef(onStarted);
  onStartedRef.current = onStarted;

  const decide = useCallback(async (requestId: string, approve: boolean): Promise<HelperStartDecisionResult> => {
    if (!projectPath) return { ok: false, message: 'This agent’s project isn’t open.' };
    const result = approve
      ? await window.clubhouse.agent.approveHelperStart(projectPath, requestId)
      : await window.clubhouse.agent.declineHelperStart(projectPath, requestId);
    useHelperStartRequestStore.getState().remove([requestId]);
    if (approve && result.ok) onStartedRef.current();
    return result;
  }, [projectPath]);

  const onApprove = useCallback((requestId: string) => decide(requestId, true), [decide]);
  const onDecline = useCallback((requestId: string) => decide(requestId, false), [decide]);
  return useMemo(() => ({ pending, onApprove, onDecline }), [pending, onApprove, onDecline]);
}

// ── Navigation ──────────────────────────────────────────────────────────

/** Show an agent in the main pane, as picking it in the sidebar does. */
export function openAgent(projectId: string, agentId: string): void {
  const projects = useProjectStore.getState();
  if (projects.activeProjectId !== projectId) projects.setActiveProject(projectId);
  const agents = useAgentStore.getState();
  if (agents.agentSettingsOpenFor) agents.closeAgentSettings();
  useUIStore.getState().setExplorerTab('agents', projectId);
  agents.setActiveAgent(agentId, projectId);
}

/** Refresh the rail after main changed the project's agents (keep or dispose). */
export async function reloadProjectAgents(projectId: string, projectPath: string, disposedIds: readonly string[] = []): Promise<void> {
  const store = useAgentStore.getState();
  for (const id of disposedIds) store.removeAgent(id);
  try {
    await store.loadDurableAgents(projectId, projectPath);
  } catch {
    // telemetry-exempt: the rail catches up on its next load; the dialog already reported the result.
  }
}
