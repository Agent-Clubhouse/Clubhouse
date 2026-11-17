import { useEffect, useState } from 'react';
import { ConfirmDestructiveAction } from '../../components/ConfirmDestructiveAction';
import { useAgentStore } from '../../stores/agentStore';
import { isRemoteProjectId } from '../../stores/remoteProjectStore';

/** Passive reads may show backup records, but only this deliberate action restores them. */
export function AgentConfigRecoveryNotice({ projectId, projectPath }: { projectId: string; projectPath: string }) {
  const [info, setInfo] = useState<{ backupAgents: unknown[]; recoveryRequired?: boolean } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (isRemoteProjectId(projectId)) return;
    let active = true;
    setInfo(null); setError('');
    Promise.resolve(window.clubhouse.agent.getBackupInfo(projectPath)).then((value) => {
      if (active) setInfo(value);
    }).catch(() => { if (active) setError('Cannot verify saved agent settings. Repair .clubhouse/agents.json before starting an agent.'); });
    return () => { active = false; };
  }, [projectId, projectPath]);
  if (isRemoteProjectId(projectId) || (!info?.recoveryRequired && !error)) return null;
  const restore = async () => {
    setConfirm(false); setBusy(true); setError('');
    try {
      await window.clubhouse.agent.restoreFromBackup(projectPath);
      setInfo(null);
      await useAgentStore.getState().loadDurableAgents(projectId, projectPath);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  return <div role="alert" className="m-3 p-3 rounded border border-ctp-yellow/40 text-xs text-ctp-yellow" data-testid="agent-config-recovery">
    <p>Can’t verify saved agent settings. The available records are shown without changing the saved file. Restore the saved backup before starting an agent, or repair .clubhouse/agents.json.</p>
    {info && info.backupAgents.length > 0 && <button type="button" className="mt-2 underline cursor-pointer" disabled={busy} onClick={() => setConfirm(true)}>Restore saved backup</button>}
    {info && info.backupAgents.length === 0 && <p>No valid backup is available.</p>}
    {error && <p>{error}</p>}
    <ConfirmDestructiveAction open={confirm} title="Restore saved backup?" description="Replace this project’s unreadable agent settings with the saved backup. The backup may contain older Access, sandbox, approval and connection settings. Review those settings before waking an agent." confirmLabel="Restore saved backup" onCancel={() => setConfirm(false)} onConfirm={() => { void restore(); }} />
  </div>;
}
