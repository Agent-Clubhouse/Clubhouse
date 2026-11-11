import { useCallback, useEffect, useState } from 'react';
import type { ActionOwnerUsage as OwnerUsage } from '../../../shared/actions';
import { Button } from '../../components/Button';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { settingsError, settingsHelp } from '../settings/SettingsLayout';
import { ownerLabel, useActionNames } from './useActions';

export function ActionOwnerUsage({ onOpen }: { onOpen: (id: string) => void }) {
  const { names } = useActionNames();
  const [groups, setGroups] = useState<OwnerUsage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    window.clubhouse.actions.usage().then((usage) => { setGroups(usage); setError(null); }).catch((err: unknown) => {
      // telemetry-exempt: shown with a retry control.
      setError(ipcErrorMessage(err));
    });
  }, []);
  useEffect(() => {
    reload();
    const off = window.clubhouse.actions.onChanged(reload);
    const timer = setInterval(reload, 60_000);
    return () => { off(); clearInterval(timer); };
  }, [reload]);
  return (
    <div data-testid="actions-owner-usage">
      <h3 className="text-[13px] text-ctp-text font-medium mt-3">Recent runs by owner</h3>
      <p className={`${settingsHelp} mt-1`}>
        Counts come from retained history, including skipped and cancelled runs. Each action keeps at most 10 runs within 72 hours, so the last 7 days is not a full total.
      </p>
      {groups === null && !error && <p className={`${settingsHelp} mt-3`}>Loading recent runs.</p>}
      {groups?.length === 0 && <p className={`${settingsHelp} mt-3`}>No actions or recent runs.</p>}
      <ul className="mt-3">
        {groups?.map((group) => {
          const owner = group.owner;
          const key = owner?.kind === 'agent' ? owner.agentId : owner?.kind ?? 'unknown';
          const label = !owner ? 'Unknown owner' : owner.kind === 'agent' ? names.agent(owner.agentId) ?? `Agent ${owner.agentId}` : ownerLabel(owner, names);
          return (
            <li key={key} className="py-3 border-t border-surface-0" data-testid="actions-owner">
              <h4 className="text-[13px] text-ctp-text font-medium">{label}</h4>
              <div className="text-xs text-ctp-subtext0 mt-1">Last 24 hours: {group.runs24h} recent {group.runs24h === 1 ? 'run' : 'runs'}, {group.failures24h} {group.failures24h === 1 ? 'failure' : 'failures'}.</div>
              <div className="text-xs text-ctp-subtext0">Last 7 days: {group.runs7d} recent {group.runs7d === 1 ? 'run' : 'runs'}, {group.failures7d} {group.failures7d === 1 ? 'failure' : 'failures'}.</div>
              {group.actions.length === 0 ? <p className={`${settingsHelp} mt-1`}>No saved actions.</p> : (
                <ul className="mt-1">
                  {group.actions.map((action) => (
                    <li key={action.id}>
                      <button type="button" className="text-xs text-ctp-text hover:underline cursor-pointer" onClick={() => onOpen(action.id)}>{action.name}</button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {error && <div className="mt-3"><div role="alert" className={settingsError}>{error}</div><Button kind="ghost" onClick={reload}>Try again</Button></div>}
    </div>
  );
}
