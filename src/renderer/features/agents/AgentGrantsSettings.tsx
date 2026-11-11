/**
 * The agent's Clubhouse permissions page (#2971, part of #2921): what it can do
 * to other agents, projects and the app through Clubhouse, grouped by target.
 * Each row saves on its own, like the Helpers page, so this page never joins
 * the save bar. Main applies the change and hands back the whole view.
 */

import { useEffect, useId, useRef, useState } from 'react';
import type { Agent } from '../../../shared/types';
import type { GrantTarget } from '../../../shared/agent-grants';
import {
  GRANT_ACTION_LABELS, grantKey, grantTargetLabel, targetKey,
  type AgentGrantsView, type GrantChangeMode, type GrantRow,
} from '../../../shared/agent-grant-changes';
import { Button } from '../../components/Button';
import { reportChromeActionFailed } from '../../chrome/telemetry';
import { Field, SectionHeading } from './agentSettingsUi';
import { GrantRequestList } from './GrantRequestList';
import { useGrantRequestStore } from '../../stores/grantRequestStore';

const MODES: ReadonlyArray<{ mode: GrantChangeMode; label: string }> = [
  { mode: 'off', label: 'Off' },
  { mode: 'ask', label: 'Ask first' },
  { mode: 'allow', label: 'Allow' },
];

/** Groups go itself, its orchestrator, its helpers, connected agents, group projects, projects, the app, everything. */
const TARGET_ORDER: ReadonlyArray<GrantTarget['kind']> = [
  'self', 'parent', 'my_helpers', 'connected', 'group_project', 'group_members', 'project', 'app', 'any',
];

export const SOURCE_LABEL: Record<GrantRow['source'], string | undefined> = {
  every_agent: 'Default for all agents',
  structural: 'Built in',
  template: 'From its template',
  user: 'Set by you',
  dispatcher: 'Set by Dispatcher',
  none: undefined,
};

const SET_FAILED = "Couldn't save that change, so it wasn't changed. Try again.";
const RESET_FAILED = "Couldn't reset to defaults, so nothing changed. Try again.";

export interface GrantGroup {
  key: string;
  label: string;
  rows: GrantRow[];
}

