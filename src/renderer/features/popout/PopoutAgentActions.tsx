import { useCallback, useEffect, useState } from 'react';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { NARROW_PANE_PX } from '../agents/pane/useNarrow';

/**
 * Show in main window and Stop (Wake while sleeping) on the right of a popout
 * agent's title bar (#2018). They used to sit in a bar of their own that
 * repeated the agent's name and, over a terminal, covered its Bottom button.
 * Below 640px wide they are icons with tooltips.
 */

function useWindowNarrow(px = NARROW_PANE_PX): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth > 0 && window.innerWidth < px);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth > 0 && window.innerWidth < px);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [px]);
  return narrow;
}

const ShowIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6M10 14L21 3" />
  </svg>
);
const StopGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" /></svg>
);
const WakeGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
);

const BTN = 'no-drag h-7 rounded-md flex items-center justify-center gap-1.5 text-xs';

export function PopoutAgentActions({ agentId, projectId }: { agentId: string; projectId?: string }) {
  const agent = useAgentStore((s) => s.agents[agentId]);
  const spawnDurableAgent = useAgentStore((s) => s.spawnDurableAgent);
  const projects = useProjectStore((s) => s.projects);
  const narrow = useWindowNarrow();

  const handleKill = useCallback(async () => {
    if (projectId) await window.clubhouse.agent.killAgent(agentId, projectId);
    else await window.clubhouse.pty.kill(agentId);
  }, [agentId, projectId]);

  const handleWake = useCallback(async () => {
    if (!agent || agent.kind !== 'durable') return;
    const agentProject = projects.find((p) => p.id === agent.projectId);
    if (!agentProject) return;
    const configs = await window.clubhouse.agent.listDurable(agentProject.path);
    const config = configs.find((c: { id: string }) => c.id === agent.id);
    if (config) await spawnDurableAgent(agentProject.id, agentProject.path, config, false);
  }, [agent, projects, spawnDurableAgent]);

  const handleView = useCallback(() => {
    window.clubhouse.window.focusMain(agentId);
  }, [agentId]);

  if (!agent) return null;
  const isRunning = agent.status === 'running' || agent.status === 'creating';
  const label = (text: string) => (narrow ? { 'aria-label': text, title: text } : {});

  return (
    <span className="flex items-center gap-0.5 flex-shrink-0" data-testid="popout-actions">
      <button
        type="button"
        onClick={handleView}
        {...label('Show in main window')}
        className={`${BTN} text-ctp-overlay1 hover:bg-surface-0 hover:text-ctp-text ${narrow ? 'w-7' : 'px-2'}`}
        data-testid="popout-view-button"
      >
        <ShowIcon />
        {!narrow && 'Show in main window'}
      </button>
      {isRunning && (
        <button
          type="button"
          onClick={handleKill}
          {...label('Stop agent')}
          className={`${BTN} text-ctp-error hover:bg-surface-0 ${narrow ? 'w-7' : 'px-2.5 border border-surface-1'}`}
          data-testid="popout-stop-button"
        >
          <StopGlyph />
          {!narrow && 'Stop'}
        </button>
      )}
      {!isRunning && agent.kind === 'durable' && (
        <button
          type="button"
          onClick={handleWake}
          {...label('Wake agent')}
          className={`${BTN} text-ctp-overlay1 hover:bg-surface-0 hover:text-ctp-text ${narrow ? 'w-7' : 'px-2'}`}
          data-testid="popout-wake-button"
        >
          <WakeGlyph />
          {!narrow && 'Wake'}
        </button>
      )}
    </span>
  );
}
