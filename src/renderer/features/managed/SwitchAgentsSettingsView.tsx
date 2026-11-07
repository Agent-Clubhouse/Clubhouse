import { useCallback, useEffect, useState } from 'react';
import type { DurableAgentConfig } from '../../../shared/types';
import { isDisposedAgent } from '../../../shared/agent-helpers';
import type { ManagedConvertPreview } from '../../../shared/managed-agents-types';
import { Button } from '../../components/Button';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { isRemoteProjectId } from '../../stores/remoteProjectStore';
import { SettingsPage, SettingsSection, settingsError, settingsHelp } from '../settings/SettingsLayout';
import { convertSummary } from './ManagedGeneralSection';
import { errorText, managed, unwrap } from './managedApi';
import { legacyLabel, legacyUse, migrationFailedLine, type LegacyUse } from './legacy';

/** An unmanaged agent the page can offer to switch. */
interface Candidate {
  key: string;
  projectPath: string;
  projectName: string;
  agent: DurableAgentConfig;
  legacy: LegacyUse | null;
}

const keyOf = (projectPath: string, agentId: string) => `${projectPath}\n${agentId}`;

/**
 * Settings › Managed agents › Switch agents (#2901): every unmanaged agent in
 * every local project, with the persona it still names, if any. Agents that
 * used Clubhouse Mode or a persona switch on their own (D59), so the list is
 * mostly plain agents, agents whose automatic switch failed (with the
 * reason), and running ones waiting for their next start. Agents with a
 * persona or a failed automatic switch are ticked; Switch
 * converts the ticked ones one at a time, keeping what each has now. Plain
 * agents are switched only when the person ticks them. Helpers, disposed
 * agents and agents still being created aren't listed. A running agent starts
 * unticked, since its session keeps the old files until its next start, and
 * one that is waking can't be ticked until it has started.
 */
