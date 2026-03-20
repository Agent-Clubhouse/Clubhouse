import { useState, useEffect, useCallback, useRef } from 'react';
import { useUpdateStore } from '../../stores/updateStore';
import { useAgentStore } from '../../stores/agentStore';
import { UpdateGateModal, UpdateGateAgent } from './UpdateGateModal';

export function UpdateBanner() {
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
        live.map((a: { agentId: string; projectPath: string; orchestrator: string; isWorking: boolean }) => ({
          ...a,
          agentName: agents[a.agentId]?.name || a.agentId,
          resumeStrategy: (a.orchestrator === 'claude-code' ? 'auto' : 'manual') as 'auto' | 'manual',
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

  const colorBase = useWarningStyle ? 'ctp-peach' : 'ctp-info';

  return (
    <>
      <div
        className={`flex-shrink-0 flex items-center gap-3 px-4 py-2 bg-${colorBase}/10 border-b border-${colorBase}/20 text-${colorBase} text-sm`}
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
              <span className={`text-${colorBase}/60 ml-1`} data-testid="update-release-message">&mdash; {status.releaseMessage}</span>
            ) : '.'}
          </span>
        )}

        {isApplyError ? (
          <>
            <button onClick={openUpdateDownload} className={`px-3 py-1 text-xs rounded bg-${colorBase}/20 hover:bg-${colorBase}/30 transition-colors cursor-pointer`} data-testid="update-manual-download-btn">Download manually</button>
            <button onClick={dismiss} className={`text-${colorBase}/50 hover:text-${colorBase} transition-colors cursor-pointer px-1`} data-testid="update-dismiss-btn">x</button>
          </>
        ) : hasFailedBefore ? (
          <>
            {status.artifactUrl && (
              <button onClick={openUpdateDownload} className={`px-3 py-1 text-xs rounded bg-${colorBase}/20 hover:bg-${colorBase}/30 transition-colors cursor-pointer`} data-testid="update-manual-download-btn">Download manually</button>
            )}
            <button onClick={handleRestart} className={`text-${colorBase}/50 hover:text-${colorBase} transition-colors cursor-pointer px-2 text-xs`} data-testid="update-restart-btn">Try again</button>
            <button onClick={dismiss} className={`text-${colorBase}/50 hover:text-${colorBase} transition-colors cursor-pointer px-1`} data-testid="update-dismiss-btn">x</button>
          </>
        ) : (
          <>
            <button onClick={handleRestart} className={`px-3 py-1 text-xs rounded bg-${colorBase}/20 hover:bg-${colorBase}/30 transition-colors cursor-pointer`} data-testid="update-restart-btn">Restart to update</button>
            {status.artifactUrl && (
              <button onClick={openUpdateDownload} className={`text-${colorBase}/50 hover:text-${colorBase} transition-colors cursor-pointer px-2 text-xs`} data-testid="update-manual-download-btn">Download manually</button>
            )}
            <button onClick={dismiss} className={`text-${colorBase}/50 hover:text-${colorBase} transition-colors cursor-pointer px-1`} data-testid="update-dismiss-btn">x</button>
          </>
        )}
      </div>

      {showGate && (
        <UpdateGateModal
          agents={gateAgents}
          onCancel={() => setShowGate(false)}
          onConfirm={handleGateConfirm}
          onResolveAgent={handleGateResolve}
        />
      )}
    </>
  );
}
