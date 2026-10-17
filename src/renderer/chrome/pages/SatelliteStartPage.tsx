import { useMemo } from 'react';
import type { Agent } from '../../../shared/types';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { useRemoteProjectStore } from '../../stores/remoteProjectStore';
import { useUIStore } from '../../stores/uiStore';
import { Button } from '../../components/Button';
import { ProjectSquare } from '../sidebar/ProjectGroup';
import { agentDot } from '../sidebar/treeModel';
import { openStartPage } from '../startPage';
import { switchHost } from '../hosts';
import { reportChromeFeature } from '../telemetry';

/**
 * The pane with a satellite as the host and no project selected (#2024), in the
 * first-run pattern: the satellite's name, its connection in one line, then its
 * projects as 30px rows with plain-text counts. Agents stay in the sidebar.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function stateLine(state: string | undefined): string {
  if (state === 'connected') return 'Connected';
  if (state === 'connecting' || state === 'discovering') return 'Connecting';
  return 'Offline';
}

/** "1 needs you, 1 working", or how many agents there are when none is busy. */
export function projectCounts(agents: Agent[], dots: (a: Agent) => ReturnType<typeof agentDot>): string {
  let needs = 0;
  let working = 0;
  for (const a of agents) {
    const d = dots(a);
    if (d === 'needs' || d === 'error') needs++;
    else if (d === 'working') working++;
  }
  const parts = [needs > 0 ? `${needs} needs you` : '', working > 0 ? `${working} working` : ''].filter(Boolean);
  if (parts.length > 0) return parts.join(', ');
  return agents.length > 0 ? plural(agents.length, 'agent') : 'No agents';
}

const ChevronRight = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
);

export function SatelliteStartPage({ activeHostId }: { activeHostId: string }) {
  const satellite = useAnnexClientStore((s) => s.satellites.find((sat) => sat.id === activeHostId));
  const projects = useRemoteProjectStore((s) => s.satelliteProjects[activeHostId]);
  const remoteAgents = useRemoteProjectStore((s) => s.remoteAgents);
  const detailed = useRemoteProjectStore((s) => s.remoteAgentDetailedStatus);
  const icons = useRemoteProjectStore((s) => s.remoteProjectIcons);
  const list = useMemo(() => projects ?? [], [projects]);
  const name = satellite?.alias || 'Satellite';
  const connected = satellite?.state === 'connected';

  const agentsByProject = useMemo(() => {
    const ids = new Set(list.map((p) => p.id));
    const map: Record<string, Agent[]> = {};
    for (const a of Object.values(remoteAgents)) {
      if (ids.has(a.projectId) && a.kind !== 'companion') (map[a.projectId] ??= []).push(a);
    }
    return map;
  }, [list, remoteAgents]);
  const agentCount = Object.values(agentsByProject).reduce((n, l) => n + l.length, 0);

  const summary = [
    stateLine(satellite?.state),
    satellite?.host,
    connected ? (list.length > 0 ? `${plural(list.length, 'project')}, ${plural(agentCount, 'agent')}` : 'no projects open') : '',
  ].filter(Boolean).join(' · ');

  const openAnnexSettings = () => {
    const ui = useUIStore.getState();
    ui.setSettingsContext('app');
    ui.setSettingsSubPage('annex');
    if (ui.explorerTab !== 'settings') ui.toggleSettings();
    reportChromeFeature('host_settings_open');
  };

  return (
    <div data-testid="satellite-start-page" className="h-full overflow-y-auto bg-ctp-base flex justify-center">
      <div className="w-[480px] max-w-full px-6 pt-32 pb-10 flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${connected ? 'bg-ctp-success' : 'border border-ctp-overlay0'}`} aria-hidden="true" />
          <h1 className="text-lg font-semibold text-ctp-text truncate">{name}</h1>
        </div>
        <p className="text-[12.5px] text-ctp-overlay1">{summary}</p>

        {list.length === 0 ? (
          <>
            <p className="mt-[18px] text-[13px] leading-normal text-ctp-subtext1">
              {connected
                ? `Nothing is open on ${name} yet. Open a project in Clubhouse on that machine and it shows up here.`
                : `${name} isn't reachable right now. Its projects show up here when it reconnects.`}
            </p>
            <div className="mt-3 flex gap-1.5">
              <Button kind="ghost" onClick={() => { switchHost(null); reportChromeFeature('host_switch'); }} className="focus-ring">
                Switch to Local
              </Button>
              <Button kind="quiet" onClick={openAnnexSettings} className="focus-ring">Annex settings</Button>
            </div>
          </>
        ) : (
          <>
            <p className="mt-[18px] text-[13px] text-ctp-subtext1">Pick a project to see its agents.</p>
            <ul aria-label={`Projects on ${name}`} className="mt-1.5 pt-1.5 border-t border-surface-0 flex flex-col">
              {list.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    data-testid={`satellite-project-${p.id}`}
                    onClick={() => { openStartPage(p.id); reportChromeFeature('project_select'); }}
                    className="w-full h-[30px] px-2 rounded-md flex items-center gap-2 text-[13px] text-left text-ctp-text hover:bg-surface-0 cursor-pointer focus-ring"
                  >
                    <ProjectSquare project={p} iconUrl={icons[p.id]} />
                    <span className="font-medium truncate">{p.displayName || p.name}</span>
                    <span className="text-xs text-ctp-overlay1 truncate">
                      {projectCounts(agentsByProject[p.id] ?? [], (a) => agentDot(a, detailed[a.id]))}
                    </span>
                    <span className="ml-auto flex-shrink-0 text-ctp-overlay1">{ChevronRight}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
