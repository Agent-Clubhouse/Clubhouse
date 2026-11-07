import { useCallback, useEffect, useState } from 'react';
import type { DurableAgentConfig } from '../../../shared/types';
import { isDisposedAgent } from '../../../shared/agent-helpers';
import type { ManagedConvertPreview } from '../../../shared/managed-agents-types';
import { Button } from '../../components/Button';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { useClubhouseModeStore } from '../../stores/clubhouseModeStore';
import { isRemoteProjectId } from '../../stores/remoteProjectStore';
import { SettingsPage, SettingsSection, settingsError, settingsHelp } from '../settings/SettingsLayout';
import { convertSummary } from './ManagedGeneralSection';
import { errorText, managed, unwrap } from './managedApi';
import { legacyLabel, legacyUse, type LegacyUse } from './legacy';

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
 * every local project, with what it uses. Agents that use Clubhouse Mode or a
 * persona are ticked; Switch converts the ticked ones one at a time, keeping
 * what each has now. Nothing is switched without the person asking. Helpers,
 * disposed agents and agents still being created aren't listed. A running
 * agent starts unticked, since its session keeps the old files until its next
 * start, and one that is waking can't be ticked until it has started.
 */
export function SwitchAgentsSettingsView() {
  const projects = useProjectStore((s) => s.projects);
  const clubhouseEnabled = useClubhouseModeStore((s) => s.enabled);
  const clubhouseOverrides = useClubhouseModeStore((s) => s.projectOverrides);
  const loadClubhouse = useClubhouseModeStore((s) => s.loadSettings);
  const statuses = useAgentStore((s) => s.agents);
  const [configs, setConfigs] = useState<Array<{ projectPath: string; projectName: string; agents: DurableAgentConfig[] }> | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ switched: number; failed: Array<{ key: string; name: string; message: string }> } | null>(null);

  useEffect(() => { void loadClubhouse(); }, [loadClubhouse]);

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

  // As the store's isEnabledForProject decides it, read here so the list follows a change.
  const clubhouseOn = (projectPath: string) => clubhouseOverrides[projectPath] ?? clubhouseEnabled;
  const candidates: Candidate[] = (configs ?? []).flatMap((p) => p.agents
    .filter((a) => !a.managed && !isDisposedAgent(a) && !a.creation && !a.parentAgentId)
    .map((agent) => ({
      key: keyOf(p.projectPath, agent.id),
      projectPath: p.projectPath,
      projectName: p.projectName,
      agent,
      legacy: legacyUse(agent, clubhouseOn(p.projectPath)),
    })));
  const statusOf = (c: Candidate) => statuses[c.agent.id]?.status;
  const isRunning = (c: Candidate) => statusOf(c) === 'running';
  const isStarting = (c: Candidate) => {
    const status = statusOf(c);
    return status === 'waking' || status === 'spawning' || status === 'creating';
  };
  const canSwitch = (c: Candidate) => !!c.agent.worktreePath && !isStarting(c);
  const isTicked = (c: Candidate) => canSwitch(c) && (ticks[c.key] ?? (!!c.legacy && !isRunning(c)));
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
      description="Agents that Clubhouse doesn't manage yet. Switching keeps what each one has now: its instructions file becomes a block for that agent only, and its skills and MCP servers become parts. A running agent gets the change at its next start."
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
                  {c.agent.worktreePath && isRunning(c) && <span className="block text-xs text-ctp-overlay1" data-testid="managed-switch-running">Running: the switch applies at its next start.</span>}
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