/** Rows grouped by target in page order; rows keep their order inside a group. */
export function groupGrantRows(rows: readonly GrantRow[]): GrantGroup[] {
  const groups = new Map<string, GrantGroup>();
  for (const row of rows) {
    const key = targetKey(row.target);
    let group = groups.get(key);
    if (!group) {
      group = { key, label: grantTargetLabel(row.target), rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  const rank = (g: GrantGroup) => TARGET_ORDER.indexOf(g.rows[0].target.kind);
  return [...groups.values()].sort((a, b) => rank(a) - rank(b));
}

export function AgentGrantsSettings({ agent, projectPath, refreshKey = 0 }: {
  agent: Pick<Agent, 'id' | 'name'>;
  projectPath: string | undefined;
  /** Bumped by the page's Reload button. */
  refreshKey?: number;
}) {
  const [view, setView] = useState<AgentGrantsView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  // Modes picked but not saved yet, by grant key. A failed save drops its entry, so the row shows the saved value again.
  const [pending, setPending] = useState<Record<string, GrantChangeMode>>({});
  // A failed change shows under its row (key); a failed reset shows at the top (key null).
  const [error, setError] = useState<{ key: string | null; message: string } | null>(null);
  const [resetting, setResetting] = useState(false);
  // Replies can land out of order: only a reply to a later request replaces the view.
  const requestSeq = useRef(0);
  const appliedSeq = useRef(0);

  useEffect(() => {
    setView(null);
    setPending({});
    setError(null);
    setLoadFailed(false);
    if (!projectPath) return;
    let cancelled = false;
    const seq = ++requestSeq.current;
    window.clubhouse.agent.getGrants(projectPath, agent.id)
      .then((next) => {
        if (cancelled || seq < appliedSeq.current) return;
        appliedSeq.current = seq;
        setView(next);
      })
      .catch(() => {
        // telemetry-exempt: the page says it couldn't read them and offers Try again
        if (!cancelled) setLoadFailed(true);
      });
    return () => { cancelled = true; };
  }, [projectPath, agent.id, refreshKey, loadAttempt]);

  const applyView = (seq: number, next: AgentGrantsView) => {
    if (seq < appliedSeq.current) return;
    appliedSeq.current = seq;
    setView(next);
  };

  const change = async (row: GrantRow, mode: GrantChangeMode) => {
    if (!projectPath) return;
    const key = grantKey(row);
    setError(null);
    setPending((p) => ({ ...p, [key]: mode }));
    const seq = ++requestSeq.current;
    try {
      applyView(seq, await window.clubhouse.agent.setGrant(projectPath, agent.id, { action: row.action, target: row.target, mode }));
    } catch (err) {
      reportChromeActionFailed('agent_settings_save', err);
      // A later change already answered: this one's failure is old news.
      if (seq >= appliedSeq.current) setError({ key, message: SET_FAILED });
    }
    setPending((p) => {
      if (p[key] !== mode) return p;
      const rest = { ...p };
      delete rest[key];
      return rest;
    });
  };

  const reset = async () => {
    if (!projectPath) return;
    setError(null);
    setResetting(true);
    const seq = ++requestSeq.current;
    try {
      applyView(seq, await window.clubhouse.agent.resetGrants(projectPath, agent.id));
      setPending({});
    } catch (err) {
      reportChromeActionFailed('agent_settings_save', err);
      setError({ key: null, message: RESET_FAILED });
    }
    setResetting(false);
  };

  if (!projectPath) {
    return <p className="mt-3 text-[13px] text-ctp-subtext1" data-testid="agent-grants-unavailable">Couldn't read {agent.name}'s Clubhouse permissions.</p>;
  }

  const intro = (
    <p className="text-xs text-ctp-overlay1 mb-1">
      This is what {agent.name} can do to other agents, projects and the app through Clubhouse, separate from its Access level, which governs its CLI.
      {' '}It's a guardrail on Clubhouse, not a sandbox, so other programs running as you aren't limited by it.
    </p>
  );

  if (loadFailed) {
    return (
      <div data-testid="agent-grants-settings">
        {intro}
        <p role="alert" className="mt-3 text-[13px] text-ctp-error flex items-center gap-2">
          Couldn't read {agent.name}'s Clubhouse permissions.
          <Button kind="quiet" onClick={() => setLoadAttempt((n) => n + 1)}>Try again</Button>
        </p>
      </div>
    );
  }

  if (!view) {
    return (
      <div data-testid="agent-grants-settings">
        {intro}
        <p className="mt-3 text-[13px] text-ctp-overlay1" data-testid="agent-grants-loading">Loading…</p>
      </div>
    );
  }

  const changed = view.rows.some((r) => r.mode !== r.defaultMode);
  const groups = groupGrantRows(view.rows);

  return (
    <div data-testid="agent-grants-settings">
      {intro}
      <WaitingRequests agentId={agent.id} agentName={agent.name} onAnswered={() => setLoadAttempt((n) => n + 1)} />
      <div className="flex items-center justify-end gap-3 min-h-[28px]">
        {changed && (
          <Button onClick={() => void reset()} disabled={resetting} data-testid="agent-grants-reset">Reset to defaults</Button>
        )}
      </div>
      {error && error.key === null && <p role="alert" className="mt-1 text-xs text-ctp-error">{error.message}</p>}
      {groups.length === 0 && (
        <p className="mt-3 text-[13px] text-ctp-overlay1" data-testid="agent-grants-empty">{agent.name} has no Clubhouse permissions to show.</p>
      )}
      {groups.map((group) => (
        <section key={group.key} data-testid={`agent-grants-group-${group.key}`} aria-label={group.label}>
          <SectionHeading title={group.label} />
          {group.rows.map((row) => {
            const key = grantKey(row);
            return (
              <GrantRowField
                key={key}
                row={row}
                targetLabel={group.label}
                coveredBy={coveredLabel(view, row)}
                mode={pending[key] ?? row.mode}
                disabled={resetting}
                error={error?.key === key ? error.message : undefined}
                onChange={(mode) => void change(row, mode)}
              />
            );
          })}
        </section>
      ))}
    </div>
  );
}

/** Requests waiting on the user (#2970), above the rows they'd change. */
function WaitingRequests({ agentId, agentName, onAnswered }: { agentId: string; agentName: string; onAnswered: () => void }) {
  const waiting = useGrantRequestStore((s) => Object.values(s.requests).some((r) => r.agentId === agentId));
  if (!waiting) return null;
  return (
    <section aria-label="Waiting for you" data-testid="agent-grants-waiting">
      <SectionHeading title="Waiting for you" />
      <GrantRequestList agentId={agentId} agentName={agentName} onAnswered={onAnswered} />
    </section>
  );
}

/** The heading of the wider row that allows this one, when there is one (#2971). */
function coveredLabel(view: AgentGrantsView | null, row: GrantRow): string | undefined {
  if (!row.coveredBy || !view) return undefined;
  const wider = view.rows.find((r) => grantKey(r) === row.coveredBy);
  return wider ? grantTargetLabel(wider.target) : undefined;
}

export function GrantRowField({ row, targetLabel, coveredBy, note, mode, disabled, error, onChange }: {
  row: GrantRow;
  targetLabel: string;
  /** A wider row allows this action: this row's own setting would change nothing. */
  coveredBy?: string;
  /** Set elsewhere: why, in place of the choices being changeable. */
  note?: string;
  mode: GrantChangeMode;
  disabled: boolean;
  error: string | undefined;
  onChange: (mode: GrantChangeMode) => void;
}) {
  const name = useId();
  const actionLabel = GRANT_ACTION_LABELS[row.action];
  const off = disabled || row.fixed || !!coveredBy || !!note;
  return (
    <div data-testid={`agent-grant-row-${grantKey(row)}`}>
      <Field label={actionLabel} help={SOURCE_LABEL[row.source]}>
        {row.fixed && <span className="text-xs text-ctp-overlay1">Always on</span>}
        {coveredBy && <span className="text-xs text-ctp-overlay1">Allowed by {coveredBy}. Change it there.</span>}
        {note && <span className="text-xs text-ctp-overlay1">{note}</span>}
        <div role="radiogroup" aria-label={`${actionLabel} (${targetLabel})`} className="flex items-center gap-3">
          {MODES.map((m) => (
            <label
              key={m.mode}
              className={`flex items-center gap-1.5 text-xs ${off ? 'text-ctp-overlay0 cursor-not-allowed' : 'text-ctp-subtext1 cursor-pointer'}`}
            >
              <input
                type="radio"
                name={name}
                value={m.mode}
                checked={mode === m.mode}
                disabled={off}
                onChange={() => onChange(m.mode)}
                className="w-3.5 h-3.5 accent-ctp-accent shrink-0 disabled:cursor-not-allowed"
              />
              {m.label}
            </label>
          ))}
        </div>
      </Field>
      {error && <p role="alert" className="pb-1.5 text-xs text-ctp-error">{error}</p>}
    </div>
  );
}
