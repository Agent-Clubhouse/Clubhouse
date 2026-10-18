import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button } from '../../components/Button';
import { Tooltip } from '../../components/Tooltip';
import { reportChromeActionFailed } from '../../chrome/telemetry';
import { useToastStore } from '../../stores/toastStore';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { NARROW_PANE_PX } from '../agents/pane/useNarrow';
import { wakeDurableAgent } from '../agents/wake-durable-agent';

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

export function PopoutAgentActions({ agentId, projectId }: { agentId: string; projectId?: string }) {
  const agent = useAgentStore((s) => s.agents[agentId]);
  const projects = useProjectStore((s) => s.projects);
  const narrow = useWindowNarrow();

  const handleKill = useCallback(async () => {
    try {
      if (projectId) await window.clubhouse.agent.killAgent(agentId, projectId);
      else await window.clubhouse.pty.kill(agentId);
    } catch (err) {
      useToastStore.getState().addToast(`Couldn't stop the agent: ${err instanceof Error ? err.message : String(err)}`, 'error');
      reportChromeActionFailed('agent_stop', err);
    }
  }, [agentId, projectId]);

  const handleWake = useCallback(async () => {
    if (!agent || agent.kind !== 'durable') return;
    try {
      const agentProject = projects.find((p) => p.id === agent.projectId);
      if (!agentProject) throw new Error('Project not found');
      // Resumes the last session when there is one, like every other Wake.
      await wakeDurableAgent(agentProject.id, agentProject.path, agent.id, 'resume');
    } catch (err) {
      useToastStore.getState().addToast(`Couldn't wake the agent: ${err instanceof Error ? err.message : String(err)}`, 'error');
      reportChromeActionFailed('agent_wake', err);
    }
  }, [agent, projects]);

  const handleView = useCallback(() => {
    window.clubhouse.window.focusMain(agentId);
  }, [agentId]);

  if (!agent) return null;
  const isRunning = agent.status === 'running' || agent.status === 'creating';
  const action = (testId: string, label: string, kind: 'quiet' | 'danger', icon: ReactNode, onClick: () => void, text = label) => (
    <Tooltip content={label} disabled={!narrow}>
      <Button
        kind={kind}
        icon={icon}
        onClick={onClick}
        aria-label={narrow ? label : undefined}
        className={`no-drag ${narrow && kind === 'danger' ? 'border-transparent' : ''}`}
        data-testid={testId}
      >
        {narrow ? undefined : text}
      </Button>
    </Tooltip>
  );

  return (
    <span className="no-drag flex items-center gap-1 flex-shrink-0" data-testid="popout-actions">
      {action('popout-view-button', 'Show in main window', 'quiet', <ShowIcon />, handleView)}
      {isRunning && action('popout-stop-button', 'Stop agent', 'danger', <StopGlyph />, () => { void handleKill(); }, 'Stop')}
      {!isRunning && agent.kind === 'durable' && action('popout-wake-button', 'Wake agent', 'quiet', <WakeGlyph />, () => { void handleWake(); }, 'Wake')}
    </span>
  );
}
