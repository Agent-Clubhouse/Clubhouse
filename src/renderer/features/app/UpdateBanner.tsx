import { useState, useEffect, useCallback, useRef } from 'react';
import { useUpdateStore } from '../../stores/updateStore';
import { useAgentStore } from '../../stores/agentStore';
import { UpdateGateModal, UpdateGateAgent } from './UpdateGateModal';
import type { LiveAgentInfo } from '../../../shared/types';
import { NoticeCard } from '../../components/NoticeCard';
import { Button } from '../../components/Button';

// Literal class strings so Tailwind can see every variant it needs to generate.
const TONES = {
  warning: {
    bar: 'bg-ctp-peach/10 border-ctp-peach/20 text-ctp-peach',
    muted: 'text-ctp-peach/60',
    primary: 'bg-ctp-peach/20 hover:bg-ctp-peach/30',
    secondary: 'text-ctp-peach/50 hover:text-ctp-peach',
  },
  info: {
    bar: 'bg-ctp-info/10 border-ctp-info/20 text-ctp-info',
    muted: 'text-ctp-info/60',
    primary: 'bg-ctp-info/20 hover:bg-ctp-info/30',
    secondary: 'text-ctp-info/50 hover:text-ctp-info',
  },
} as const;

/**
 * `bar` is the classic full-width strip; `card` is the new chrome's notice
 * card above the sidebar footer (#2014).
 */