export function SwitchAgentsSettingsView() {
  const projects = useProjectStore((s) => s.projects);
  const statuses = useAgentStore((s) => s.agents);
  const [configs, setConfigs] = useState<Array<{ projectPath: string; projectName: string; agents: DurableAgentConfig[] }> | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ switched: number; failed: Array<{ key: string; name: string; message: string }> } | null>(null);

  const load = useCallback(async () => {
    const local = projects.filter((p) => !isRemoteProjectId(p.id));
    try {
      const lists = await Promise.all(local.map(async (p) => ({
        projectPath: p.path,
        projectName: p.displayName || p.name,
        agents: await window.clubhouse.agent.listDurable(p.path),
      })));
      setConfigs(lists);
      setLoadError(false);
    } catch {
      // telemetry-exempt: the page says it couldn't read the agents.
      setLoadError(true);
    }
  }, [projects]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => managed().onChanged(() => { void load(); }), [load]);

  const candidates: Candidate[] = (configs ?? []).flatMap((p) => p.agents
    .filter((a) => !a.managed && !isDisposedAgent(a) && !a.creation && !a.parentAgentId)
    .map((agent) => ({
      key: keyOf(p.projectPath, agent.id),
      projectPath: p.projectPath,
      projectName: p.projectName,
      agent,
      legacy: legacyUse(agent),
    })));
  const statusOf = (c: Candidate) => statuses[c.agent.id]?.status;
  const isRunning = (c: Candidate) => statusOf(c) === 'running';
  const isStarting = (c: Candidate) => {
    const status = statusOf(c);
    return status === 'waking' || status === 'spawning' || status === 'creating';
  };
  const canSwitch = (c: Candidate) => !!c.agent.worktreePath && !isStarting(c);
  /** Names a persona, or its automatic switch failed. These start ticked. */
  const legacyConfigured = (c: Candidate) => !!c.legacy || !!c.agent.managedMigrationFailure;
  const isTicked = (c: Candidate) => canSwitch(c) && (ticks[c.key] ?? (legacyConfigured(c) && !isRunning(c)));
  const ticked = candidates.filter(isTicked);

  const switchTicked = async () => {
    setBusy(true);
    setResult(null);
    const failed: Array<{ key: string; name: string; message: string }> = [];
    let switched = 0;
    for (const c of ticked) {
      try {
        await unwrap(managed().convertAgent(c.projectPath, c.agent.id, true));
        switched++;
      } catch (err) {
        // telemetry-exempt: each failure is listed on the page by agent.
        failed.push({ key: c.key, name: c.agent.name, message: errorText(err) });
      }
    }
    setResult({ switched, failed });
    setTicks({});
    setBusy(false);
    await load();
  };

  const n = ticked.length;
  return (
    <SettingsPage
      title="Switch agents"
      description="Agents that Clubhouse doesn't manage. Agents that used Clubhouse Mode or a persona switch on their own at their next start, so most agents here are plain ones, plus any that couldn't switch. Switching keeps what each one has now: its instructions file becomes a block for that agent only, and its skills and MCP servers become parts."
      actions={
        <Button kind="primary" disabled={busy || n === 0} onClick={() => void switchTicked()} data-testid="managed-switch-run">
          {busy ? 'Switching…' : `Switch ${n} to managed`}
        </Button>
      }
      testId="managed-switch"
    >
      {result && (
        <div className="mt-2" role="status" data-testid="managed-switch-result">
          {result.switched > 0 && <p className={settingsHelp}>Switched {result.switched} {result.switched === 1 ? 'agent' : 'agents'}.</p>}
          {result.failed.length > 0 && (
            <ul className="mt-1" data-testid="managed-switch-failures">
              {result.failed.map((f) => <li key={f.key} className={settingsError}>{f.name} wasn't switched. {f.message}</li>)}
            </ul>
          )}
        </div>
      )}
      {loadError && <p role="alert" className={`${settingsError} mt-2`}>Couldn't read the agents. Reopen this page to try again.</p>}

      <SettingsSection title="Agents" meta={configs ? String(candidates.length) : undefined}>
        {configs === null && !loadError && <p className={`${settingsHelp} py-2`}>Loading…</p>}
        {configs !== null && candidates.length === 0 && (
          <p className={`${settingsHelp} py-2 border-t border-surface-0`}>Every agent is Clubhouse managed.</p>
        )}
        <ul data-testid="managed-switch-list">
          {candidates.map((c) => (
            <li key={c.key} className="py-2 border-t border-surface-0" data-testid="managed-switch-row">
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={isTicked(c)}
                  disabled={busy || !canSwitch(c)}
                  onChange={(e) => setTicks((t) => ({ ...t, [c.key]: e.target.checked }))}
                  aria-label={`Switch ${c.agent.name}`}
                />
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] text-ctp-text truncate">{c.agent.name}</span>
                  <span className="block text-xs text-ctp-overlay1 truncate">
                    {c.projectName} · {legacyLabel(c.legacy)}
                  </span>
                  {!c.agent.worktreePath && <span className="block text-xs text-ctp-overlay1">Works in the project folder, so it can't be managed.</span>}
                  {c.agent.worktreePath && isStarting(c) && <span className="block text-xs text-ctp-overlay1" data-testid="managed-switch-waking">Waking. Switch it once it has started.</span>}
                  {c.agent.managedMigrationFailure && <span className="block text-xs text-ctp-warning" data-testid="managed-switch-failed">{migrationFailedLine(c.agent.managedMigrationFailure.message)}</span>}
                  {c.agent.worktreePath && isRunning(c) && (
                    <span className="block text-xs text-ctp-overlay1" data-testid="managed-switch-running">
                      {c.legacy && !c.agent.managedMigrationFailure && !c.agent.managedMigration && !c.agent.switchedToManagedAt && c.agent.clubhouseFeatures !== false ? 'Running. It switches on its own at its next start.' : 'Running: the switch applies at its next start.'}
                    </span>
                  )}
                </span>
                {!!c.agent.worktreePath && (
                  <Button kind="quiet" aria-expanded={open === c.key} onClick={() => setOpen(open === c.key ? null : c.key)}>
                    {open === c.key ? 'Hide preview' : 'Preview'}
                  </Button>
                )}
              </div>
              {open === c.key && <ConvertPreview projectPath={c.projectPath} agentId={c.agent.id} />}
            </li>
          ))}
        </ul>
      </SettingsSection>
    </SettingsPage>
  );
}

/** What Keep would bring over for one agent. Reads only. */
function ConvertPreview({ projectPath, agentId }: { projectPath: string; agentId: string }) {
  const [preview, setPreview] = useState<ManagedConvertPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    unwrap(managed().previewConvert(projectPath, agentId))
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((err) => { /* telemetry-exempt: shown in the row */ if (!cancelled) setError(errorText(err)); });
    return () => { cancelled = true; };
  }, [projectPath, agentId]);
  return (
    <div className="pl-7 pt-1.5 flex flex-col gap-1 text-xs" data-testid="managed-switch-preview">
      {!preview && !error && <span className="text-ctp-overlay1">Reading what it has…</span>}
      {error && <span role="alert" className="text-ctp-error">{error}</span>}
      {preview && <span className="text-ctp-subtext1">{convertSummary(preview)}</span>}
      {preview?.notes.map((note) => <span key={note} className="text-ctp-warning">{note}</span>)}
    </div>
  );
}