export function UpdateBanner({ variant = 'bar' }: { variant?: 'bar' | 'card' } = {}) {
  const status = useUpdateStore((s) => s.status);
  const dismissed = useUpdateStore((s) => s.dismissed);
  const dismiss = useUpdateStore((s) => s.dismiss);
  const openUpdateDownload = useUpdateStore((s) => s.openUpdateDownload);
  const agents = useAgentStore((s) => s.agents);
  const [showGate, setShowGate] = useState(false);
  const [simulateMode, setSimulateMode] = useState(false);
  const [gateAgents, setGateAgents] = useState<UpdateGateAgent[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const isReady = status.state === 'ready';
  const isApplyError = status.state === 'error' && !!status.artifactUrl;
  const shouldShow = (isReady || isApplyError) && !dismissed;

  const hasFailedBefore = isReady && status.applyAttempted;
  const useWarningStyle = isApplyError || hasFailedBefore;

  const runningAgents = Object.values(agents).filter((a) => a.status === 'running');
  const hasRunningAgents = runningAgents.length > 0;

  const refreshGateAgents = useCallback(async () => {
    try {
      const live = await window.clubhouse.app.getLiveAgentsForUpdate();
      setGateAgents(
        // resumeStrategy comes from the main process, which derives it from the
        // provider's session capability — the same source the capture path uses.
        live.map((a: LiveAgentInfo) => ({
          ...a,
          agentName: agents[a.agentId]?.name || a.agentId,
        })),
      );
    } catch { /* ignore */ }
  }, [agents]);

  useEffect(() => {
    if (showGate) {
      refreshGateAgents();
      pollRef.current = setInterval(refreshGateAgents, 2000);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [showGate, refreshGateAgents]);

  // Dev-only: listen for Debug > Simulate Update Restart menu
  useEffect(() => {
    if (!window.clubhouse.app.onDevSimulateUpdateRestart) return;
    return window.clubhouse.app.onDevSimulateUpdateRestart(() => {
      const running = Object.values(useAgentStore.getState().agents).filter((a) => a.status === 'running');
      if (running.length > 0) {
        setSimulateMode(true);
        setShowGate(true);
      } else {
        // No agents — go straight to capture + relaunch
        window.clubhouse.app.devSimulateUpdateRestart({ agentNames: {} });
      }
    });
  }, []);

  const handleRestart = () => {
    if (hasRunningAgents) {
      setShowGate(true);
      return;
    }
    // No agents — go straight to restart with session capture
    window.clubhouse.app.confirmUpdateRestart({ agentNames: {} });
  };

  const handleGateConfirm = async () => {
    const agentNames: Record<string, string> = {};
    const agentMeta: Record<string, { kind: string; mission?: string; model?: string; worktreePath?: string }> = {};
    for (const a of gateAgents) {
      agentNames[a.agentId] = a.agentName;
      const storeAgent = agents[a.agentId];
      if (storeAgent) {
        agentMeta[a.agentId] = {
          kind: storeAgent.kind || 'durable',
          mission: storeAgent.mission,
          model: storeAgent.model,
          worktreePath: storeAgent.worktreePath,
        };
      }
    }
    setShowGate(false);
    if (simulateMode) {
      setSimulateMode(false);
      await window.clubhouse.app.devSimulateUpdateRestart({ agentNames, agentMeta });
    } else {
      await window.clubhouse.app.confirmUpdateRestart({ agentNames, agentMeta });
    }
  };

  const handleGateResolve = async (agentId: string, action: 'wait' | 'interrupt' | 'kill') => {
    if (action === 'wait') return;
    await window.clubhouse.app.resolveWorkingAgent(agentId, action);
    if (action === 'kill') {
      setGateAgents((prev) => prev.filter((a) => a.agentId !== agentId));
    }
    setTimeout(refreshGateAgents, 1000);
  };

  // When in simulate mode, render only the gate modal (no banner needed)
  if (!shouldShow) {
    return showGate ? (
      <UpdateGateModal
        agents={gateAgents}
        onCancel={() => { setShowGate(false); setSimulateMode(false); }}
        onConfirm={handleGateConfirm}
        onResolveAgent={handleGateResolve}
      />
    ) : null;
  }

  const gate = showGate && (
    <UpdateGateModal
      agents={gateAgents}
      onCancel={() => setShowGate(false)}
      onConfirm={handleGateConfirm}
      onResolveAgent={handleGateResolve}
    />
  );

  if (variant === 'card') {
    const version = status.availableVersion ? `v${status.availableVersion}` : undefined;
    const later = <Button kind="quiet" onClick={dismiss} data-testid="update-dismiss-btn">Later</Button>;
    const download = (kind: 'primary' | 'ghost') => (
      <Button kind={kind} onClick={openUpdateDownload} data-testid="update-manual-download-btn">Download manually</Button>
    );
    return (
      <>
        {isApplyError ? (
          <NoticeCard tone="error" title="Update failed" meta={version} testId="update-banner"
            actions={<>{download('primary')}{later}</>}>
            <span data-testid="update-error-message">{status.error || 'It could not be installed.'}</span>
          </NoticeCard>
        ) : hasFailedBefore ? (
          <NoticeCard tone="warning" title="Update did not apply" meta={version} testId="update-banner"
            actions={<>
              <Button kind="primary" onClick={handleRestart} data-testid="update-restart-btn">Try again</Button>
              {status.artifactUrl && download('ghost')}
              {later}
            </>}>
            <span data-testid="update-retry-message">Restart to try installing it again.</span>
          </NoticeCard>
        ) : (
          <NoticeCard tone="success" title="Update ready" meta={version} testId="update-banner"
            actions={<>
              <Button kind="primary" onClick={handleRestart} data-testid="update-restart-btn">Restart</Button>
              {status.artifactUrl && download('ghost')}
              {later}
            </>}>
            {status.releaseMessage
              ? <span data-testid="update-release-message">{status.releaseMessage}</span>
              : 'Restart to finish installing. Running agents resume.'}
          </NoticeCard>
        )}
        {gate}
      </>
    );
  }

  const tone = TONES[useWarningStyle ? 'warning' : 'info'];

  return (
    <>
      <div
        className={`flex-shrink-0 flex items-center gap-3 px-4 py-2 border-b ${tone.bar} text-sm`}
        data-testid="update-banner"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>

        {isApplyError ? (
          <span className="flex-1" data-testid="update-error-message">
            Update{status.availableVersion ? ` v${status.availableVersion}` : ''} failed to install
            {status.error ? <span className="opacity-60 ml-1">&mdash; {status.error}</span> : ''}
          </span>
        ) : hasFailedBefore ? (
          <span className="flex-1" data-testid="update-retry-message">
            Update v{status.availableVersion} did not apply successfully
          </span>
        ) : (
          <span className="flex-1">
            Update v{status.availableVersion} is ready
            {status.releaseMessage ? (
              <span className={`${tone.muted} ml-1`} data-testid="update-release-message">&mdash; {status.releaseMessage}</span>
            ) : '.'}
          </span>
        )}

        {isApplyError ? (
          <>
            <button onClick={openUpdateDownload} className={`px-3 py-1 text-xs rounded ${tone.primary} transition-colors cursor-pointer`} data-testid="update-manual-download-btn">Download manually</button>
            <button onClick={dismiss} className={`${tone.secondary} transition-colors cursor-pointer px-1`} data-testid="update-dismiss-btn">x</button>
          </>
        ) : hasFailedBefore ? (
          <>
            {status.artifactUrl && (
              <button onClick={openUpdateDownload} className={`px-3 py-1 text-xs rounded ${tone.primary} transition-colors cursor-pointer`} data-testid="update-manual-download-btn">Download manually</button>
            )}
            <button onClick={handleRestart} className={`${tone.secondary} transition-colors cursor-pointer px-2 text-xs`} data-testid="update-restart-btn">Try again</button>
            <button onClick={dismiss} className={`${tone.secondary} transition-colors cursor-pointer px-1`} data-testid="update-dismiss-btn">x</button>
          </>
        ) : (
          <>
            <button onClick={handleRestart} className={`px-3 py-1 text-xs rounded ${tone.primary} transition-colors cursor-pointer`} data-testid="update-restart-btn">Restart to update</button>
            {status.artifactUrl && (
              <button onClick={openUpdateDownload} className={`${tone.secondary} transition-colors cursor-pointer px-2 text-xs`} data-testid="update-manual-download-btn">Download manually</button>
            )}
            <button onClick={dismiss} className={`${tone.secondary} transition-colors cursor-pointer px-1`} data-testid="update-dismiss-btn">x</button>
          </>
        )}
      </div>

      {gate}
    </>
  );
}
